'use strict'
/**
 * dsh-power — platform primitives for the restart worker.
 *
 * The worker asks the operating system exactly two questions, and both are
 * answered differently per platform:
 *
 *   - which pids hold a listening port (POSIX `lsof`; Windows
 *     `Get-NetTCPConnection`, with `netstat` as the fallback), and
 *   - what one pid's command line is (POSIX `ps`; Windows `Get-CimInstance`,
 *     with `wmic` as the fallback).
 *
 * The Windows answers are the delicate ones, which is why they live here with
 * tests instead of inline in the worker:
 *
 *   - `wmic` is deprecated and missing from recent Windows builds, and
 *     `netstat` prints a **localized** state word. Neither may be read by
 *     matching English text. The netstat fallback therefore reads columns by
 *     position and recognizes a listening socket by its *zero foreign port*
 *     (a socket that accepts connections has no peer), which no locale can
 *     change and which also keeps a lingering ESTABLISHED or TIME_WAIT row
 *     from being mistaken for a listener.
 *   - PowerShell is invoked with `-EncodedCommand`, so the script never has to
 *     survive a trip through cmd.exe quoting.
 *   - Every probe runs with `windowsHide` — a console window flashing on the
 *     desktop every few hundred milliseconds while a restart polls a port is
 *     exactly the kind of thing that makes a plugin feel broken.
 *
 * Each entry point takes its process runner as an option, so the parsers and
 * the fallback order are testable on any platform.
 *
 * @module dsh-power/platform
 */

const { execFile } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { promisify } = require('node:util')

const run = promisify(execFile)

/** Bounded, quiet, windowless: every probe gets these. */
const PROBE_OPTIONS = {
  timeout: 10000,
  maxBuffer: 1 << 20,
  windowsHide: true,
}

/**
 * Command words that mark a process as part of this harness. The worker only
 * ever stops a process whose command line says it belongs to DSH — the port
 * number alone is never permission to kill something.
 */
const DSH_MARKERS = ['dsh', 'deepseek-harness', '@deepseek-ai']

/** Run one probe and resolve to its stdout; rejects when the command fails. */
const defaultExec = async (file, args) => (await run(file, args, PROBE_OPTIONS)).stdout

/**
 * An absolute path to a Windows system program, so a stripped-down PATH cannot
 * hide it.
 *
 * @param segments - path segments below the Windows directory.
 * @param fallback - the bare name to use when the absolute path is absent.
 * @returns the program to execute.
 */
function systemProgram(segments, fallback) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const absolute = join(root, ...segments)
  return existsSync(absolute) ? absolute : fallback
}

/** The PowerShell to use: the system copy when it is there. */
const powershellPath = () => systemProgram(['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'], 'powershell.exe')

/** The netstat to use: the system copy when it is there. */
const netstatPath = () => systemProgram(['System32', 'netstat.exe'], 'netstat')

/**
 * PowerShell arguments for one script, encoded as UTF-16LE base64.
 *
 * `-EncodedCommand` sidesteps the quoting rules of cmd.exe and of PowerShell's
 * own `-Command` parser, so a script with quotes, semicolons and `$` in it
 * arrives intact.
 *
 * @param script - the PowerShell source to run.
 * @returns the argument vector.
 */
const powerShellArgs = (script) => [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(script, 'utf16le').toString('base64'),
]

/**
 * PowerShell that prints the pid of every listening socket on one port, one per
 * line and nothing when the port is free.
 *
 * @param port - the port to inspect.
 * @returns the script.
 */
const listenersScript = (port) => [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '(Get-NetTCPConnection -State Listen -LocalPort ' + port + ' -ErrorAction Stop).OwningProcess',
].join('; ')

/**
 * PowerShell that prints one pid's command line, or nothing when the process is
 * already gone.
 *
 * @param pid - the process to describe.
 * @returns the script.
 */
const commandLineScript = (pid) => [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=" + pid + "' -ErrorAction Stop).CommandLine",
].join('; ')

/**
 * Pids from one-per-line output, ignoring blanks, headers, labels and pid 0.
 *
 * @param text - raw stdout.
 * @returns the pids, as strings, without duplicates.
 */
function parsePidLines(text) {
  const pids = new Set()
  for (const line of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
    const pid = line.trim()
    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid)
  }
  return [...pids]
}

