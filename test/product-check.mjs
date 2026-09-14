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
import { readFileSync } from 'node:fs'
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

// --- restart worker -------------------------------------------------------
const workerSource = readFileSync(join(root, 'lib/restart.cjs'), 'utf8')
check('worker parses', (() => {
  try { new vm.Script(workerSource, { filename: 'restart.cjs' }); return true } catch (error) {
    console.log('  worker parse error:', error.message)
    return false
  }
})())
check('worker reads its config from argv', workerSource.includes('Buffer.from(process.argv[2]'))
check('worker treats the port as authority', workerSource.includes('listenersOf(port)'))
check('worker verifies the relaunch', workerSource.includes('waitPortUp'))
check('worker refuses non-dsh holders', workerSource.includes("command.includes('dsh')"))
check('worker log failure is non-fatal', workerSource.includes('cannot open log file'))

// --- browser half ---------------------------------------------------------
const calls = []
let loaded = null
let loadedUnauth = null
let reloaded = false
let replaced = null
let acted = false
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
    if (url === '/') return { status: 200, json: async () => ({}) }
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
  const sandbox3 = {
    setTimeout,
    clearTimeout,
    window: {
      __ModuleLoader__: { load: (definition) => { loadedOffline = definition } },
      location: { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/', reload: () => {}, replace: () => {} },
      navigator: { onLine: false },
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
  check('offline machine explains the reconnect prompt', textOf(root_node).includes('作業系統回報沒有網路'), JSON.stringify(textOf(root_node)))
  check('offline machine locks the actions', buttonWithText('重新啟動')?.props?.disabled === true)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
