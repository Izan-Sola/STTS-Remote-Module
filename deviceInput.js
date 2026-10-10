// deviceInput.js
//
// Keyboard-level control of the machine the user is sitting at: which window is
// focused, the clipboard, key presses, and typing into whatever text field has
// focus (browser, Discord, Notepad, anything). Same idea as the screenshot code
// in deviceLocal.js: a table of per-platform tools, tried in order, and the one
// that worked last time goes first.
//
// Shared by the brain (the "local" device) and the web app (a remote device).
// Keep the copies identical, like deviceLocal.js.
//
// Text is never typed key by key. It goes clipboard → paste → restore clipboard:
// instant, and no keyboard-layout or unicode problems (ñ, accents, emoji).
//
// Safety lives here, on the device, so it holds no matter who calls:
//   • blockedWindows   never touched (password managers, banking)
//   • terminals        typing there needs a popup approval first
//   • confirmKeys      combos that need approval (Enter submits, Alt+F4 closes, ...)
//   • long pastes, and any call the brain flags (turn read outside content), ask first
//   • the focused window is re-checked right before pasting; if it changed, abort
//   • nothing ever presses Enter by itself
import { spawn } from 'node:child_process'

export const DEFAULT_POLICY = {
    confirm: 'risky',           // 'always' | 'risky' | 'never'
    confirmSeconds: 20,         // the popup counts as "no" after this
    confirmChars: 500,          // pastes longer than this ask first
    maxChars: 4000,
    maxKeys: 12,                // key combos per call
    settleMs: 150,              // pause after paste/copy so the app reads the clipboard before we restore it
    blind: false,               // true = allow input when the focused window can't be identified (always asks)
    // Substrings (case-insensitive) matched against "app title".
    blockedWindows: ['keepass', 'bitwarden', '1password', 'lastpass', 'proton pass', 'paypal', 'banking', 'banco'],
    // Substrings matched against the app / window class only. They also paste with Ctrl+Shift+V on Linux.
    terminals: ['terminal', 'konsole', 'kitty', 'alacritty', 'wezterm', 'xterm', 'tilix', 'ptyxis', 'foot', 'powershell', 'pwsh', 'cmd'],
    confirmKeys: ['enter', 'ctrl+enter', 'alt+f4', 'ctrl+w', 'ctrl+shift+w', 'ctrl+q', 'ctrl+alt+delete', 'super+l'],
}

const isWin = process.platform === 'win32'
const sleep = ms => new Promise(r => setTimeout(r, ms))
// status: 400 bad input · 403 blocked or declined · 409 focus changed · 501 no tool for this system
const fail = (status, message) => Object.assign(new Error(message), { status })

