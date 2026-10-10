// deviceLocal.js
//
// Everything that touches the machine the user is sitting at: screenshot,
// popups, typing/keys/clipboard (deviceInput.js), VS Code companion, pi.
// No brain dependencies.
//
// This file and deviceInput.js are used in two places (keep the copies identical):
//   • brain   (discord/tools/deviceLocal.js) → "local" device = the minipc
//   • web app (deviceLocal.js)               → serves the laptop to the brain
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInput } from './deviceInput.js'

const run = promisify(execFile)

// Default gate extension location: lily-gate.ts next to this file.
const DEFAULT_GATE_EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lily-gate.ts')

const DEFAULTS = {
    screenshotMs: 10_000, fileAppearMs: 3000, fileAppearPollMs: 100,
    askUserMs: 120_000, piMs: 180_000, companionRequestMs: 10_000, gateLoadMs: 8000,
}

const isWin = process.platform === 'win32'
const desktop = () => ({
    de: (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase(),
    wayland: (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland',
})
const cancelled = () => Object.assign(new Error('cancelled'), { cancelled: true })

// ─── screenshot ──────────────────────────────────────────────────────────
// name -> (outPath) => [bin, args]
const SHOT = {
    'gnome-dbus': o => ['gdbus', ['call', '--session', '--dest', 'org.gnome.Shell.Screenshot', '--object-path', '/org/gnome/Shell/Screenshot', '--method', 'org.gnome.Shell.Screenshot.Screenshot', 'false', 'false', o]],
    'gnome-screenshot': o => ['gnome-screenshot', ['-f', o]],
    spectacle: o => ['spectacle', ['-b', '-n', '-o', o]],
    grim: o => ['grim', [o]],
    scrot: o => ['scrot', ['-o', o]],
    maim: o => ['maim', [o]],
    import: o => ['import', ['-window', 'root', o]],
}

const winShot = (o) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
    `$bmp.Save('${o.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
].join('\n')]]

// Desktop-specific tool first, then everything else as fallback.
function shotStrategies(o) {
    if (isWin) return [['windows', winShot(o)]]
    const { de, wayland } = desktop()
    const first = de.includes('gnome') ? ['gnome-dbus', 'gnome-screenshot']
        : de.includes('kde') || de.includes('plasma') ? ['spectacle']
            : wayland ? ['grim'] : []
    return [...new Set([...first, ...Object.keys(SHOT)])]
        .filter(n => n !== 'grim' || wayland)
        .map(n => [n, SHOT[n](o)])
}

async function waitForFile(file, timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs
    let last = -1, stable = 0
    while (Date.now() < deadline) {
        try {
            const { size } = await stat(file)
            if (size > 0) {
                if (size === last) { if (++stable >= 2) return true } else { stable = 0; last = size }
            }
        } catch { /* not there yet */ }
        await new Promise(r => setTimeout(r, pollMs))
    }
    return false
}

// ─── input popup ─────────────────────────────────────────────────────────
const TITLE = 'Lily needs your input'
const ASK = {
    kdialog: p => ['kdialog', ['--title', TITLE, '--inputbox', p]],
    zenity: p => ['zenity', ['--entry', `--title=${TITLE}`, `--text=${p}`]],
}
const WIN_ASK = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `Write-Output ([Microsoft.VisualBasic.Interaction]::InputBox($env:LILY_ASK_PROMPT, "${TITLE}", ""))`,
].join('\n')

// ─── allow/deny popup ────────────────────────────────────────────────────
// Used by the typing safety checks. Resolves true (Allow) or false (Deny, closed, or timed out).
const CONFIRM_TITLE = 'Lily is asking permission'
const CONFIRM = {
    zenity: (m, s) => ['zenity', ['--question', '--no-markup', `--title=${CONFIRM_TITLE}`, `--text=${m}`, `--timeout=${s}`, '--ok-label=Allow', '--cancel-label=Deny']],
    kdialog: m => ['kdialog', ['--title', CONFIRM_TITLE, '--warningyesno', m, '--yes-label', 'Allow', '--no-label', 'Deny']],
}
const WIN_CONFIRM = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `Write-Output ([System.Windows.Forms.MessageBox]::Show($env:LILY_CONFIRM_MSG, "${CONFIRM_TITLE}", 'YesNo', 'Warning', 'Button2'))`,
].join('\n')

async function confirm(message, seconds = 20) {
    const cmds = isWin
        ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_CONFIRM], { env: { ...process.env, LILY_CONFIRM_MSG: message } }]]
        : (desktop().de.includes('kde') ? ['kdialog', 'zenity'] : ['zenity', 'kdialog']).map(n => [...CONFIRM[n](message, seconds), {}])
    const failures = []
    for (const [bin, args, extra] of cmds) {
        try {
            const { stdout } = await run(bin, args, { timeout: (seconds + 5) * 1000, ...extra })
            return isWin ? /yes/i.test(stdout) : true
        } catch (e) {
            if (e.killed || e.code === 1 || e.code === 5) return false // Deny, or no answer in time
            failures.push(`${bin}: ${e.message}`)
        }
    }
    throw new Error(`No confirmation popup tool available. Tried: ${failures.join(' | ')}`)
}

// ─── companion (VS Code extension on this machine) ───────────────────────
async function companion(base, ms, method, route, body) {
    const res = await fetch(base + route, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(ms),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status })
    return data
}

// ─── the device ──────────────────────────────────────────────────────────
// timeouts: object (or live Proxy) with the keys in DEFAULTS; missing keys fall back.
// input: typing policy (object or live Proxy, see DEFAULT_POLICY in deviceInput.js).
// gate: { url, token, deviceId, extensionPath? } -> brain approval endpoint + lily-gate.ts.
//   extensionPath is optional and defaults to ./lily-gate.ts next to this file.
//   Without it runPi refuses to run (pi runs with --perm yolo, so it must never run ungated).
export function createLocalDevice({ timeouts = {}, companionUrl = 'http://localhost:8768', gate = null, input = {} } = {}) {
    const t = k => timeouts[k] ?? DEFAULTS[k]
    if (gate) gate = { ...gate, extensionPath: gate.extensionPath ?? DEFAULT_GATE_EXT }
    const ext = (method, route, body) => companion(companionUrl, t('companionRequestMs'), method, route, body)

    return {
        // activeWindow, clipboardGet/Set, pressKeys, typeText, readText
        ...createInput({ policy: input, confirm }),

        async screenshot() {
            const dir = await mkdtemp(path.join(tmpdir(), 'lily-shot-'))
            const file = path.join(dir, 'screenshot.png')
            const failures = []
            try {
                for (const [name, [bin, args]] of shotStrategies(file)) {
                    try {
                        const { stdout } = await run(bin, args, { timeout: t('screenshotMs') })
                        if (name === 'gnome-dbus' && !/^\(true,/.test(stdout.trim())) {
                            throw new Error(`gnome-shell reported failure: ${stdout.trim()}`)
                        }
                    } catch (e) { failures.push(`${name}: ${e.message}`); continue }

                    if (await waitForFile(file, t('fileAppearMs'), t('fileAppearPollMs'))) {
                        return { buffer: await readFile(file), via: name }
                    }
                    failures.push(`${name}: exited cleanly but no file appeared`)
                }
                throw new Error(`No screenshot tool available. Tried: ${failures.join(' | ')}`)
            } finally {
                await rm(dir, { recursive: true, force: true }).catch(() => { })
            }
        },

        // Resolves with the typed text; rejects with {cancelled:true} if the user closes it.
        async askUser(prompt) {
            const cmds = isWin
                ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_ASK], { env: { ...process.env, LILY_ASK_PROMPT: prompt } }]]
                : (desktop().de.includes('kde') ? ['kdialog', 'zenity'] : ['zenity', 'kdialog']).map(n => [...ASK[n](prompt), {}])
            const failures = []
            for (const [bin, args, extra] of cmds) {
                try {
                    const { stdout } = await run(bin, args, { timeout: t('askUserMs'), ...extra })
                    const value = stdout.trim()
                    if (!value) throw cancelled()
                    return value
                } catch (e) {
                    if (e.cancelled || (e.code === 1 && !e.killed)) throw cancelled()
                    failures.push(`${bin}: ${e.message}`)
                }
            }
            throw new Error(`No input-popup tool available. Tried: ${failures.join(' | ')}`)
        },

        activeFile: () => ext('GET', '/active-file'),
        applyEdit: (filePath, content) => ext('POST', '/apply-edit', { path: filePath, content }),
        createFile: (filePath, content, overwrite) => ext('POST', '/create-file', { path: filePath, content: content ?? '', overwrite: !!overwrite }),

        runPi(prompt) {
            return new Promise((resolve, reject) => {
                if (!gate?.url || !gate?.token || !gate?.deviceId || !gate?.extensionPath) return reject(new Error('approval gate not configured, refusing to run pi'))
                if (!existsSync(gate.extensionPath)) return reject(new Error(`approval gate extension missing: ${gate.extensionPath}`))

                const sentinel = path.join(tmpdir(), `lily-gate-${randomUUID()}`)
                const child = spawn('pi', ['--perm', 'yolo', '-e', gate.extensionPath, '-p', prompt], {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        LILY_GATE_URL: gate.url,
                        LILY_GATE_TOKEN: gate.token,
                        LILY_GATE_DEVICE: gate.deviceId,
                        LILY_GATE_SENTINEL: sentinel,
                    },
                })
                let out = '', err = '', gateFailed = false
                child.stdout.on('data', d => { out += d })
                child.stderr.on('data', d => { err += d })

                // --perm yolo + a gate that silently failed to load = ungated shell. Kill pi if the handshake never shows up.
                const started = Date.now()
                const watchdog = setInterval(() => {
                    if (existsSync(sentinel)) return clearInterval(watchdog)
                    if (Date.now() - started > t('gateLoadMs')) {
                        clearInterval(watchdog)
                        gateFailed = true
                        child.kill('SIGKILL')
                    }
                }, 200)

                const cleanup = () => { clearTimeout(timer); clearInterval(watchdog); rm(sentinel, { force: true }).catch(() => { }) }
                const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timeout')) }, t('piMs'))
                child.on('error', e => { cleanup(); reject(e) })
                child.on('close', code => {
                    cleanup()
                    if (gateFailed) return reject(new Error('approval gate failed to load, pi was stopped'))
                    if (code === 0) resolve(out.trim() || err.trim())
                    else reject(new Error(err.trim() || `pi exited with code ${code}`))
                })
            })
        },
    }
}