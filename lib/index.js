/**
 * dsh-power — host half.
 *
 * Routes:
 *   GET  /api/dsh-power/info   -> { ok, pid, port, command } of the live process
 *   POST /api/dsh-power/action -> { action: 'restart' | 'shutdown' }
 *
 * ## Why the restart is not "kill and hope"
 *
 * The relaunch command is captured HERE, while this process is still alive:
 * `process.execPath`, `process.execArgv`, `process.argv`, `process.cwd()`.
 * Nothing is reconstructed from a dying process (no `ps`, no `PATH` lookup, no
 * guessing) — that guess is how a restart ends up with a service that cannot
 * come back.
 *
 * The detached worker (`lib/restart.cjs`) then treats the **port** as the
 * source of truth rather than one pid: it stops whoever holds the listening
 * socket, waits for the socket to actually be free, starts the service, and
 * verifies it is listening, retrying when it is not. Killing a recorded pid is
 * not enough — a half-finished earlier attempt or an older instance can own the
 * port while that pid is long gone, and then every new instance dies on
 * EADDRINUSE while the UI can only report "the port is occupied".
 *
 * The worker is started with `set -m` on POSIX so it lands in its own process
 * group and survives DSH's exit cleanup, which signals the whole group of its
 * children.
 *
 * ## Windows
 *
 * Three platform differences are load-bearing, and each one is commented where
 * it is handled:
 *
 *   - the worker is **not** started through the harness's subprocess service on
 *     Windows. Everything that service starts there lives in a Win32 Job Object
 *     with KILL_ON_JOB_CLOSE, so the worker would be terminated along with the
 *     service it is restarting. A detached `child_process.spawn` is outside it.
 *   - Windows has no signals: the worker can only terminate the process. So the
 *     host half also asks the harness to shut itself down gracefully
 *     (`ctx.appExit`) once the browser has its answer, which is what disposes
 *     the tree and stops the child processes DSH manages.
 *   - `HOME` is a POSIX habit; the home directory falls back to `USERPROFILE`
 *     and `os.homedir()`.
 *
 * @module dsh-power
 */