/**
 * Pids listening on `port`, from `netstat -ano -p TCP` output.
 *
 * Nothing here matches English: a listening row is recognized by its columns —
 * a five-field row whose local address ends in `:port` and whose foreign
 * address ends in `:0`. Established, close-wait and time-wait rows all carry a
 * real foreign port, so a lingering connection can never be read as a listener.
 *
 * @param text - raw netstat output.
 * @param port - the port to inspect.
 * @returns the pids, as strings, without duplicates.
 */
function parseWindowsNetstat(text, port) {
  const pids = new Set()
  const local = ':' + Number(port)
  for (const line of String(text === undefined || text === null ? '' : text).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 5) continue
    if (!fields[1].endsWith(local) || !fields[2].endsWith(':0')) continue
    if (!/^\d+$/.test(fields[4]) || fields[4] === '0') continue
    pids.add(fields[4])
  }
  return [...pids]
}

/**
 * Command line from `wmic process where processid=<pid> get commandline`: a
 * header line, the value (which wmic wraps at the console width), then blanks.
 *
 * @param text - raw wmic output.
 * @returns the command line, or '' when the process was not found.
 */
function parseWmicCommandLine(text) {
  const lines = String(text === undefined || text === null ? '' : text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length > 0 && /^commandline$/i.test(lines[0])) lines.shift()
  const joined = lines.join(' ').trim()
  return /^no instance\(s\) available\.?$/i.test(joined) ? '' : joined
}

/**
 * Pids holding the listening socket for `port`.
 *
 * Failure to answer is reported as "no listeners" — that is what the worker's
 * own TCP cross-check exists for.
 *
 * @param options - platform, port, and an optional process runner.
 * @returns the pids, as strings.
 */
async function listenersOf(options) {
  const platform = options.platform
  const port = Number(options.port)
  const exec = options.exec === undefined ? defaultExec : options.exec
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return []

  if (platform === 'win32') {
    try {
      return parsePidLines(await exec(powershellPath(), powerShellArgs(listenersScript(port))))
    } catch (error) {
      /* no PowerShell, no NetTCPIP module, or a policy that blocks cmdlets */
    }
    try {
      return parseWindowsNetstat(await exec(netstatPath(), ['-ano', '-p', 'TCP']), port)
    } catch (error) {
      return []
    }
  }

  try {
    return parsePidLines(await exec('lsof', ['-nP', '-ti', 'tcp:' + port, '-sTCP:LISTEN']))
  } catch (error) {
    return []
  }
}

/**
 * One pid's command line, or '' when it is gone or unreadable.
 *
 * @param options - platform, pid, and an optional process runner.
 * @returns the command line.
 */
async function commandOf(options) {
  const platform = options.platform
  const pid = String(options.pid === undefined || options.pid === null ? '' : options.pid)
  const exec = options.exec === undefined ? defaultExec : options.exec
  if (!/^\d+$/.test(pid)) return ''

  if (platform === 'win32') {
    try {
      return String(await exec(powershellPath(), powerShellArgs(commandLineScript(pid)))).trim()
    } catch (error) {
      /* fall through to the pre-CIM tool */
    }
    try {
      return parseWmicCommandLine(await exec('wmic', ['process', 'where', 'processid=' + pid, 'get', 'commandline']))
    } catch (error) {
      return ''
    }
  }

  try {
    return String(await exec('ps', ['-p', pid, '-o', 'command='])).trim()
  } catch (error) {
    return ''
  }
}

/**
 * Whether a command line belongs to this harness.
 *
 * Windows command lines carry DOS-style paths, and a path may be spelled in any
 * case, so the comparison is case-insensitive; a bare 'dsh' is enough because
 * the package is `@deepseek-ai/dsh` and a checkout is usually `deepseek-harness`.
 *
 * @param command - a command line, as the OS reported it.
 * @returns true when the process is one this plugin may stop.
 */
function isDshCommand(command) {
  const text = String(command === undefined || command === null ? '' : command).toLowerCase()
  if (text === '') return false
  return DSH_MARKERS.some((marker) => text.includes(marker))
}

module.exports = {
  listenersOf,
  commandOf,
  isDshCommand,
  // exported for tests and for anything that needs the raw pieces
  parsePidLines,
  parseWindowsNetstat,
  parseWmicCommandLine,
  powerShellArgs,
  listenersScript,
  commandLineScript,
  powershellPath,
  netstatPath,
}
