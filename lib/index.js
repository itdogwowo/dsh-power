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
 * `process.execPath`, `process.argv`, `process.cwd()`. Nothing is reconstructed
 * from a dying process (no `ps`, no `PATH` lookup, no guessing) — that guess is
 * how a restart ends up with a service that cannot come back.
 *
 * The detached worker (`lib/restart.cjs`) then treats the **port** as the
 * source of truth rather than one pid: it stops whoever holds the listening
 * socket, waits for the socket to actually be free, starts the service, and
 * verifies it is listening, retrying when it is not. Killing a recorded pid is
 * not enough — a half-finished earlier attempt or an older instance can own the
 * port while that pid is long gone, and then every new instance dies on
 * EADDRINUSE while the UI can only report "the port is occupied".
 *
 * The worker is started with `set -m` so it lands in its own process group and
 * survives DSH's exit cleanup, which signals the whole group of its children.
 *
 * @module dsh-power
 */

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const INFO_PATH = '/api/dsh-power/info'
const ACTION_PATH = '/api/dsh-power/action'
const LOG_NAME = 'dsh-web.log'
const WORKER = fileURLToPath(new URL('./restart.cjs', import.meta.url))

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
  const home = process.env.HOME ?? ''
  if (raw === undefined || raw === '') return resolve(home, '.dsh')
  return resolve(raw.startsWith('~') ? home + raw.slice(1) : raw)
}

/** Quote one value as a single-quoted POSIX shell word. */
const shQuote = (value) => "'" + String(value).split("'").join("'\\''") + "'"

/** Read this process's pid and command line from a child shell (display only). */
const PROBE = 'PS=$(command -v ps || echo /bin/ps); echo "$PPID"; "$PS" -p "$PPID" -o command='

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

export const inject = ['webServer']

/**
 * Register the two routes for this plugin's lifetime.
 * @param {object} ctx - the plugin context; `webServer` is a declared dependency.
 */
export function apply(ctx) {
  const subprocess = ctx.get('subprocess')

  /** Everything the worker needs, captured while this process is healthy. */
  const home = dshHomeOf()
  const launch = {
    nodeBin: process.execPath,
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

  const probe = async () => {
    if (subprocess === undefined) return null
    try {
      const handle = spawnDetached(
        ['/bin/sh', '-c', PROBE],
        { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 2048 } },
        2000,
      )
      await handle.done.then(() => undefined, () => undefined)
      const reader = handle.collected.stdout
      if (reader === undefined) return null
      const lines = String(reader.readFrom(0).text || '').split('\n')
      const pid = (lines[0] || '').trim()
      const command = lines.slice(1).join(' ').trim()
      if (pid === '' || command === '') return null
      return { pid, command }
    } catch (error) {
      return null
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
      appendFileSync(launch.dshHome + '/' + LOG_NAME, '[' + new Date().toISOString() + '] dsh-power: ' + line + '\n')
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

  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 4096) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: INFO_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { ok: false, message: 'method not allowed' })
      announceAuthUrl(req)
      const info = await probe()
      if (info === null) return send(res, 200, { ok: false, message: '無法讀取目前 DSH 行程資訊。' })
      return send(res, 200, {
        ok: true,
        pid: info.pid,
        port: portOf(req) ?? null,
        command: info.command,
        logPath: launch.dshHome + '/' + LOG_NAME,
      })
    },
  }), 'dsh-power: info route')

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
      if (subprocess === undefined) return send(res, 500, { ok: false, message: '此環境沒有 subprocess 服務，無法操作行程。' })

      const port = portOf(req)
      if (port === undefined) return send(res, 500, { ok: false, message: '無法判斷服務埠，已取消操作。' })

      // The probe is for reporting and for naming the target pid; the worker
      // still works without it, because it stops whoever holds the port and
      // refuses any holder whose command line is not a dsh process.
      const info = await probe()

      const config = {
        action,
        pid: info === null ? undefined : info.pid,
        port,
        cwd: launch.cwd,
        nodeBin: launch.nodeBin,
        dshBin: launch.dshBin,
        args: launch.args,
        logFile: launch.dshHome + '/' + LOG_NAME,
        dshHome: launch.dshHome,
        graceMs: 1500,
      }
      const payload = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url')

      try {
        if (process.platform === 'win32') {
          spawnDetached([launch.nodeBin, WORKER, payload], {
            stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 },
          }, 100)
        } else {
          const inner = ['set -m', '{', '  exec ' + shQuote(launch.nodeBin) + ' ' + shQuote(WORKER) + ' ' + shQuote(payload), '} &'].join('\n')
          spawnDetached(['bash', '-c', inner], {
            stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 },
          }, 100)
        }
      } catch (error) {
        note('host FAILED to spawn the worker :: ' + String((error && error.message) || error))
        return send(res, 500, { ok: false, message: String((error && error.message) || error) })
      }

      note('host accepted ' + action + ' port=' + port + ' pid=' + (config.pid ?? 'unknown') + ' argv=' + [launch.nodeBin, launch.dshBin].concat(launch.args).join(' '))
      ctx.logger?.info?.('dsh-power: %s requested on port %s (target pid %s)', action, port, config.pid ?? 'unknown')
      return send(res, 200, {
        ok: true,
        action,
        pid: config.pid ?? null,
        port,
        logPath: config.logFile,
      })
    },
  }), 'dsh-power: action route')
}
