/**
 * dsh-power restart worker — end-to-end check.
 *
 * Drives the real worker against a stand-in service: a node process that
 * listens on a port and whose command line contains `dsh`, which is the only
 * thing the worker's ownership rule asks of a port holder. Three scenarios:
 *
 *   1. restart  — the old process is stopped and a new one is listening on the
 *                 same port;
 *   2. shutdown — the port is released and nothing is relaunched;
 *   3. a foreign holder — a service that is not ours is refused, left running,
 *                 and recorded in the log.
 *
 * Windows is not exercised here (this suite runs on the machine that develops
 * the plugin); the platform-specific pieces of that path are unit-tested in
 * product-check.mjs.
 *
 * Usage: node test/worker-check.mjs [package dir]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const require = createRequire(import.meta.url)
const platformLib = require(join(root, 'lib/platform.cjs'))
const WORKER = join(root, 'lib/restart.cjs')

let failures = 0
const check = (name, value, detail) => {
  const ok = value === true || (typeof value === 'string' && value.length > 0)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + detail : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `probe` until it answers truthy, or the budget runs out. */
async function until(probe, budgetMs, stepMs = 100) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) return null
    await sleep(stepMs)
  }
}

/** True when something accepts a TCP connection on `port`. */
function answering(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const settle = (answer) => { socket.removeAllListeners(); socket.destroy(); resolve(answer) }
    socket.setTimeout(800)
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
    socket.once('connect', () => settle(true))
  })
}

/** A free loopback port, handed out by the OS itself. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const alive = (pid) => {
  try { process.kill(Number(pid), 0); return true } catch (error) { return false }
}

const kill = (pid) => {
  try { process.kill(Number(pid), 'SIGKILL') } catch (error) { /* already gone */ }
}

/** Start one stand-in service and wait until it is listening. */
async function startService(scriptPath, port, stampPath) {
  const child = spawn(process.execPath, [scriptPath, '--port', String(port)], {
    env: Object.assign({}, process.env, { DSH_POWER_FAKE_STAMP: stampPath }),
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const up = await until(async () => answering(port), 10000)
  if (up === null) throw new Error('the stand-in service never started listening on ' + port)
  return child
}

/**
 * Run the worker to completion and return its exit code and log.
 *
 * `stampPath` travels in the worker's environment so the service it relaunches
 * (which inherits that environment) can register its own pid too.
 */
function runWorker(config, stampPath) {
  const payload = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url')
  const child = spawn(process.execPath, [WORKER, payload], {
    env: Object.assign({}, process.env, stampPath ? { DSH_POWER_FAKE_STAMP: stampPath } : {}),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code, stderr }))
  })
}

const readStamp = (path) => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
  : [])

const readLog = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

// --- the stand-in service -------------------------------------------------
const SERVICE_SOURCE = `'use strict'
const http = require('node:http')
const fs = require('node:fs')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const server = http.createServer((request, response) => { response.end('ok') })
server.listen(port, '127.0.0.1', () => {
  console.log('stand-in service listening on ' + port + ' as pid ' + process.pid)
  const stamp = process.env.DSH_POWER_FAKE_STAMP
  if (stamp) fs.appendFileSync(stamp, process.pid + '\\n')
})
`

const home = mkdtempSync(join(tmpdir(), 'dsh-power-worker-check-'))
// A directory whose path says nothing about dsh: the third scenario needs a
// holder the worker's ownership rule must refuse.
const foreign = mkdtempSync(join(tmpdir(), 'stand-in-service-'))
const ownScript = join(home, 'dsh-stand-in-service.cjs')
const foreignScript = join(foreign, 'webserver.cjs')
writeFileSync(ownScript, SERVICE_SOURCE)
writeFileSync(foreignScript, SERVICE_SOURCE)

