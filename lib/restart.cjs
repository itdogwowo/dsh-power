#!/usr/bin/env node
/**
 * dsh-power restart worker.
 *
 * Spawned detached (own process group) by the host half, so it survives the
 * exit cleanup of the very process it is about to stop.
 *
 * Contract: `node restart.cjs <base64url-json>` with
 *
 *   { action, pid, port, cwd, nodeBin, dshBin, args, logFile, dshHome, graceMs }
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
 */
'use strict'

const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')

const run = promisify(execFile)

const config = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'))
const action = config.action === 'shutdown' ? 'shutdown' : 'restart'
const port = Number(config.port)
const isWin = process.platform === 'win32'

const log = (message) => {
  try {
    fs.appendFileSync(config.logFile, '[' + new Date().toISOString() + '] dsh-power: ' + message + '\n')
  } catch (error) {
    /* a broken log must never break recovery */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Pids holding the listening socket for `port`, or [] when it is free. */
async function listenersOf(targetPort) {
  if (isWin) {
    try {
      const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'])
      const pids = new Set()
      for (const line of stdout.split('\n')) {
        if (line.includes('LISTENING') && line.includes(':' + targetPort + ' ')) {
          const parts = line.trim().split(/\s+/)
          if (parts[parts.length - 1]) pids.add(parts[parts.length - 1])
        }
      }
      return [...pids]
    } catch (error) {
      return []
    }
  }
  try {
    const { stdout } = await run('lsof', ['-nP', '-ti', 'tcp:' + targetPort, '-sTCP:LISTEN'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch (error) {
    return []
  }
}

/** Command line of one pid, or '' when it is already gone. */
async function commandOf(pid) {
  try {
    const { stdout } = isWin
      ? await run('wmic', ['process', 'where', 'processid=' + pid, 'get', 'commandline'])
      : await run('ps', ['-p', String(pid), '-o', 'command='])
    return stdout.trim()
  } catch (error) {
    return ''
  }
}

function signal(pid, name) {
  try {
    process.kill(Number(pid), name)
    return true
  } catch (error) {
    return false
  }
}

/** Block until none of `pids` is alive, or the budget runs out. */
async function waitGone(pids, budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const alive = pids.filter((pid) => signal(pid, 0))
    if (alive.length === 0) return true
    if (Date.now() > deadline) return false
    await sleep(200)
  }
}

async function waitPortFree(budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if ((await listenersOf(port)).length === 0) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}

async function waitPortUp(budgetMs) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if ((await listenersOf(port)).length > 0) return true
    if (Date.now() > deadline) return false
    await sleep(300)
  }
}

/**
 * Stop everything holding the port. A holder is only signalled when it is this
 * plugin's own target or a dsh process: `port` came from a request, and an
 * unrelated service must never be killed because it happens to sit there.
 */
async function stopHolders(reason) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const pids = await listenersOf(port)
    if (pids.length === 0) return true

    const targets = []
    for (const pid of pids) {
      if (config.pid !== undefined && String(config.pid) === pid) {
        targets.push(pid)
        continue
      }
      const command = await commandOf(pid)
      if (command.includes('dsh')) targets.push(pid)
      else log('refusing pid ' + pid + ' (' + reason + '): not a dsh process :: ' + command)
    }
    if (targets.length === 0) return false

    log('attempt ' + attempt + ': SIGTERM ' + targets.join(','))
    for (const pid of targets) signal(pid, 'SIGTERM')
    if (await waitGone(targets, 6000)) continue

    log('attempt ' + attempt + ': SIGKILL ' + targets.join(','))
    for (const pid of targets) signal(pid, 'SIGKILL')
    await waitGone(targets, 3000)
  }
  return (await listenersOf(port)).length === 0
}

async function main() {
  log('worker start: action=' + action + ' port=' + port + ' pid=' + config.pid + ' dshBin=' + config.dshBin)

  // Let the HTTP response reach the browser before anything goes away.
  await sleep(Number.isFinite(Number(config.graceMs)) ? Number(config.graceMs) : 1500)

  if (config.pid !== undefined) {
    signal(config.pid, 'SIGTERM')
    if (!(await waitGone([String(config.pid)], 6000))) signal(config.pid, 'SIGKILL')
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
    log('aborting: port ' + port + ' is still held by something this plugin will not kill')
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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let child
    try {
      child = spawn(config.nodeBin, [config.dshBin].concat(config.args || []), {
        cwd: config.cwd,
        detached: true,
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
    log('attempt ' + attempt + ': started pid ' + child.pid + ' :: ' + config.nodeBin + ' ' + config.dshBin + ' ' + (config.args || []).join(' '))

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