import { execFile, spawn } from 'node:child_process'
import { appendFileSync, closeSync, openSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const INFO_PATH = '/api/dsh-power/info'
const ACTION_PATH = '/api/dsh-power/action'
const REPORT_PATH = '/api/dsh-power/report'
const LOG_NAME = 'dsh-web.log'
const WORKER = fileURLToPath(new URL('./restart.cjs', import.meta.url))
const IS_WINDOWS = process.platform === 'win32'

/**
 * Node flags the relaunch must not replay. The inspector family is the one kind
 * of node flag that must not come back with the service: `--inspect-brk` makes
 * the new process wait for a debugger before it binds anything, so a faithful
 * restart would look exactly like a service that failed to come back.
 */
const DEBUGGER_FLAG = /^--(inspect|debug)(-|=|$)/

/**
 * @param args - node's own flags, from `process.execArgv`.
 * @returns the flags worth replaying on the relaunch.
 */
export const withoutDebugger = (args) => args.filter((arg) => !DEBUGGER_FLAG.test(arg))

/**
 * The user's home directory, as each platform spells it.
 *
 * `HOME` is a POSIX habit: a Windows service started from a shortcut or a
 * scheduled task has only `USERPROFILE`, and a literal `~` in `DSH_HOME` has to
 * be expanded against something. On Windows `HOME` is also a trap — a shell
 * like Git Bash exports it as `/c/Users/me`, which a native process would
 * resolve to `C:\c\Users\me` — so the native variable wins there.
 *
 * @returns an absolute home directory.
 */
function homeDirectory() {
  const names = process.platform === 'win32' ? ['USERPROFILE', 'HOME'] : ['HOME', 'USERPROFILE']
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return homedir()
}

/**
 * Absolute DSH home. The environment may carry a literal `~` (DSH itself
 * defaults it that way), which is not a path any child can open — the worker
 * would then fail to create its log and, worse, hand the replacement process a
 * platform home instead of the isolated one.
 *
 * @returns {string} an absolute home directory.
 */
function dshHomeOf() {
  const raw = process.env.DSH_HOME
  const home = homeDirectory()
  if (raw === undefined || raw === '') return resolve(home, '.dsh')
  return resolve(raw.startsWith('~') ? home + raw.slice(1) : raw)
}

/** Quote one value as a single-quoted POSIX shell word. */
const shQuote = (value) => "'" + String(value).split("'").join("'\\''") + "'"

/**
 * Relaunch arguments, with the browser opener disabled.
 *
 * `dsh web` opens a tab in the default browser unless `--no-open` is passed, so
 * restarting with the original argv verbatim would spawn one more tab per
 * restart. Those tabs are not harmless: each one was authenticated against the
 * process that opened it, so the older ones sit on a dead connection showing
 * "reconnect", and restarting twice leaves the user staring at several of them.
 * The page the user already has reloads itself after a restart, so there is
 * nothing to open.
 *
 * @param args - the argv captured from the running process.
 * @returns args that will not open a browser.
 */
const withoutBrowserOpen = (args) => (args.includes('--no-open') ? args : args.concat('--no-open'))

/**
 * The listening port of the request that reached us, taken from the Host
 * header, so a service started on a non-default port restarts on that port
 * instead of assuming 3080.
 *
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns {number | undefined} a plausible port, or undefined.
 */
function portOf(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return undefined
  const match = /:(\d+)$/.exec(host)
  const port = match === null ? 80 : Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

/**
 * The hostname of the request's Host header. The worker uses it for its own TCP
 * check: a port alone does not say which interface answers, and a service
 * started with `--host` may not be reachable on loopback.
 *
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @returns {string | undefined} a hostname, or undefined.
 */
function hostOf(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return undefined
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? undefined : host.slice(1, end)
  }
  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

export const inject = ['webServer']

/**
 * Register the two routes for this plugin's lifetime.
 * @param {object} ctx - the plugin context; `webServer` is a declared dependency.
 */
export function apply(ctx) {
  const subprocess = ctx.get('subprocess')

  /** Everything the worker needs, captured while this process is healthy. */
  const home = dshHomeOf()
  const logPath = join(home, LOG_NAME)
  const launch = {
    nodeBin: process.execPath,
    nodeArgs: withoutDebugger(process.execArgv),
    dshBin: process.argv[1],
    args: process.argv.slice(2),
    cwd: process.cwd(),
    dshHome: home,
  }

  const spawnDetached = (argv, stdio, graceMs) => {
    const handle = subprocess.spawn({ argv, cwd: '/', stdio, graceMs })
    handle.done.then(() => undefined, () => undefined)
    return handle
  }

  /**
   * What this process can say about itself.
   *
   * `process.pid` is the pid the worker must stop: this module is loaded by the
   * process that serves these routes, so that process is the one holding the
   * port. Reading it from a child shell's `$PPID` — what earlier versions did —
   * reported a *parent* pid, which on Linux is a systemd scope rather than DSH.
   *
   * @returns the pid, plus a command line built from the parts node exposes.
   */
  const selfFacts = () => ({
    pid: String(process.pid),
    command: [process.execPath]
      .concat(process.execArgv, process.argv[1] === undefined ? [] : [process.argv[1]], process.argv.slice(2))
      .join(' '),
  })

  /**
   * The command line the operating system reports for this pid, or undefined.
   *
   * Display only: it is what the user actually typed, including node flags that
   * `process` does not expose. Windows has no `ps`, and asking its own
   * equivalent (CIM) through PowerShell for a string this process already knows
   * would cost a process launch on every page load, so the self-reported
   * command line is used there.
   *
   * @returns the command line, or undefined when it cannot be read.
   */
  const osCommandLine = async () => {
    if (IS_WINDOWS) return undefined
    try {
      const { stdout } = await run('ps', ['-p', String(process.pid), '-o', 'command='], { timeout: 5000, maxBuffer: 65536 })
      const text = String(stdout).trim()
      return text === '' ? undefined : text
    } catch (error) {
      // A sandbox may refuse `ps`; the pid is known regardless, so the row works.
      return undefined
    }
  }

  const probe = async () => {
    const facts = selfFacts()
    const reported = await osCommandLine()
    return reported === undefined ? facts : { pid: facts.pid, command: reported }
  }

  /**
   * Start the detached worker that will stop this process and start the next
   * one.
   *
   * POSIX: through the harness's subprocess service, as a background job of a
   * shell that puts it in its own process group (`set -m`), so the group signal
   * DSH sends its children on exit cannot reach it.
   *
   * Windows: deliberately NOT through that service — every process it starts
   * there lives in a Win32 Job Object created with KILL_ON_JOB_CLOSE, so the
   * worker would be terminated together with the service it is restarting. A
   * detached `child_process.spawn` is outside that job and outlives us. The
   * worker writes its own log, so its stdio goes to that same file: a crash
   * before its first log line is then still recorded.
   *
   * @param payload - the base64url config the worker reads from argv.
   * @returns null, or the error that stopped the worker from starting.
   */
  const startWorker = async (payload) => {
    if (IS_WINDOWS) {
      let logFd = 'ignore'
      try {
        logFd = openSync(logPath, 'a')
      } catch (error) {
        /* the worker opens the same file itself; failing here is not fatal */
      }
      try {
        const child = spawn(launch.nodeBin, [WORKER, payload], {
          cwd: tmpdir(),
          detached: true,
          windowsHide: true,
          stdio: ['ignore', logFd, logFd],
          env: Object.assign({}, process.env, { DSH_HOME: launch.dshHome }),
        })
        let failure = null
        child.once('error', (error) => { failure = error })
        child.unref()
        // `spawn` reports ENOENT/EACCES on the next tick instead of throwing.
        await new Promise((done) => setImmediate(done))
        return failure
      } catch (error) {
        return error
      } finally {
        if (typeof logFd === 'number') {
          try { closeSync(logFd) } catch (error) { /* the child has its own copy */ }
        }
      }
    }

    const inner = ['set -m', '{', '  exec ' + shQuote(launch.nodeBin) + ' ' + shQuote(WORKER) + ' ' + shQuote(payload), '} &'].join('\n')
    try {
      spawnDetached(['bash', '-c', inner], {
        stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 },
      }, 100)
      return null
    } catch (error) {
      return error
    }
  }

  const send = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }

  /**
   * Record one accepted action in the same log the worker writes to. Without
   * this, a request that never produced a worker line is indistinguishable
   * from a request that never arrived at all.
   *
   * @param line - the message body.
   */
  const note = (line) => {
    try {
      appendFileSync(logPath, '[' + new Date().toISOString() + '] dsh-power: ' + line + '\n')
    } catch (error) {
      /* diagnostics are best effort and must never fail the action */
    }
  }

  /**
   * Write the ready-to-use authenticated URL into the log once per process.
   *
   * The browser cookie is host:port bound and lives in the browser; when it is
   * gone (cleared site data, a different host, an aged session) no reload and no
   * reconnect can help, and the only way back is the URL the server printed at
   * launch — which is easy to lose. Recording it next to the plugin's own
   * narration costs nothing and turns a dead end into one line to copy.
   *
   * The token is written to a local file only; it is never returned over HTTP.
   *
   * @param req - the request whose Host header names the authority to sign for.
   */
  let announcedAuthUrl = false
  const announceAuthUrl = (req) => {
    if (announcedAuthUrl) return
    const connection = ctx.get('connection')
    const host = req.headers.host
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return
    if (typeof host !== 'string' || host === '') return
    try {
      const url = connection.authenticatedUrl('http://' + host)
      if (typeof url === 'string' && url.length > 0) {
        announcedAuthUrl = true
        note('if the browser session is gone, reopen: ' + url)
      }
    } catch (error) {
      /* no launch token to sign with: nothing to announce */
    }
  }

  /**
   * Record one browser-side observation, rate limited so a flapping connection
   * cannot drown the log. The browser half reports its connection state and its
   * own errors here: without it, "the page keeps asking me to reconnect" is
   * only observable from inside a browser nobody else can see.
   *
   * @param payload - a small JSON-safe object from the page.
   */
  let lastReportAt = 0
  const report = (payload) => {
    const now = Date.now()
    if (now - lastReportAt < 300) return
    lastReportAt = now
    let text
    try {
      text = JSON.stringify(payload)
    } catch (error) {
      return
    }
    if (typeof text !== 'string') return
    note('browser: ' + (text.length > 1200 ? text.slice(0, 1200) + '…' : text))
  }

  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 4096) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })

  /**
   * Ask the harness to shut itself down gracefully, once the browser has its
   * answer.
   *
   * On POSIX the worker's SIGTERM does this: DSH's own handler disposes the tree
   * — stopping the child processes it manages — and exits. Windows has no
   * signals, so there the worker can only terminate the process: children in Job
   * Objects follow it, but anything outside one (a pty terminal, for instance)
   * would be orphaned. `appExit` is the harness's own bounded exit request, so
   * the tree disposes exactly the way the SIGTERM path does, and the worker
   * still stops whatever is left after its grace period.
   *
   * The listener is attached before the response is written: `finish` fires
   * once the body is out of our hands, and the application is asked to exit a
   * moment later so a fast shutdown cannot race the answer the page waits for.
   *
   * @param res - the response whose completion gates the request.
   */
  const requestGracefulExit = (res) => {
    const exit = ctx.get('appExit')
    if (typeof exit !== 'function') return
    res.once('finish', () => {
      setTimeout(() => {
        try { exit(0) } catch (error) { /* the worker stops the process anyway */ }
      }, 250)
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INFO_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { ok: false, message: 'method not allowed' })
      announceAuthUrl(req)
      const info = await probe()
      return send(res, 200, {
        ok: true,
        pid: info.pid,
        port: portOf(req) ?? null,
        command: info.command,
        logPath,
      })
    },
  }), 'dsh-power: info route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REPORT_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'method not allowed' })
      let payload = null
      try {
        payload = JSON.parse(await readBody(req))
      } catch (error) {
        payload = null
      }
      if (payload !== null && typeof payload === 'object') report(payload)
      res.statusCode = 204
      res.end()
    },
  }), 'dsh-power: report route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'method not allowed' })
      let args = null
      try {
        args = JSON.parse(await readBody(req))
      } catch (error) {
        args = null
      }
      const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : ''
      if (action !== 'restart' && action !== 'shutdown') return send(res, 400, { ok: false, message: '不支援的操作。' })
      // Windows never needs the subprocess service: the worker is spawned
      // directly there, precisely because that service would contain it in a job.
      if (subprocess === undefined && !IS_WINDOWS) return send(res, 500, { ok: false, message: '此環境沒有 subprocess 服務，無法操作行程。' })
      if (typeof launch.dshBin !== 'string' || launch.dshBin === '') {
        return send(res, 500, { ok: false, message: '無法判斷 DSH 的進入點，已取消操作。' })
      }

      const port = portOf(req)
      if (port === undefined) return send(res, 500, { ok: false, message: '無法判斷服務埠，已取消操作。' })

      // The pid is this process, which also serves the request; the worker still
      // verifies by port, because a recorded pid is a hint and the listening
      // socket is the fact.
      const info = await probe()

      const config = {
        action,
        pid: info.pid,
        host: hostOf(req),
        port,
        cwd: launch.cwd,
        nodeBin: launch.nodeBin,
        nodeArgs: launch.nodeArgs,
        dshBin: launch.dshBin,
        args: withoutBrowserOpen(launch.args),
        logFile: logPath,
        dshHome: launch.dshHome,
        // Windows gets the longer grace: the graceful exit below starts as soon
        // as the response is out, and the worker should not force-terminate the
        // process in the middle of the tree's disposal.
        graceMs: IS_WINDOWS ? 2500 : 1500,
      }
      const payload = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url')

      const failure = await startWorker(payload)
      if (failure !== null) {
        note('host FAILED to spawn the worker :: ' + String((failure && failure.message) || failure))
        return send(res, 500, { ok: false, message: String((failure && failure.message) || failure) })
      }
      // Attached before the body is written: the application is asked to exit
      // only after the page has the answer it is waiting for.
      requestGracefulExit(res)

      note('host accepted ' + action + ' port=' + port + ' pid=' + config.pid + ' argv=' + [launch.nodeBin].concat(launch.nodeArgs, config.dshBin, launch.args).join(' '))
      ctx.logger?.info?.('dsh-power: %s requested on port %s (target pid %s)', action, port, config.pid)
      return send(res, 200, {
        ok: true,
        action,
        pid: config.pid ?? null,
        port,
        logPath,
      })
    },
  }), 'dsh-power: action route')
}