const survivors = []
try {
  // --- 1. restart ---------------------------------------------------------
  {
    const port = await freePort()
    const stamp = join(home, 'restart-pids.txt')
    const logFile = join(home, 'dsh-web.log')
    const service = await startService(ownScript, port, stamp)
    survivors.push(service.pid)
    const watcher = { pid: service.pid, code: null }
    service.once('exit', (code) => { watcher.code = code })

    check('restart: the stand-in service is up', await answering(port), 'port ' + port)
    check('restart: the worker would recognize the holder as ours',
      platformLib.isDshCommand(process.execPath + ' ' + ownScript + ' --port ' + port),
      process.execPath + ' ' + ownScript)

    const run = await runWorker({
      action: 'restart',
      pid: String(service.pid),
      host: '127.0.0.1',
      port,
      cwd: home,
      nodeBin: process.execPath,
      nodeArgs: [],
      dshBin: ownScript,
      args: ['--port', String(port)],
      logFile,
      dshHome: home,
      graceMs: 100,
    }, stamp)

    check('restart: the worker exits cleanly', run.code === 0, 'exit ' + run.code + ' ' + run.stderr.trim())
    const log = readLog(logFile)
    check('restart: the log says the port came free', log.includes('port ' + port + ' is free'), log.trim().split('\n').slice(-4).join(' | '))
    check('restart: the log says the service is back', log.includes('service is listening on ' + port + ' again'))
    check('restart: the replaced process is gone', alive(service.pid) === false || watcher.code !== null, 'pid ' + service.pid)

    const pids = readStamp(stamp)
    check('restart: a second service registered itself', pids.length === 2 && pids[0] !== pids[1], JSON.stringify(pids))
    const replacement = Number(pids[1])
    survivors.push(replacement)
    check('restart: the replacement is alive', replacement !== Number(service.pid) && alive(replacement), 'pid ' + replacement)
    check('restart: the port answers again', await answering(port), 'port ' + port)
    kill(replacement)
  }

  // --- 2. shutdown --------------------------------------------------------
  {
    const port = await freePort()
    const stamp = join(home, 'shutdown-pids.txt')
    const logFile = join(home, 'shutdown.log')
    const service = await startService(ownScript, port, stamp)
    survivors.push(service.pid)

    const run = await runWorker({
      action: 'shutdown',
      pid: String(service.pid),
      host: '127.0.0.1',
      port,
      cwd: home,
      nodeBin: process.execPath,
      nodeArgs: [],
      dshBin: ownScript,
      args: ['--port', String(port)],
      logFile,
      dshHome: home,
      graceMs: 100,
    }, stamp)

    check('shutdown: the worker exits cleanly', run.code === 0, 'exit ' + run.code + ' ' + run.stderr.trim())
    check('shutdown: the log records it', readLog(logFile).includes('shutdown complete'), readLog(logFile).trim().split('\n').pop())
    const gone = await until(async () => !(await answering(port)), 10000)
    check('shutdown: the port is released', gone !== null, 'port ' + port)
    check('shutdown: the process is gone', alive(service.pid) === false, 'pid ' + service.pid)
    check('shutdown: nothing was relaunched', readStamp(stamp).length === 1, JSON.stringify(readStamp(stamp)))
  }

  // --- 3. a holder that is not ours ---------------------------------------
  {
    const port = await freePort()
    const stamp = join(home, 'foreign-pids.txt')
    const logFile = join(home, 'foreign.log')
    const command = process.execPath + ' ' + foreignScript
    if (platformLib.isDshCommand(command)) {
      console.log('SKIP  foreign holder: this temp path looks like a dsh path :: ' + command)
    } else {
      const service = await startService(foreignScript, port, stamp)
      survivors.push(service.pid)

      const payload = Buffer.from(JSON.stringify({
        action: 'restart',
        port,
        cwd: home,
        nodeBin: process.execPath,
        nodeArgs: [],
        dshBin: foreignScript,
        args: ['--port', String(port)],
        logFile,
        dshHome: home,
        graceMs: 100,
      }), 'utf8').toString('base64url')
      const worker = spawn(process.execPath, [WORKER, payload], { stdio: ['ignore', 'ignore', 'ignore'] })
      survivors.push(worker.pid)

      const refused = await until(async () => readLog(logFile).includes('not a dsh process'), 12000)
      check('foreign holder: the worker refuses to stop it', refused !== null,
        readLog(logFile).trim().split('\n').slice(-3).join(' | '))
      check('foreign holder: the service is still running', alive(service.pid) && await answering(port), 'pid ' + service.pid)
      check('foreign holder: the worker does not pretend a restart happened',
        readLog(logFile).includes('service is listening') === false)
      kill(worker.pid)
    }
  }
} finally {
  for (const pid of survivors) kill(pid)
  await sleep(200)
  rmSync(home, { recursive: true, force: true })
  rmSync(foreign, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
