/**
 * dsh-power product check.
 *
 * Verifies the shipped shape without a browser: manifest, bundle patch, host
 * half, restart worker, and the browser half driven through a mini React
 * runtime with mocked __ModuleLoader__/document/fetch/location.
 *
 * Usage: node test/product-check.mjs [package dir]
 */
import vm from 'node:vm'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const require = createRequire(import.meta.url)

/** The YAML reader is only used for one check; skip it when unavailable. */
let yaml = null
for (const candidate of ['yaml', join(process.env.HOME ?? '', '.dsh/profiles/web/node_modules/yaml')]) {
  try { yaml = require(candidate); break } catch (error) { /* try the next location */ }
}

let failures = 0
const check = (name, value, detail) => {
  const ok = value === true || (typeof value === 'string' && value.length > 0)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + detail : ''}`)
}

// --- manifest -------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('manifest name', pkg.name === 'dsh-power', pkg.name)
check('manifest bundle patch declared', pkg.dsh?.bundle?.patch === './cordis.patch.yml')
check('manifest client platform', pkg.dsh?.client?.platform === 'web')
check('manifest exports ./client', pkg.exports?.['./client'] === './lib/client.js')
check('manifest exports ./package.json', pkg.exports?.['./package.json'] === './package.json')

// --- bundle patch ---------------------------------------------------------
if (yaml !== null) {
  const patch = yaml.parse(readFileSync(join(root, 'cordis.patch.yml'), 'utf8'))
  const rows = patch.flatMap((entry) => (Array.isArray(entry.insert) ? entry.insert : []))
  check('patch inserts one row', rows.length === 1, JSON.stringify(rows))
  check('patch row id', rows[0]?.id === 'dsh-power', rows[0]?.id)
  check('patch row name == package name', rows[0]?.name === pkg.name, rows[0]?.name)
} else {
  const text = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  check('patch names the package row', text.includes("- id: dsh-power") && text.includes("name: dsh-power"))
}

// --- host half ------------------------------------------------------------
const hostSource = readFileSync(join(root, 'lib/index.js'), 'utf8')
const host = await import(pathToFileURL(join(root, 'lib/index.js')).href)
check('host exports apply', typeof host.apply === 'function')
check('host injects webServer', Array.isArray(host.inject) && host.inject.includes('webServer'), host.inject?.join(','))
check('host captures argv while alive', hostSource.includes('process.argv.slice(2)'))
check('host expands DSH_HOME', hostSource.includes('function dshHomeOf'))
check('host spawns the worker in its own group', hostSource.includes('set -m'))
check('host logs acceptance', hostSource.includes("note('host accepted"))
check('host reads the port from Host', hostSource.includes('function portOf'))
check('host prefers the port its own socket is listening on', hostSource.includes('ctx.webServer?.port'), )
check('host pins the relaunch to that port', hostSource.includes('pinnedToPort(withoutBrowserOpen(launch.args), port)'))
check('host never substitutes a default port for the real one', !/['"]3080['"]/.test(hostSource))
check('restart never opens a browser tab', hostSource.includes('withoutBrowserOpen'))
check('host replays node flags', hostSource.includes('process.execArgv'))
check('host does not replay the inspector', hostSource.includes('DEBUGGER_FLAG'))
check('host reads the home directory on Windows too', hostSource.includes('USERPROFILE'))
check('host knows the pid without a shell probe', hostSource.includes('String(process.pid)'))

// --- restart worker -------------------------------------------------------
const workerSource = readFileSync(join(root, 'lib/restart.cjs'), 'utf8')
check('worker parses', (() => {
  try { new vm.Script(workerSource, { filename: 'restart.cjs' }); return true } catch (error) {
    console.log('  worker parse error:', error.message)
    return false
  }
})())
check('worker reads its config from argv', workerSource.includes('Buffer.from(process.argv[2]'))
check('worker treats the port as authority', workerSource.includes('listenersOnPort()'))
check('worker verifies the relaunch', workerSource.includes('waitPortUp'))
check('worker refuses non-dsh holders', workerSource.includes('isDshCommand(command)'))
check('worker log failure is non-fatal', workerSource.includes('cannot open log file'))
check('worker cross-checks the port over TCP', workerSource.includes('tcpAnswers'))
check('worker hides its relaunch window on Windows', workerSource.includes('windowsHide: true'))
check('worker delegates platform questions', workerSource.includes("require('./platform.cjs')"))

// --- host half: the Windows spawn branch ----------------------------------
// The worker cannot be started through the harness subprocess service on
// Windows (its children live in a Job Object with KILL_ON_JOB_CLOSE and would
// die with the service), so the host spawns it detached instead.
const windowsBranch = hostSource.slice(hostSource.indexOf('const startWorker'), hostSource.indexOf("const inner = ['set -m'"))
check('windows worker is spawned outside the harness job', windowsBranch.includes('detached: true') && windowsBranch.includes('windowsHide: true'))
check('windows worker is not spawned through subprocess', !windowsBranch.includes('spawnDetached('))
check('windows worker keeps the service log', windowsBranch.includes('openSync(logPath'))
check('windows worker starts outside the project directory', windowsBranch.includes('cwd: tmpdir()'))
check('windows asks the harness to exit gracefully', hostSource.includes("ctx.get('appExit')"))
check('graceful exit waits for the response', hostSource.includes("res.once('finish'"))
check('windows gets the longer grace period', hostSource.includes('graceMs: IS_WINDOWS ? 2500 : 1500'))

// --- platform primitives --------------------------------------------------
const platformLib = require(join(root, 'lib/platform.cjs'))
const PORT = 3080

// netstat as Windows prints it: the state word is localized (偵聽 = listening)
// and the header is localized too, so only the columns are reliable.
const netstatSample = [
  '',
  '活動連線',
  '',
  '  通訊協定  本機位址          外部位址              狀態          PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0             偵聽          1004',
  '  TCP    127.0.0.1:3080         0.0.0.0:0             偵聽          4242',
  '  TCP    127.0.0.1:3080         127.0.0.1:51515       TIME_WAIT     0',
  '  TCP    127.0.0.1:3080         127.0.0.1:51516       已建立        5555',
  '  TCP    [::]:3080              [::]:0                偵聽          4242',
  '  TCP    127.0.0.1:30800        0.0.0.0:0             偵聽          9999',
  '  TCP    0.0.0.0:8080           0.0.0.0:0             偵聽          7777',
  '',
].join('\r\n')
const netstatPids = platformLib.parseWindowsNetstat(netstatSample, PORT)
check('netstat: reading is by column, not by language', JSON.stringify(netstatPids) === '["4242"]', JSON.stringify(netstatPids))
check('netstat: a time-wait row is not a listener', !netstatPids.includes('0'))
check('netstat: a connected row is not a listener', !netstatPids.includes('5555'))
check('netstat: a longer port is not this port', !netstatPids.includes('9999'))
check('netstat: an English listing still parses', JSON.stringify(platformLib.parseWindowsNetstat(
  '  TCP    0.0.0.0:3080    0.0.0.0:0    LISTENING    4242\r\n', PORT,
)) === '["4242"]')

const psArgs = platformLib.powerShellArgs('Get-Date')
check('powershell: script is base64/UTF-16LE, not shell-quoted',
  psArgs.includes('-EncodedCommand') && psArgs.includes('-NoProfile') && Buffer.from(psArgs[psArgs.length - 1], 'base64').toString('utf16le') === 'Get-Date')
check('powershell: listener script carries the port', platformLib.listenersScript(PORT).includes('-LocalPort 3080'))
check('powershell: command-line script carries the pid', platformLib.commandLineScript('4242').includes('ProcessId=4242'))
check('powershell: listener script asks for the listening state', platformLib.listenersScript(PORT).includes('-State Listen'))

const execCalls = []
const fakeExec = (answers) => async (file, args) => {
  execCalls.push({ file, args })
  const answer = answers(file, args)
  if (answer === undefined) throw new Error('not available: ' + file)
  return answer
}

// Windows: PowerShell first, netstat when it is refused.
{
  execCalls.length = 0
  const pids = await platformLib.listenersOf({
    platform: 'win32',
    port: PORT,
    exec: fakeExec((file) => (file.includes('powershell') ? '4242\r\n4242\r\n' : undefined)),
  })
  check('windows: listeners come from PowerShell', JSON.stringify(pids) === '["4242"]' && execCalls[0].file.includes('powershell'), JSON.stringify(pids))
}
{
  execCalls.length = 0
  const pids = await platformLib.listenersOf({
    platform: 'win32',
    port: PORT,
    exec: fakeExec((file, args) => (file.includes('netstat') ? netstatSample : undefined)),
  })
  check('windows: netstat answers when PowerShell is blocked',
    JSON.stringify(pids) === '["4242"]' && execCalls.length === 2 && execCalls[1].file.includes('netstat') && execCalls[1].args.join(' ') === '-ano -p TCP',
    JSON.stringify(pids))
}
{
  const pids = await platformLib.listenersOf({ platform: 'win32', port: PORT, exec: fakeExec(() => undefined) })
  check('windows: a denied probe reports no listeners', pids.length === 0)
}
{
  execCalls.length = 0
  const pids = await platformLib.listenersOf({ platform: 'darwin', port: PORT, exec: fakeExec(() => '4242\n') })
  check('posix: listeners come from lsof', JSON.stringify(pids) === '["4242"]' && execCalls[0].file === 'lsof' && execCalls[0].args.includes('tcp:3080'), JSON.stringify(execCalls[0]))
}

// Windows command lines: CIM first, wmic when PowerShell is refused.
{
  execCalls.length = 0
  const command = await platformLib.commandOf({
    platform: 'win32',
    pid: '4242',
    exec: fakeExec((file) => (file.includes('powershell') ? '  "C:\\Program Files\\nodejs\\node.exe" C:\\dev\\dsh\\lib\\bin.js web  \r\n' : undefined)),
  })
  check('windows: command line comes from CIM', command === '"C:\\Program Files\\nodejs\\node.exe" C:\\dev\\dsh\\lib\\bin.js web', command)
  check('windows: the CIM probe is asked for that pid', Buffer.from(execCalls[0].args[execCalls[0].args.length - 1], 'base64').toString('utf16le').includes('ProcessId=4242'))
}
{
  execCalls.length = 0
  const command = await platformLib.commandOf({
    platform: 'win32',
    pid: '4242',
    exec: fakeExec((file) => (file.includes('wmic')
      ? 'CommandLine\r\n"C:\\Program Files\\nodejs\\node.exe" C:\\dev\\dsh\r\n\\lib\\bin.js web\r\n\r\n'
      : undefined)),
  })
  check('windows: wmic answers when PowerShell is blocked', command === '"C:\\Program Files\\nodejs\\node.exe" C:\\dev\\dsh \\lib\\bin.js web', command)
  check('windows: the wmic probe asks for that pid', execCalls[1].args.join(' ') === 'process where processid=4242 get commandline', execCalls[1].args.join(' '))
}
check('wmic: a missing process is not a command line', platformLib.parseWmicCommandLine('No Instance(s) Available.\r\n') === '')
{
  const command = await platformLib.commandOf({ platform: 'darwin', pid: '4242', exec: fakeExec(() => '/usr/local/bin/node /usr/local/bin/dsh web\n') })
  check('posix: command line comes from ps', command === '/usr/local/bin/node /usr/local/bin/dsh web', command)
}

check('a Windows dsh path is ours, in any case',
  platformLib.isDshCommand('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\DSH\\lib\\bin.js web')
  && platformLib.isDshCommand('node C:\\dev\\deepseek-harness\\apps\\cli\\lib\\bin.js web'))
check('an unrelated server is not ours', platformLib.isDshCommand('nginx: worker process') === false)
check('an unreadable command line is not ours', platformLib.isDshCommand('') === false)
check('node flags are replays except the inspector',
  JSON.stringify(host.withoutDebugger(['--inspect-brk', '--max-old-space-size=4096', '--import', 'tsx', '--debug=9229']))
  === '["--max-old-space-size=4096","--import","tsx"]',
  JSON.stringify(host.withoutDebugger(['--inspect-brk', '--max-old-space-size=4096', '--import', 'tsx', '--debug=9229'])))

// The relaunch is pinned to the port the process actually holds. Each shape the
// captured argv can take is pinned in place, so the relaunch command stays
// readable and an existing (possibly wrong) value cannot look meaningful.
check('pin: a missing port is appended',
  JSON.stringify(host.pinnedToPort(['web', '--no-open'], 3080)) === '["web","--no-open","--port","3080"]',
  JSON.stringify(host.pinnedToPort(['web', '--no-open'], 3080)))
check('pin: the documented form is rewritten, not duplicated',
  JSON.stringify(host.pinnedToPort(['web', '--port', '9999', '--no-open'], 3080)) === '["web","--port","3080","--no-open"]',
  JSON.stringify(host.pinnedToPort(['web', '--port', '9999', '--no-open'], 3080)))
check('pin: the `--port=` form is rewritten too',
  JSON.stringify(host.pinnedToPort(['web', '--port=9999', '--no-open'], 3080)) === '["web","--port=3080","--no-open"]',
  JSON.stringify(host.pinnedToPort(['web', '--port=9999', '--no-open'], 3080)))
check('pin: an OS-assigned port replaces the `--port 0` that asked for it',
  JSON.stringify(host.pinnedToPort(['web', '--port', '0'], 54321)) === '["web","--port","54321"]',
  JSON.stringify(host.pinnedToPort(['web', '--port', '0'], 54321)))
check('pin: a repeated flag collapses to one',
  JSON.stringify(host.pinnedToPort(['web', '--port', '1', '--port', '2'], 3080)) === '["web","--port","3080"]',
  JSON.stringify(host.pinnedToPort(['web', '--port', '1', '--port', '2'], 3080)))
check('pin: args are left alone when no bound port is known',
  JSON.stringify(host.pinnedToPort(['web', '--port', '9999'], undefined)) === '["web","--port","9999"]')
check('pin: an impossible port is not written into the relaunch',
  JSON.stringify(host.pinnedToPort(['web'], 0)) === '["web"]' && JSON.stringify(host.pinnedToPort(['web'], 70000)) === '["web"]')

// --- host half: driven through a fake context -----------------------------
// The Windows branch above is checked statically (no Windows here to run it);
// everything platform-neutral is exercised for real, including the config the
// worker receives.
//
// SAFETY: this fake context deliberately does NOT provide `appExit`. The host
// half asks the harness to exit gracefully once the response is out, which on
// Windows means "the worker kills this process" — and this test suite is very
// often run from inside the very DSH instance it would then shut down. Leaving
// appExit out makes the destructive call a no-op, so the suite can never take
// the user's server with it.
const IS_WINDOWS_RUN = process.platform === 'win32'

/**
 * A context `get` that refuses to hand out the app's exit hook.
 *
 * Providing one would let this suite terminate the DSH instance running it, so
 * the refusal is enforced here rather than left to a comment — and it fails the
 * run loudly if a future change starts depending on it.
 *
 * @param extra - names to serve before the guard.
 * @returns the lookup function.
 */
function guardedGet(extra) {
  return (name) => {
    if (name === 'appExit') {
      check('the test context must never expose appExit', false,
        'the host half asked for appExit; this suite would have shut down its own DSH')
      return undefined
    }
    return Object.prototype.hasOwnProperty.call(extra, name) ? extra[name] : undefined
  }
}
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-power-check-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const routes = new Map()
  // SAFETY, part 2 — the load-bearing one. This suite is routinely run from
  // inside the very DSH instance it is testing, so the action route must never
  // get past the point where it starts a worker: that is where the host half
  // asks the harness to exit gracefully, which on Windows means the restart
  // worker terminating this very process. The spawn therefore captures the
  // worker spec and then throws, unwinding the route before it can arm anything.
  const WORKER_REFUSED = new Error('test harness: refusing to start a real restart worker')
  const spawned = []
  const refusal = (spec) => { spawned.push(spec); throw WORKER_REFUSED }
  // The real webserver exposes `port`; the plugin must plan the restart around
  // it rather than around the request's Host header.
  const BOUND_PORT = 3080
  const fakeCtx = {
    logger: { info: () => {} },
    effect: (fn) => { fn(); return () => {} },
    get: guardedGet({ subprocess: { spawn: refusal } }),
    webServer: {
      port: BOUND_PORT,
      register: (route) => { routes.set(route.path, route); return () => {} },
    },
  }
  try {
    host.apply(fakeCtx)
    check('host registers info, action and report routes', routes.size === 3, [...routes.keys()].join(','))

    const call = (path, method, hostHeader, body) => new Promise((resolve) => {
      const listeners = {}
      const req = {
        method,
        headers: { host: hostHeader },
        on: (name, handler) => { listeners[name] = handler },
        destroy: () => {},
      }
      const res = {
        statusCode: 0,
        body: '',
        headers: {},
        onFinish: null,
        setHeader: (name, value) => { res.headers[name] = value },
        once: (name, handler) => { if (name === 'finish') res.onFinish = handler },
        end: (text) => {
          res.body = String(text ?? '')
          if (res.onFinish) res.onFinish()
          resolve(res)
        },
      }
      // The handler attaches its request listeners synchronously, before it
      // awaits the body — so the body can be delivered right away.
      const settled = Promise.resolve(routes.get(path).handler(req, res))
      if (body !== undefined) listeners.data?.(body)
      listeners.end?.()
      settled.then(() => resolve(res), () => resolve(res))
    })

    const info = await call('/api/dsh-power/info', 'GET', '127.0.0.1:3080')
    const infoBody = JSON.parse(info.body)
    check('info: reports this process', infoBody.ok === true && infoBody.pid === String(process.pid), JSON.stringify(infoBody))
    check('info: reports the port this process is listening on', infoBody.port === BOUND_PORT, String(infoBody.port))
    check('info: reports a usable command line', typeof infoBody.command === 'string' && infoBody.command.length > 0, infoBody.command)
    check('info: reports the log path', infoBody.logPath === join(home, 'dsh-web.log'), infoBody.logPath)

    // The client renders `127.0.0.1:<port>`, so a bound port that disagrees with
    // the Host header must still be reported as the bound one — the page would
    // otherwise advertise an address the user cannot open.
    const viaProxy = await call('/api/dsh-power/info', 'GET', 'localhost:8080')
    check('info: the listening socket outranks the Host header',
      JSON.parse(viaProxy.body).port === BOUND_PORT, viaProxy.body)

    // The action must be planned around the socket too: this request arrives
    // with a Host header (8080) that is deliberately NOT the port the process
    // holds, which is exactly the port-forward shape that used to break restarts.
    //
    // The route reports 500 here because the harness refuses to start a real
    // worker (see WORKER_REFUSED). That refusal is the point: it means the whole
    // config was built and handed over before anything destructive could run.
    const action = await call('/api/dsh-power/action', 'POST', 'localhost:8080', JSON.stringify({ action: 'restart' }))
    const actionBody = JSON.parse(action.body)
    check('action: the refused spawn is reported as a failure, not a success',
      action.statusCode === 500 && actionBody.ok === false, action.body)
    check('action: the failure names the harness refusal',
      action.body.includes('refusing to start a real restart worker'), action.body)
    check('action: spawned exactly one worker', spawned.length === 1)
    const argv = spawned[0]?.argv ?? []
    check('action: worker runs the shipped script', argv.some((value) => String(value).includes('restart.cjs')))

    // The worker's launch shape is platform-specific: a `bash -c 'set -m'` job
    // group on POSIX, a detached spawn outside the harness's Job Object on
    // Windows. Only the platform actually running can be driven here, so the
    // other one is asserted from the source further below.
    let workerConfig
    if (IS_WINDOWS_RUN) {
      check('action: the POSIX shell launcher is not used on Windows',
        argv[0] !== 'bash', argv.slice(0, 2).map(String).join(' '))
      // Windows spawns `<node> <restart.cjs> <payload>`, so the config is argv[2]
      // and must be read straight from the captured spawn call.
      workerConfig = JSON.parse(Buffer.from(String(argv[2] ?? ''), 'base64url').toString('utf8'))
    } else {
      check('action: worker is detached from the group DSH cleans',
        argv[0] === 'bash' && argv[2].includes('set -m'), argv.slice(0, 2).join(' '))
      // The payload is the last single-quoted word of the generated shell script.
      const quoted = [...String(argv[2] ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1])
      workerConfig = JSON.parse(Buffer.from(quoted[quoted.length - 1], 'base64url').toString('utf8'))
    }
    check('action: worker config names the port it will return on, not the proxy port',
      workerConfig.port === BOUND_PORT, JSON.stringify({ port: workerConfig.port, host: workerConfig.host }))
    check('action: worker config names the host from the request', workerConfig.host === 'localhost', workerConfig.host)
    check('action: worker config names this pid', workerConfig.pid === String(process.pid))
    check('action: relaunch never opens a browser', workerConfig.args.includes('--no-open'), JSON.stringify(workerConfig.args))
    // The relaunch must land on the port that was vacated, so the port is pinned
    // explicitly instead of being inherited from whatever argv happened to say.
    check('action: relaunch pins the port it was listening on',
      workerConfig.args[workerConfig.args.length - 1] === String(BOUND_PORT)
      && workerConfig.args[workerConfig.args.length - 2] === '--port',
      JSON.stringify(workerConfig.args))
    check('action: the pinned port appears exactly once',
      workerConfig.args.filter((value) => value === '--port').length === 1,
      JSON.stringify(workerConfig.args))
    check('action: relaunch keeps the captured entry point', workerConfig.nodeBin === process.execPath && workerConfig.dshBin === process.argv[1], workerConfig.dshBin)
    check('action: relaunch runs in the captured cwd', workerConfig.cwd === process.cwd(), workerConfig.cwd)
    check('action: the log lives in DSH_HOME', workerConfig.logFile === join(home, 'dsh-web.log'), workerConfig.logFile)
    // The acceptance line is written only after a successful spawn, so a refused
    // spawn must leave the log without one — that ordering is what makes the log
    // a reliable witness of "did the action ever reach the host".
    check('action: a refused spawn leaves no acceptance line in the log',
      !readFileSync(join(home, 'dsh-web.log'), 'utf8').includes('host accepted restart'),
      readFileSync(join(home, 'dsh-web.log'), 'utf8').trim().split('\n').filter(Boolean).pop() ?? '(log empty)')

    const bad = await call('/api/dsh-power/action', 'POST', '127.0.0.1:3080', JSON.stringify({ action: 'explode' }))
    check('action: unknown actions are refused', bad.statusCode === 400, bad.body)
    check('action: no worker was spawned for a refused request', spawned.length === 1)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
}

// --- host half: without a listening port to read ---------------------------
// `webServer.port` only exists once the server is listening, so the Host header
// remains the fallback. That path must still work and must still refuse a port
// it cannot make sense of.
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-power-nohost-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const routes = new Map()
  const spawned = []
  const fakeCtx = {
    logger: { info: () => {} },
    effect: (fn) => { fn(); return () => {} },
    get: guardedGet({}),
    // No `port`: the webserver has not reported one.
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
  }
  try {
    host.apply(fakeCtx)
    const call = (path, method, hostHeader, body) => new Promise((resolve) => {
      const listeners = {}
      const req = {
        method,
        headers: { host: hostHeader },
        on: (name, handler) => { listeners[name] = handler },
        destroy: () => {},
      }
      // `once` is a no-op here on purpose. The host half attaches its graceful
      // exit to the response's `finish` event, and on Windows that calls the
      // harness's own `ctx.appExit` — which, with a real appExit in reach,
      // would shut down the DSH instance running this test. Nothing on this
      // path should register a listener at all; this only guarantees that a
      // regression cannot turn into a self-shutdown.
      const res = {
        statusCode: 0,
        body: '',
        headers: {},
        setHeader: (name, value) => { res.headers[name] = value },
        once: () => {},
        end: (text) => {
          res.body = String(text ?? '')
          resolve(res)
        },
      }
      const settled = Promise.resolve(routes.get(path).handler(req, res))
      if (body !== undefined) listeners.data?.(body)
      listeners.end?.()
      settled.then(() => resolve(res), () => resolve(res))
    })

    const info = await call('/api/dsh-power/info', 'GET', '127.0.0.1:5123')
    check('no bound port: the Host header is still used', JSON.parse(info.body).port === 5123, info.body)
    const defaultPort = await call('/api/dsh-power/info', 'GET', 'localhost')
    check('no bound port: a Host without a port reads as the HTTP default',
      JSON.parse(defaultPort.body).port === 80, defaultPort.body)
    const impossible = await call('/api/dsh-power/action', 'POST', '127.0.0.1:99999', JSON.stringify({ action: 'shutdown' }))
    check('no bound port: an impossible Host port is refused', impossible.statusCode === 500, impossible.body)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
}

// --- browser half ---------------------------------------------------------
const calls = []
let loaded = null
let loadedUnauth = null
let reloaded = false
let replaced = null
let acted = false
/** Every readiness probe of `/` made before navigating, and what it answered. */
const rootProbes = []
let rootStatus = 200
const styleTags = []
const visibilityListeners = []
const windowListeners = []
const sandbox = {
  setTimeout,
  clearTimeout,
  window: {
    __ModuleLoader__: { load: (definition) => { loaded = definition } },
    location: {
      origin: 'http://127.0.0.1:3080',
      href: 'http://127.0.0.1:3080/',
      reload: () => { reloaded = true },
      replace: (url) => { replaced = url },
    },
    navigator: { onLine: true },
    addEventListener: (name, handler) => windowListeners.push({ name, handler }),
    removeEventListener: () => {},
    document: {
      visibilityState: 'visible',
      addEventListener: (name, handler) => visibilityListeners.push({ name, handler }),
      removeEventListener: () => {},
    },
  },
  document: {
    createElement: () => ({ dataset: {}, textContent: '', remove() { this.removed = true } }),
    head: { appendChild: (tag) => styleTags.push(tag) },
  },
  fetch: async (url, options) => {
    calls.push({ url, options })
    if (url === '/') {
      // The readiness probe asks for `/` before navigating. Anything except 404
      // counts as "this origin serves the page".
      rootProbes.push({ options })
      return { status: rootStatus, json: async () => ({}) }
    }
    if (url === '/api/dsh-power/report') return { status: 204, json: async () => ({}) }
    if (url.includes('/info')) {
      const pid = acted ? '55555' : '67489'
      return { json: async () => ({ ok: true, pid, port: 3080, command: 'node /x/dsh web' }) }
    }
    acted = true
    return { json: async () => ({ ok: true, action: 'restart', pid: '67489', port: 3080, logPath: '/tmp/x.log' }) }
  },
  console,
}
vm.createContext(sandbox)
vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox, { filename: 'client.js' })

check('bundle id == package name', loaded?.id === pkg.name, loaded?.id)

const hooks = []
const effectState = []
let cursor = 0
let root_node = null
let Component = null
const ReactMock = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState: (initial) => {
    const index = cursor++
    if (!(index in hooks)) hooks[index] = initial
    const set = (next) => {
      hooks[index] = typeof next === 'function' ? next(hooks[index]) : next
      render()
    }
    return [hooks[index], set]
  },
  useEffect: (fn, deps) => {
    const index = cursor++
    const key = index + 1
    const previous = effectState[key]
    const changed = previous === undefined || deps === undefined
      || deps.length !== previous.deps.length || deps.some((dep, i) => dep !== previous.deps[i])
    if (!changed) return
    if (previous !== undefined && typeof previous.cleanup === 'function') {
      try { previous.cleanup() } catch (error) { /* ignore */ }
    }
    effectState[key] = { deps: deps ?? [], cleanup: fn() }
  },
}

const mod = loaded.factory((id) => {
  if (id === 'react') return ReactMock
  throw new Error('unexpected require: ' + id)
})
check('browser exports apply', typeof mod.apply === 'function')
check('browser injects slots', Array.isArray(mod.inject) && mod.inject.includes('slots'), mod.inject?.join(','))

const registrations = []
mod.apply({
  get: () => undefined,
  effect: (fn) => fn(),
  slots: {
    inject: (key, callback) => { registrations.key = key; callback() },
    register: (options, component) => registrations.push({ options, component }),
  },
})
check('registers into settings.general.item', registrations.key === 'settings.general.item', registrations.key)
check('row id', registrations[0]?.options?.id === 'service-power', registrations[0]?.options?.id)
check('row order', registrations[0]?.options?.order === 30, String(registrations[0]?.options?.order))
check('browser reports to its host half', calls.some((call) => call.url === '/api/dsh-power/report' && String(call.options?.body).includes('mount')))
check('error reporting wired', windowListeners.some((entry) => entry.name === 'error') && windowListeners.some((entry) => entry.name === 'unhandledrejection'))
check('style tag inserted', styleTags.length === 1)
Component = registrations[0].component

function render() { cursor = 0; root_node = Component() }
render()

const textOf = (node) => (node === null || node === undefined)
  ? ''
  : (typeof node === 'object')
    ? (node.children || []).map(textOf).join('')
    : typeof node === 'string' ? node : ''
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}
function buttonWithText(text) {
  let found = null
  walk(root_node, (node) => { if (!found && node.type === 'button' && textOf(node) === text) found = node })
  return found
}

await new Promise((resolve) => setTimeout(resolve, 5))
check('renders row title', textOf(root_node).includes('DSH 服務'))
check('idle copy is short', textOf(root_node).includes('PID 67489') && !textOf(root_node).includes('/x/dsh web'), JSON.stringify(textOf(root_node)))
check('shows the listening port', textOf(root_node).includes('127.0.0.1:3080'))
check('info fetched on mount', calls.some((call) => call.url === '/api/dsh-power/info'))

buttonWithText('重新啟動').props.onClick()
check('confirm step', textOf(root_node).includes('確定要重新啟動？'))
buttonWithText('取消').props.onClick()
check('cancel restores', buttonWithText('關閉') !== null)

buttonWithText('重新啟動').props.onClick()
buttonWithText('確認').props.onClick()

const busyBtn = buttonWithText('處理中…')
check('busy: confirm button disabled', busyBtn?.props?.disabled === true)
check('busy: spinner is an svg circle', (busyBtn?.children || []).some((child) => child && child.type === 'svg'
  && child.props?.className === 'dshpw-spinner'
  && (child.children || []).some((inner) => inner && inner.type === 'circle')))
check('busy: no cancel button offered', buttonWithText('取消') === null)

await new Promise((resolve) => setTimeout(resolve, 5))
const post = calls.find((call) => call.url === '/api/dsh-power/action')
check('post body', post?.options?.body === '{"action":"restart"}', post?.options?.body)
check('restart notice', textOf(root_node).includes('服務正在重新啟動'))
check('reconnecting state shown', buttonWithText('重新連線中…')?.props?.disabled === true)
check('visibility recovery wired', visibilityListeners.some((entry) => entry.name === 'visibilitychange'))
check('no navigation before the new pid answers', replaced === null && reloaded === false)

await new Promise((resolve) => setTimeout(resolve, 1800))
check('left for a clean URL after the new pid answered', replaced === 'http://127.0.0.1:3080/', String(replaced))
// Navigating on the info answer alone used to be enough, and landed on a server
// that was listening but had no `/` route yet — the browser showed 404 and the
// user had to refresh. The origin must be asked whether it serves the page.
check('the origin was asked whether it serves the page before navigating',
  rootProbes.length >= 1, String(rootProbes.length) + ' probe(s)')
check('the readiness probe is a plain GET of the app root',
  rootProbes[0]?.options?.method === 'GET', JSON.stringify(rootProbes[0]?.options))

// --- first-and-a-half scenario: the page is NOT served yet -----------------
// The exact production shape: the new process answers this plugin's route, but
// `/` still 404s because the application has not mounted it. The row must wait
// rather than navigate into the 404.
{
  const calls3 = []
  let loadedNotReady = null
  let replacedNotReady = null
  const notReadyProbes = []
  let infoActed = false
  let rootProbesDone = 0
  const sandboxNotReady = {
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: { load: (definition) => { loadedNotReady = definition } },
      location: {
        origin: 'http://127.0.0.1:3080',
        href: 'http://127.0.0.1:3080/',
        reload: () => {},
        replace: (url) => { replacedNotReady = url },
      },
      navigator: { onLine: true },
      addEventListener: () => {},
      removeEventListener: () => {},
      document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
    },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild: () => {} },
    },
    fetch: async (url) => {
      calls3.push(url)
      if (url === '/') {
        // 404 while the application is still mounting, then fine.
        rootProbesDone += 1
        notReadyProbes.push(rootProbesDone)
        return { status: rootProbesDone < 2 ? 404 : 200, json: async () => ({}) }
      }
      if (url === '/api/dsh-power/report') return { status: 204, json: async () => ({}) }
      if (url.includes('/info')) {
        return { json: async () => ({ ok: true, pid: infoActed ? '55555' : '67489', port: 3080, command: 'node /x/dsh web' }) }
      }
      infoActed = true
      return { json: async () => ({ ok: true, action: 'restart', pid: '67489', port: 3080, logPath: '/tmp/x.log' }) }
    },
    console,
  }
  vm.createContext(sandboxNotReady)
  vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandboxNotReady, { filename: 'client.js' })
  const modNotReady = loadedNotReady.factory((id) => {
    if (id === 'react') return ReactMock
    throw new Error('unexpected require: ' + id)
  })
  const regsNotReady = []
  modNotReady.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    slots: {
      inject: (key, callback) => { regsNotReady.key = key; callback() },
      register: (options, component) => regsNotReady.push({ options, component }),
    },
  })
  Component = regsNotReady[0].component
  cursor = 0
  hooks.length = 0
  effectState.length = 0
  render()
  await new Promise((resolve) => setTimeout(resolve, 5))
  buttonWithText('重新啟動').props.onClick()
  buttonWithText('確認').props.onClick()

  await new Promise((resolve) => setTimeout(resolve, 600))
  check('not-yet-served: the page did NOT navigate into the 404', replacedNotReady === null, String(replacedNotReady))
  check('not-yet-served: the row keeps waiting instead of erroring',
    textOf(root_node).includes('重新連線中…') && !textOf(root_node).includes('請重新整理頁面'),
    JSON.stringify(textOf(root_node)))

  await new Promise((resolve) => setTimeout(resolve, 2200))
  check('not-yet-served: it navigated once the page was actually served',
    replacedNotReady === 'http://127.0.0.1:3080/', String(replacedNotReady))
  check('not-yet-served: it retried the probe rather than giving up',
    notReadyProbes.length >= 2, 'probes: ' + notReadyProbes.length)
}

// --- second scenario: an unauthenticated page -----------------------------
{
  const calls2 = []
  const sandbox2 = {
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: { load: (definition) => { loadedUnauth = definition } },
      location: { origin: 'http://localhost:3080', href: 'http://localhost:3080/', reload: () => {}, replace: () => {} },
      navigator: { onLine: true },
      addEventListener: () => {},
      removeEventListener: () => {},
      document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
    },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild: () => {} },
    },
    fetch: async (url) => {
      calls2.push(url)
      if (url === '/') return { status: 401, json: async () => ({}) }
      return { json: async () => ({ ok: true, pid: '67489', port: 3080, command: 'node /x/dsh web' }) }
    },
    console,
  }
  vm.createContext(sandbox2)
  vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox2, { filename: 'client.js' })
  const mod2 = loadedUnauth.factory((id) => {
    if (id === 'react') return ReactMock
    throw new Error('unexpected require: ' + id)
  })
  const regs2 = []
  mod2.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    slots: {
      inject: (key, callback) => { regs2.key = key; callback() },
      register: (options, component) => regs2.push({ options, component }),
    },
  })
  Component = regs2[0].component
  cursor = 0
  hooks.length = 0
  effectState.length = 0
  render()
  await new Promise((resolve) => setTimeout(resolve, 5))
  check('session probe asks the app root', calls2.includes('/'))
  check('unauthenticated page warns about the address', textOf(root_node).includes('沒有有效登入') && textOf(root_node).includes('?token='), JSON.stringify(textOf(root_node)))
  check('unauthenticated page locks the actions', buttonWithText('重新啟動')?.props?.disabled === true)
}

// --- third scenario: the machine reports no network ------------------------
{
  let loadedOffline = null
  const dispatched = []
  const sandbox3 = {
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: { load: (definition) => { loadedOffline = definition } },
      location: { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/', reload: () => {}, replace: () => {} },
      navigator: { onLine: false },
      Event: class { constructor(type) { this.type = type } },
      dispatchEvent: (event) => { dispatched.push(event && event.type) },
      addEventListener: () => {},
      removeEventListener: () => {},
      document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
    },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild: () => {} },
    },
    fetch: async (url) => {
      if (url === '/') return { status: 200, json: async () => ({}) }
      if (url === '/api/dsh-power/report') return { status: 204, json: async () => ({}) }
      return { json: async () => ({ ok: true, pid: '67489', port: 3080, command: 'node /x/dsh web' }) }
    },
    console,
  }
  vm.createContext(sandbox3)
  vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox3, { filename: 'client.js' })
  const mod3 = loadedOffline.factory((id) => {
    if (id === 'react') return ReactMock
    throw new Error('unexpected require: ' + id)
  })
  const regs3 = []
  mod3.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    slots: {
      inject: (key, callback) => { regs3.key = key; callback() },
      register: (options, component) => regs3.push({ options, component }),
    },
  })
  Component = regs3[0].component
  cursor = 0
  hooks.length = 0
  effectState.length = 0
  render()
  await new Promise((resolve) => setTimeout(resolve, 5))
  check('stale offline flag repaired once the service answered', sandbox3.window.navigator.onLine === true)
  check('online event dispatched to the app', dispatched.includes('online'), dispatched.join(','))
  check('repaired page drops the offline hint', !textOf(root_node).includes('瀏覽器回報離線'), JSON.stringify(textOf(root_node)))
  check('repaired page leaves the actions usable', buttonWithText('重新啟動')?.props?.disabled === false)
}

// --- fourth scenario: a browser that refuses the override ------------------
{
  let loadedFrozen = null
  const sandbox4 = {
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: { load: (definition) => { loadedFrozen = definition } },
      location: { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/', reload: () => {}, replace: () => {} },
      navigator: Object.freeze({ onLine: false }),
      Event: class { constructor(type) { this.type = type } },
      dispatchEvent: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} },
    },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
      head: { appendChild: () => {} },
    },
    fetch: async (url) => {
      if (url === '/') return { status: 200, json: async () => ({}) }
      if (url === '/api/dsh-power/report') return { status: 204, json: async () => ({}) }
      return { json: async () => ({ ok: true, pid: '67489', port: 3080, command: 'node /x/dsh web' }) }
    },
    console,
  }
  vm.createContext(sandbox4)
  vm.runInContext(readFileSync(join(root, 'lib/client.js'), 'utf8'), sandbox4, { filename: 'client.js' })
  const mod4 = loadedFrozen.factory((id) => {
    if (id === 'react') return ReactMock
    throw new Error('unexpected require: ' + id)
  })
  const regs4 = []
  mod4.apply({
    get: () => undefined,
    effect: (fn) => fn(),
    slots: {
      inject: (key, callback) => { regs4.key = key; callback() },
      register: (options, component) => regs4.push({ options, component }),
    },
  })
  Component = regs4[0].component
  cursor = 0
  hooks.length = 0
  effectState.length = 0
  render()
  await new Promise((resolve) => setTimeout(resolve, 5))
  check('unrepairable offline flag keeps the hint', textOf(root_node).includes('瀏覽器回報離線'), JSON.stringify(textOf(root_node)))
  check('unrepairable offline flag locks the actions', buttonWithText('重新啟動')?.props?.disabled === true)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
