#!/usr/bin/env node
/**
 * dsh-power restart worker.
 *
 * Spawned detached by the host half, so it survives the exit cleanup of the
 * very process it is about to stop. On POSIX the host half gets that isolation
 * from a shell job in its own process group (`set -m`); on Windows it spawns
 * this worker directly with `detached: true`, because every process the
 * harness's own subprocess service starts lives in a Win32 Job Object created
 * with KILL_ON_JOB_CLOSE and would therefore die together with the service it
 * is supposed to restart.
 *
 * Contract: `node restart.cjs <base64url-json>` with
 *
 *   { action, pid, host, port, cwd, nodeBin, nodeArgs, dshBin, args, logFile,
 *     dshHome, graceMs }
 *
 * Why a standalone script instead of a shell one-liner: the relaunch needs
 * decisions (is the port free yet, did the new instance actually come up,
 * retry) that are miserable in POSIX shell and impossible to make
 * cross-platform there.
 *
 * The port is the source of truth, not the pid: a previous relaunch attempt
 * that failed to bind, or an instance from an earlier session, can own the
 * socket while the pid we recorded is long gone. Killing by port and waiting
 * for the socket to actually be free is what turns "port occupied, new
 * instance dies" into a working restart.
 *
 * Three things are different on Windows, and each one is handled where it
 * appears below:
 *
 *   - the owner of a port is read through PowerShell, with netstat as a
 *     fallback (see `./platform.cjs`);
 *   - `SIGTERM`/`SIGKILL` are not signals: Node maps both to TerminateProcess,
 *     so "stop" and "force stop" are the same call there. The graceful half of
 *     a restart is asked for by the host half instead, through the harness's
 *     own `ctx.appExit`, before this worker's grace period runs out;
 *   - a terminated process object stays visible to `OpenProcess` while any
 *     handle to it is open, so "the pid is still alive" can be true of a
 *     process that is already dead. The port is accepted as the proof.
 */
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const { listenersOf, commandOf, isDshCommand } = require('./platform.cjs')

const config = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'))
const action = config.action === 'shutdown' ? 'shutdown' : 'restart'
const port = Number(config.port)
const platform = process.platform
const isWin = platform === 'win32'
/** Names for the log: Windows has no signals, both calls there are the same kill. */
const STOP_WORD = isWin ? 'terminate' : 'SIGTERM'
const FORCE_WORD = isWin ? 'force-terminate' : 'SIGKILL'

const log = (message) => {
  try {
    fs.appendFileSync(config.logFile, '[' + new Date().toISOString() + '] dsh-power: ' + message + '\n')
  } catch (error) {
    /* a broken log must never break recovery */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Pids the operating system reports as listening on the configured port. */
const listenersOnPort = () => listenersOf({ platform, port })

/**
 * Stop one pid. On Windows `name` selects nothing: Node terminates the process
 * for every signal except 0, which is the existence check.
 *
 * @param pid - the process to signal.
 * @param name - the signal name.
 * @returns true when the call was accepted.
 */
function signal(pid, name) {
  try {
    process.kill(Number(pid), name)
    return true
  } catch (error) {
    return false
  }
}

/**
 * Try one TCP connection to host:port.
 *
 * @param host - the address to reach.
 * @returns true when the connection was established.
 */
function connectAnswers(host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host })
    const settle = (answer) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(1500)
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
    socket.once('connect', () => settle(true))
  })
}

/**
 * True when something accepts a TCP connection on the service's port.
 *
 * A second opinion next to the operating system's listener table, and on
 * Windows often the only affordable one: PowerShell and netstat can both be
 * blocked by policy, and a service that is running perfectly well must not be
 * declared dead — and then restarted over itself — because a probe was denied.
 *
 * @returns true when a connection completes.
 */
async function tcpAnswers() {
  const host = typeof config.host === 'string' && config.host !== '' ? config.host : '127.0.0.1'
  if (await connectAnswers(host)) return true
  return host === '127.0.0.1' ? false : connectAnswers('127.0.0.1')
}

/** The port is free when nothing owns it and nothing answers on it. */
async function portIsFree() {
  if ((await listenersOnPort()).length > 0) return false
  return !(await tcpAnswers())
}

/**
 * Block until none of `pids` is alive, or the budget runs out.
 *
 * Windows gets one extra question: a terminated process object stays visible to
 * `OpenProcess` while any handle to it is open, so "still alive" can outlive
 * the process. Nothing of ours can hold the port then, so a free port is
 * accepted as proof that the stop happened.
 *
 * @param pids - the pids to watch.
 * @param budgetMs - how long to wait.
 * @returns true when they are gone.
 */
async function waitStopped(pids, budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const alive = pids.filter((pid) => signal(pid, 0))
    if (alive.length === 0) return true
    if (isWin && (await portIsFree())) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}

/**
 * Wait until the port is free, or the budget runs out.
 *
 * @param budgetMs - how long to wait.
 * @returns true when the port is free.
 */
async function waitPortFree(budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await portIsFree()) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}