function session() {
    if (isWin) return 'windows'
    const t = (process.env.XDG_SESSION_TYPE || '').toLowerCase()
    if (t === 'wayland' || t === 'x11') return t
    return process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11'
}
const onGnome = () => (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase().includes('gnome')

// ─── running tools ───────────────────────────────────────────────────────
// quiet: for tools that fork into the background (wl-copy, xclip) and keep the
// pipes open. We only care that they exited cleanly, so wait for 'exit', not 'close'.
function exec(bin, args = [], { input, quiet = false, timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['pipe', quiet ? 'ignore' : 'pipe', quiet ? 'ignore' : 'pipe'] })
        let out = '', err = ''
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${bin} timed out`)) }, timeout)
        child.stdout?.on('data', d => { out += d })
        child.stderr?.on('data', d => { err += d })
        child.on('error', e => { clearTimeout(timer); reject(e) })
        child.on(quiet ? 'exit' : 'close', code => {
            clearTimeout(timer)
            if (code === 0) resolve(out)
            else reject(new Error(`${bin} exited ${code}${err.trim() ? `: ${err.trim()}` : ''}`))
        })
        child.stdin.on('error', () => { }) // tool quit before reading stdin
        child.stdin.end(input)
    })
}
const ps = (script, opts) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], opts)

// ─── strategy tables ─────────────────────────────────────────────────────
// Each table maps a tool name → async function. NAMES says which to try, in order, per session.
const working = {} // kind → tool that worked last time

const NAMES = {
    window: { windows: ['windows'], x11: ['xdotool'], wayland: ['hyprctl', 'swaymsg', 'kdotool', 'gnome-windows'] },
    key: { windows: ['windows'], x11: ['xdotool'], wayland: ['wtype', 'ydotool'] },
    // GNOME's compositor has no data-control protocol, so wl-copy pops a tiny window that can steal
    // focus. XWayland's xclip avoids that, so on GNOME it goes first.
    clipGet: { windows: ['windows'], x11: ['xclip', 'xsel'], wayland: ['wl-paste', 'xclip', 'xsel'] },
    clipSet: { windows: ['windows'], x11: ['xclip', 'xsel'], wayland: ['wl-copy', 'xclip', 'xsel'] },
}

async function attempt(kind, table, ...args) {
    let list = NAMES[kind][session()]
    if (onGnome() && session() === 'wayland' && kind.startsWith('clip')) list = [...list.slice(1), list[0]]
    const ordered = [...list].sort((a, b) => (b === working[kind]) - (a === working[kind]))
    const failures = []
    for (const name of ordered) {
        try {
            const value = await table[name](...args)
            working[kind] = name
            return value
        } catch (e) { failures.push(`${name}: ${e.message}`) }
    }
    throw fail(501, `No ${kind} tool available on this system. Tried: ${failures.join(' | ')}`)
}

// --- focused window → { id, title, app } ---
const dotool = bin => async () => {
    const id = (await exec(bin, ['getactivewindow'])).trim()
    const [title, app] = await Promise.all([
        exec(bin, ['getwindowname', id]),
        exec(bin, ['getwindowclassname', id]).catch(() => ''),
    ])
    return { id, title: title.trim(), app: app.trim() }
}

const WIN_ACTIVE = `
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class LilyWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$h = [LilyWin]::GetForegroundWindow()
$sb = New-Object Text.StringBuilder 512
[void][LilyWin]::GetWindowText($h, $sb, 512)
$procId = [uint32]0
[void][LilyWin]::GetWindowThreadProcessId($h, [ref]$procId)
@{ id = "$h"; title = $sb.ToString(); app = (Get-Process -Id $procId).ProcessName } | ConvertTo-Json -Compress`

const WINDOW = {
    xdotool: dotool('xdotool'),
    kdotool: dotool('kdotool'),
    hyprctl: async () => {
        const w = JSON.parse(await exec('hyprctl', ['activewindow', '-j']))
        if (!w.address) throw new Error('no focused window')
        return { id: w.address, title: w.title ?? '', app: w.class ?? '' }
    },
    swaymsg: async () => {
        const find = n => (n.focused && n.pid ? n : [...(n.nodes ?? []), ...(n.floating_nodes ?? [])].map(find).find(Boolean))
        const w = find(JSON.parse(await exec('swaymsg', ['-t', 'get_tree'])))
        if (!w) throw new Error('no focused window')
        return { id: String(w.id), title: w.name ?? '', app: w.app_id ?? w.window_properties?.class ?? '' }
    },
    // GNOME on Wayland has no built-in way to ask. Needs the "Window Calls" extension, or any
    // extension of yours that exposes the same D-Bus method.
    'gnome-windows': async () => {
        const out = await exec('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Extensions/Windows', '--method', 'org.gnome.Shell.Extensions.Windows.List'])
        const w = JSON.parse(out.match(/'(\[.*\])'/s)[1]).find(x => x.focus)
        if (!w) throw new Error('no focused window')
        return { id: String(w.id), title: w.title ?? '', app: w.wm_class ?? '' }
    },
    windows: async () => JSON.parse(await ps(WIN_ACTIVE)),
}

// --- clipboard (text only) ---
// "Nothing copied" is an empty clipboard, not a failure.
const EMPTY = /nothing is copied|not available|no selection/i
const orEmpty = e => (EMPTY.test(e.message) ? '' : Promise.reject(e))

const CLIP_GET = {
    'wl-paste': () => exec('wl-paste', ['--no-newline']).catch(orEmpty),
    xclip: () => exec('xclip', ['-selection', 'clipboard', '-o']).catch(orEmpty),
    xsel: () => exec('xsel', ['--clipboard', '--output']).catch(orEmpty),
    windows: () => ps('[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw').then(s => s.replace(/\r?\n$/, '')),
}
const CLIP_SET = {
    'wl-copy': t => exec('wl-copy', [], { input: t, quiet: true }),
    xclip: t => exec('xclip', ['-selection', 'clipboard'], { input: t, quiet: true }),
    xsel: t => exec('xsel', ['--clipboard', '--input'], { input: t, quiet: true }),
    windows: t => ps('[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())', { input: t }),
}

// --- keys ---
// Combos are parsed once ("ctrl+shift+v" → { mods, key, name }), then each tool encodes them its own way.
const MODS = ['alt', 'ctrl', 'shift', 'super']
const ALIAS = { control: 'ctrl', option: 'alt', meta: 'super', win: 'super', windows: 'super', cmd: 'super', return: 'enter', escape: 'esc', del: 'delete', pageup: 'pgup', pagedown: 'pgdn', spacebar: 'space' }
const XKB = { enter: 'Return', esc: 'Escape', backspace: 'BackSpace', delete: 'Delete', tab: 'Tab', space: 'space', home: 'Home', end: 'End', pgup: 'Prior', pgdn: 'Next', up: 'Up', down: 'Down', left: 'Left', right: 'Right' }
const SENDKEYS = { enter: '{ENTER}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', tab: '{TAB}', space: ' ', home: '{HOME}', end: '{END}', pgup: '{PGUP}', pgdn: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}' }
const range = (chars, from) => Object.fromEntries([...chars].map((c, i) => [c, from + i]))
// Linux evdev keycodes (ydotool). Physical keys, so shortcuts work on any layout.
const EVDEV = {
    ctrl: 29, shift: 42, alt: 56, super: 125, esc: 1, backspace: 14, tab: 15, enter: 28, space: 57,
    home: 102, up: 103, pgup: 104, left: 105, right: 106, end: 107, down: 108, pgdn: 109, delete: 111,
    ...range('1234567890', 2), ...range('qwertyuiop', 16), ...range('asdfghjkl', 30), ...range('zxcvbnm', 44),
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i + 1}`, 59 + i])), f11: 87, f12: 88,
}
const isFn = k => /^f([1-9]|1[0-2])$/.test(k)
const validKey = k => k in XKB || /^[a-z0-9]$/.test(k) || isFn(k)
const xkb = k => XKB[k] ?? (isFn(k) ? k.toUpperCase() : k)

