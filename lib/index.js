/**
 * dsh-power — host half.
 *
 * Publishes two routes on the browser HTTP carrier:
 *
 *   GET  /api/dsh-power/info   -> { ok, pid, command } for the live DSH process
 *   POST /api/dsh-power/action -> { ok, action, pid, logPath } for
 *                                 { action: 'restart' | 'shutdown' }
 *
 * The process work is delegated to a detached helper shell rather than to a
 * child this package tracks: the plugin lives inside the very process it must
 * terminate, so a subprocess the runtime owns would be reaped by the teardown
 * its own SIGTERM triggers — and then nothing would be left to start the
 * service again.
 *
 * Every destructive step is guarded: the helper refuses to signal a process
 * whose command line does not contain `dsh`, and the action is validated
 * against the two accepted strings before anything is spawned.
 *
 * @module dsh-power
 */

const INFO_PATH = '/api/dsh-power/info'
const ACTION_PATH = '/api/dsh-power/action'
const LOG_HINT = '~/.dsh/dsh-web.log'

/** Quote one value as a single-quoted POSIX shell word. */
const quote = (value) => "'" + String(value).split("'").join("'\\''") + "'"

/**
 * Detached worker: `$1` is the DSH process id, `$2` the action.
 *
 * Everything needed to bring the service back is read from the dying process
 * itself (`ps` for the command line, `lsof` for the node binary and the
 * working directory), so it returns with exactly the command it was started
 * with — never a guessed spec. Command paths resolve through PATH so this
 * works on hosts where `ps`/`lsof` are not in `/bin` and `/usr/sbin`.
 */
const WORKER = [
  'P="$1"',
  'ACTION="$2"',
  'PS=$(command -v ps || echo /bin/ps)',
  'LSOF=$(command -v lsof || echo /usr/sbin/lsof)',
  'CMD=$("$PS" -p "$P" -o command= 2>/dev/null | sed "s/^ *//")',
  'case "$CMD" in *dsh*) ;; *) exit 2 ;; esac',
  'NODE_BIN=$("$LSOF" -a -p "$P" -d txt -Fn 2>/dev/null | sed -n "s/^n//p" | grep -v "^/usr/lib/dyld$" | head -1)',
  'ARGS=${CMD#* }',
  'DIR=$("$LSOF" -a -p "$P" -d cwd -Fn 2>/dev/null | sed -n "s/^n//p" | head -1)',
  'LOG="${DSH_HOME:-$HOME/.dsh}/dsh-web.log"',
  'sleep 1',
  'kill -TERM "$P" 2>/dev/null',
  'i=0',
  'while [ "$i" -lt 80 ] && kill -0 "$P" 2>/dev/null; do sleep 0.25; i=$((i+1)); done',
  'kill -KILL "$P" 2>/dev/null',
  '[ "$ACTION" = "restart" ] || exit 0',
  'sleep 0.5',
  'mkdir -p "${DSH_HOME:-$HOME/.dsh}" 2>/dev/null',
  'cd "$DIR" 2>/dev/null || cd "$HOME"',
  'if [ -n "$NODE_BIN" ] && [ -n "$ARGS" ]; then exec "$NODE_BIN" $ARGS >>"$LOG" 2>&1; fi',
  'exit 3',
].join('\n')

/**
 * Launcher spawned as this process's direct child. It reports its own parent
 * (`$PPID` — this DSH process) and starts the worker in a new session, so the
 * worker outlives the teardown its own signal causes.
 *
 * @param action - validated `restart` or `shutdown`.
 * @returns the shell script to run.
 */
const launcher = (action) => [
  'P=$PPID',
  'ACTION=' + quote(action),
  'PERL=$(command -v perl 2>/dev/null || true)',
  'if [ -n "$PERL" ]; then',
  '  nohup "$PERL" -MPOSIX -e "POSIX::setsid(); exec @ARGV or exit 1" /bin/sh -c ' + quote(WORKER) + ' dsh-power "$P" "$ACTION" >/dev/null 2>&1 </dev/null &',
  'else',
  '  nohup /bin/sh -c ' + quote(WORKER) + ' dsh-power "$P" "$ACTION" >/dev/null 2>&1 </dev/null &',
  'fi',
  'sleep 0.2',
  'exit 0',
].join('\n')

/** Read this process's pid and command line from an unconfined child shell. */
const PROBE = 'PS=$(command -v ps || echo /bin/ps); echo "$PPID"; "$PS" -p "$PPID" -o command='

export const inject = ['webServer']

/**
 * Register the two routes for this plugin's lifetime.
 * @param ctx - the plugin context; `webServer` is a declared dependency.
 */
export function apply(ctx) {
  const subprocess = ctx.get('subprocess')

  const spawnHelper = (argv, stdio, graceMs) => {
    const handle = subprocess.spawn({ argv, cwd: '/', stdio, graceMs })
    handle.done.then(() => undefined, () => undefined)
    return handle
  }

  const probe = async () => {
    if (subprocess === undefined) return null
    try {
      const handle = spawnHelper(
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
      if (subprocess === undefined) return send(res, 200, { ok: false, message: '此環境沒有 subprocess 服務。' })
      const info = await probe()
      if (info === null) return send(res, 200, { ok: false, message: '無法讀取目前 DSH 行程資訊。' })
      return send(res, 200, { ok: true, pid: info.pid, command: info.command })
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
      const info = await probe()
      if (info === null) return send(res, 500, { ok: false, message: '無法讀取目前 DSH 行程資訊，已取消操作。' })
      if (info.command.indexOf('dsh') < 0) return send(res, 500, { ok: false, message: '目標行程不是 DSH：' + info.command })
      try {
        spawnHelper(['/bin/sh', '-c', launcher(action)], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }, 3000)
      } catch (error) {
        return send(res, 500, { ok: false, message: String((error && error.message) || error) })
      }
      ctx.logger?.info?.('dsh-power: %s requested for pid %s', action, info.pid)
      return send(res, 200, { ok: true, action, pid: info.pid, logPath: LOG_HINT })
    },
  }), 'dsh-power: action route')
}