/**
 * Wait until the relaunched service answers. Either witness counts: the
 * operating system's listener table (authoritative about who owns the port) or
 * a completed TCP connection (which still works where the table's tools are
 * blocked), so a denied probe cannot turn a working restart into three
 * pointless attempts over a healthy service.
 *
 * @param budgetMs - how long to wait.
 * @returns true when something is listening.
 */
async function waitPortUp(budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await tcpAnswers()) return true
    if ((await listenersOnPort()).length > 0) return true
    if (Date.now() > deadline) return false
    await sleep(400)
  }
}

/**
 * Let the HTTP response reach the browser before anything goes away, but stop
 * waiting the moment the target is gone: on Windows the host half asks the
 * application to exit as soon as the answer is out, and that usually wins this
 * race — sitting out the whole grace after the service already left would only
 * make every restart slower.
 *
 * @param ms - the configured grace period.
 */
async function graceWait(ms) {
  const deadline = Date.now() + ms
  for (;;) {
    if (config.pid !== undefined && !signal(config.pid, 0)) return
    const left = deadline - Date.now()
    if (left <= 0) return
    await sleep(Math.min(200, left))
  }
}

/**
 * Stop everything holding the port. A holder is only signalled when it is this
 * plugin's own target or a dsh process: `port` came from a request, and an
 * unrelated service must never be killed because it happens to sit there.
 *
 * @param reason - what this attempt is for, for the log.
 * @returns true when the port is free afterwards.
 */
async function stopHolders(reason) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pids = await listenersOnPort()
    if (pids.length === 0) return portIsFree()

    const targets = []
    for (const pid of pids) {
      if (config.pid !== undefined && String(config.pid) === pid) {
        targets.push(pid)
        continue
      }
      const command = await commandOf({ platform, pid })
      if (isDshCommand(command)) targets.push(pid)
      else log('refusing pid ' + pid + ' (' + reason + '): not a dsh process :: ' + command)
    }
    if (targets.length === 0) return false

    log('attempt ' + attempt + ': ' + STOP_WORD + ' ' + targets.join(','))
    for (const pid of targets) signal(pid, 'SIGTERM')
    if (await waitStopped(targets, 6000)) continue

    log('attempt ' + attempt + ': ' + FORCE_WORD + ' ' + targets.join(','))
    for (const pid of targets) signal(pid, 'SIGKILL')
    await waitStopped(targets, 3000)
  }
  return portIsFree()
}

async function main() {
  log('worker start: action=' + action + ' port=' + port + ' pid=' + config.pid + ' dshBin=' + config.dshBin)

  await graceWait(Number.isFinite(Number(config.graceMs)) ? Number(config.graceMs) : 1500)

  if (config.pid !== undefined) {
    signal(config.pid, 'SIGTERM')
    if (!(await waitStopped([String(config.pid)], 6000))) signal(config.pid, 'SIGKILL')
  }

  const free = await stopHolders('port holder')
  if (action === 'shutdown') {
    log(free ? 'shutdown complete' : 'shutdown: port ' + port + ' is still occupied')
    process.exit(0)
  }
  if (!free && !(await waitPortFree(15000))) {
    // Starting anyway would race a socket we do not own, and then "is anything
    // listening?" would answer yes for the stranger's socket — a restart that
    // reports success while nothing of ours is running.
    log('aborting: port ' + port + ' is still held, and its owner is either not a dsh process or could not be identified')
    process.exit(2)
  }
  log('port ' + port + ' is free')

  // Best effort: a log we cannot open must never stop the restart itself.
  let logFd = 'ignore'
  try {
    logFd = fs.openSync(config.logFile, 'a')
  } catch (error) {
    log('cannot open log file ' + config.logFile + ' :: ' + (error && error.message))
  }
  const env = Object.assign({}, process.env, config.dshHome ? { DSH_HOME: config.dshHome } : {})
  // Node-level flags the service was started with (loaders, heap caps) belong to
  // the relaunch; the inspector family does not — it is filtered out host-side.
  const childArgs = [].concat(config.nodeArgs || [], [config.dshBin], config.args || [])
  const launchLine = [config.nodeBin].concat(childArgs).join(' ')

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let child
    try {
      // `detached` gives the replacement its own process group/session, so a
      // later restart of *it* stops it alone; `windowsHide` keeps a detached
      // relaunch from flashing a console window (ignored on POSIX).
      child = spawn(config.nodeBin, childArgs, {
        cwd: config.cwd,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', logFd, logFd],
        env,
      })
    } catch (error) {
      log('attempt ' + attempt + ': spawn failed :: ' + (error && error.message))
      await sleep(1000)
      continue
    }
    child.on('error', (error) => log('attempt ' + attempt + ': child error :: ' + (error && error.message)))
    child.unref()
    log('attempt ' + attempt + ': started pid ' + child.pid + ' :: ' + launchLine)

    if (await waitPortUp(30000)) {
      log('service is listening on ' + port + ' again')
      process.exit(0)
    }

    log('attempt ' + attempt + ': nothing listening after 30s; cleaning up and retrying')
    await stopHolders('failed relaunch')
    await waitPortFree(10000)
  }

  log('gave up after 3 attempts')
  process.exit(1)
}

main().catch((error) => {
  log('worker crashed :: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