export function parseCombo(text) {
    const parts = String(text).trim().toLowerCase().split('+').map(s => ALIAS[s.trim()] ?? s.trim()).filter(Boolean)
    const key = parts.pop()
    if (!key || !validKey(key)) throw fail(400, `Unknown key "${key ?? text}". Use letters, digits, f1-f12, enter, tab, esc, space, backspace, delete, arrows, home, end, pgup, pgdn.`)
    const bad = parts.find(m => !MODS.includes(m))
    if (bad) throw fail(400, `Unknown modifier "${bad}". Use ctrl, alt, shift, super.`)
    const mods = [...new Set(parts)].sort()
    return { mods, key, name: [...mods, key].join('+') }
}

const KEY = {
    xdotool: c => ['xdotool', ['key', '--clearmodifiers', [...c.mods, xkb(c.key)].join('+')]],
    wtype: c => {
        const m = c.mods.map(x => (x === 'super' ? 'logo' : x))
        return ['wtype', [...m.flatMap(x => ['-M', x]), '-k', xkb(c.key), ...[...m].reverse().flatMap(x => ['-m', x])]]
    },
    ydotool: c => {
        const codes = [...c.mods, c.key].map(k => EVDEV[k])
        if (codes.includes(undefined)) throw new Error(`no keycode for ${c.name}`)
        return ['ydotool', ['key', ...codes.map(x => `${x}:1`), ...[...codes].reverse().map(x => `${x}:0`)]]
    },
    windows: c => {
        if (c.mods.includes('super')) throw new Error('SendKeys cannot press the Windows key')
        const prefix = c.mods.map(m => ({ ctrl: '^', alt: '%', shift: '+' })[m]).join('')
        const token = SENDKEYS[c.key] ?? (isFn(c.key) ? `{${c.key.toUpperCase()}}` : c.key)
        return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${prefix}${token}')`]]
    },
}
const KEY_RUN = Object.fromEntries(Object.entries(KEY).map(([name, build]) => [name, async c => exec(...build(c))]))

// ─── the device's input API ──────────────────────────────────────────────
// policy:  object (or live Proxy) with any DEFAULT_POLICY keys; missing keys use the defaults.
// confirm: async (message, seconds) → true/false. Shows the Allow/Deny popup (see deviceLocal.js).
export function createInput({ policy = {}, confirm } = {}) {
    const p = k => policy[k] ?? DEFAULT_POLICY[k]
    const has = (list, text) => list.some(s => text.includes(String(s).toLowerCase()))
    const label = w => `${w.app ? `${w.app}: ` : ''}${w.title}`.trim().slice(0, 70) || 'an unknown window'
    const isTerminal = w => has(p('terminals'), w.app.toLowerCase())
    const same = (a, b) => (a.id || b.id ? a.id === b.id : a.title === b.title && a.app === b.app)
    // Windows round-trips line endings and a trailing newline differently; ignore both when comparing.
    const norm = s => s.replace(/\r\n/g, '\n').replace(/\n$/, '')
    const askKeys = () => p('confirmKeys').map(k => { try { return parseCombo(k).name } catch { return k } })

    const activeWindow = () => attempt('window', WINDOW)
    const clipboardGet = () => attempt('clipGet', CLIP_GET)
    const clipboardSet = text => attempt('clipSet', CLIP_SET, text)

    async function press(combos) {
        for (const c of combos) {
            await attempt('key', KEY_RUN, c)
            await sleep(40)
        }
    }
    function parseKeys(keys) {
        const combos = String(keys ?? '').split(/\s+/).filter(Boolean).map(parseCombo)
        if (!combos.length) throw fail(400, 'keys required')
        if (combos.length > p('maxKeys')) throw fail(400, `Too many keys at once (max ${p('maxKeys')}).`)
        return combos
    }

    // Who has focus right now? Refuses to guess unless policy.blind is on.
    async function focused() {
        let win
        try { win = await activeWindow() } catch (e) {
            if (!p('blind')) throw fail(501, `Can't tell which window is focused, so I won't type blind. (${e.message})`)
            win = { id: '', title: '', app: '', unknown: true }
        }
        win.app ??= ''
        win.title ??= ''
        if (has(p('blockedWindows'), `${win.app} ${win.title}`.toLowerCase())) {
            throw fail(403, `"${label(win)}" is a protected window (passwords or banking), so I didn't touch it.`)
        }
        return win
    }

    // Asks the user when the policy (or `reason`) says so, then makes sure focus didn't move meanwhile.
    async function approve(win, action, reason) {
        const mode = p('confirm')
        if (mode === 'never' || (mode !== 'always' && !reason && !win.unknown)) return
        const why = reason ?? (win.unknown ? 'unknown window' : 'confirm = always')
        let ok
        try { ok = await confirm(`Lily wants to ${action}\nin: ${label(win)}\n(${why})`, p('confirmSeconds')) } catch (e) {
            throw fail(501, `This needs the user's approval but no popup could be shown. (${e.message})`)
        }
        if (!ok) throw fail(403, "The user said no (or didn't answer), so nothing was done. Don't try again unless they ask.")
        await sleep(200) // let the popup close and focus return
        await assertSame(win)
    }
    async function assertSame(win) {
        const now = await activeWindow().catch(() => win)
        if (!same(win, now)) throw fail(409, `The focused window changed to "${label(now)}", so nothing was done.`)
    }

    // Puts text on the clipboard and checks it landed. Pasting a stale clipboard would be worse than failing.
    async function setClipboardChecked(text) {
        await clipboardSet(text)
        for (let i = 0; i < 4; i++) {
            if (norm(await clipboardGet().catch(() => '')) === norm(text)) return
            await sleep(60)
        }
        throw fail(500, 'The clipboard did not take the new text.')
    }
    const pasteCombo = w => (!isWin && isTerminal(w) ? 'ctrl+shift+v' : 'ctrl+v')
    const copyCombo = w => (!isWin && isTerminal(w) ? 'ctrl+shift+c' : 'ctrl+c')

    // Runs fn with the user's clipboard saved, and puts it back afterwards (text only: an image
    // on the clipboard is lost, and an empty clipboard stays holding whatever we used).
    async function keepingClipboard(fn) {
        const old = await clipboardGet().catch(() => '')
        try { return await fn() } finally { if (old) await clipboardSet(old).catch(() => { }) }
    }

    return {
        activeWindow,
        clipboardGet,
        clipboardSet,

        // Press shortcuts / navigation keys, e.g. "ctrl+a", "tab tab", "alt+tab".
        async pressKeys({ keys }) {
            const combos = parseKeys(keys)
            const win = await focused()
            const risky = combos.filter(c => askKeys().includes(c.name))
            await approve(win, `press ${combos.map(c => c.name).join(' ')}`, risky.length ? `${risky[0].name} can submit or close things` : null)
            await press(combos)
            return { pressed: combos.map(c => c.name), window: label(win) }
        },

        // Paste text at the cursor of the focused field. replace=true selects the field's content first.
        // `then` = keys to press afterwards (e.g. "tab" for the next form field).
        // force = the brain says this turn read outside content, so ask first.
        async typeText({ text, replace = false, then = '', confirm: force = false }) {
            if (typeof text !== 'string' || !text) throw fail(400, 'text required')
            if (text.length > p('maxChars')) throw fail(400, `Text too long (${text.length} > ${p('maxChars')} characters).`)
            const after = then ? parseKeys(then) : []
            const win = await focused()
            if (replace && isTerminal(win)) throw fail(400, "Can't replace a terminal's content (Ctrl+A would jump to the line start).")

            const submits = after.find(c => askKeys().includes(c.name))
            const reason = isTerminal(win) ? 'typing into a terminal'
                : submits ? `then presses ${submits.name}`
                    : text.length > p('confirmChars') ? 'long text'
                        : force ? 'this came from outside content'
                            : null
            const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text
            await approve(win, `${replace ? 'replace the text with' : 'type'}: ${preview}${after.length ? `\nthen press ${after.map(c => c.name).join(' ')}` : ''}`, reason)

            await keepingClipboard(async () => {
                await setClipboardChecked(text)
                await assertSame(win)
                if (replace) await press([parseCombo('ctrl+a')])
                await press([parseCombo(pasteCombo(win))])
                await sleep(p('settleMs'))
            })
            if (after.length) await press(after)
            return { chars: text.length, window: label(win) }
        },

        // Copy the selection (or select all, then copy) and return the text. A probe string on the
        // clipboard tells "nothing was selected" apart from "selection equals the old clipboard".
        // keepSelection=false collapses a select-all so a stray keystroke can't overwrite everything.
        async readText({ scope = 'selection', keepSelection = false } = {}) {
            if (scope !== 'selection' && scope !== 'all') throw fail(400, 'scope must be "selection" or "all"')
            const win = await focused()
            if (scope === 'all' && isTerminal(win)) throw fail(400, "Can't read a whole terminal. Ask the user to select the text first.")
            const PROBE = `\u200b__lily_probe_${Date.now()}__`
            return keepingClipboard(async () => {
                await clipboardSet(PROBE)
                if (scope === 'all') await press([parseCombo('ctrl+a')])
                await press([parseCombo(copyCombo(win))])
                await sleep(p('settleMs'))
                const got = await clipboardGet().catch(() => '')
                if (scope === 'all' && !keepSelection) await press([parseCombo('right')])
                return { text: got === PROBE ? '' : got, window: label(win) }
            })
        },
    }
}
