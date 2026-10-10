// remote.js
//
// Two jobs, both optional (nothing changes until config.json "brain" is set):
//
//   deviceRouter()  → /device/<op>: lets the brain use THIS machine's screen, typing,
//                     keys, clipboard, VS Code companion, popup and pi. Requires brain.token.
//   activity        → one event per device op, so the UI can show what Lily just did.
//   brainPrompt()   → replaces the local `pi -p` run: sends the transcript to
//                     the brain, streams the reply back in the same SSE shape
//                     the frontend already understands.
import { Router } from 'express'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import cfg from './config.js'
import { createLocalDevice } from './deviceLocal.js'

const local = createLocalDevice({
    // live view of config.json "timeouts" so edits apply without a restart
    timeouts: new Proxy({}, { get: (_, k) => cfg.timeouts?.[k] }),
    companionUrl: process.env.VSCODE_COMPANION_URL || cfg.companionUrl || 'http://localhost:8768',
    // live view of config.json "input" (typing policy); anything unset uses the defaults in deviceInput.js
    input: new Proxy({}, { get: (_, k) => cfg.input?.[k] }),
    gate: {
        url: new URL(cfg.brain.url).origin,
        token: cfg.brain.token,
        deviceId: cfg.brain.deviceId,
    },
})

export const activity = new EventEmitter()

// op → handler(body) → JSON
const OPS = {
    screenshot: async () => {
        const { buffer, via } = await local.screenshot()
        return { base64: buffer.toString('base64'), via }
    },
    ask: async ({ prompt }) => {
        try { return { value: await local.askUser(prompt) } }
        catch (e) { if (e.cancelled) return { cancelled: true }; throw e }
    },
    'active-file': () => local.activeFile(),
    'apply-edit': ({ path, content }) => local.applyEdit(path, content),
    'create-file': ({ path, content, overwrite }) => local.createFile(path, content, overwrite),
    pi: async ({ prompt }) => ({ output: await local.runPi(prompt) }),

    // typing anywhere (see deviceInput.js for the safety rules, they are enforced here on the device)
    'active-window': () => local.activeWindow(),
    'read-text': ({ scope, keepSelection }) => local.readText({ scope, keepSelection }),
    'type-text': ({ text, replace, then, confirm }) => local.typeText({ text, replace, then, confirm }),
    'press-keys': ({ keys }) => local.pressKeys({ keys }),
    clipboard: async ({ action, text }) => {
        if (action === 'set') { await local.clipboardSet(String(text ?? '')); return { ok: true } }
        return { text: await local.clipboardGet() }
    },
}

// One line per op for the UI's activity feed: (request body, result) → text
const SUMMARY = {
    screenshot: (_b, o) => `📸 screenshot via ${o.via}`,
    ask: b => `💬 asked you: ${b.prompt}`,
    pi: () => '🛠️ ran pi',
    'active-window': (_b, o) => `🪟 focused: ${o.title}`,
    'read-text': (_b, o) => `👀 read ${o.text.length} chars from ${o.window}`,
    'type-text': (_b, o) => `⌨️ typed ${o.chars} chars into ${o.window}`,
    'press-keys': (_b, o) => `⌨️ pressed ${o.pressed.join(' ')} in ${o.window}`,
    clipboard: b => `📋 clipboard ${b.action === 'set' ? 'written' : 'read'}`,
}

function authorized(req) {
    const want = cfg.brain?.token
    if (!want) return false // no token configured → device endpoints stay closed
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
    const key = Buffer.from(want)
    return given.length === key.length && crypto.timingSafeEqual(given, key)
}

export function deviceRouter() {
    const router = Router()
    router.use((req, res, next) => authorized(req) ? next() : res.status(401).json({ error: 'unauthorized' }))
    router.post('/:op', async (req, res) => {
        const name = req.params.op
        const op = OPS[name]
        if (!op) return res.status(404).json({ error: 'unknown op' })
        const body = req.body ?? {}
        const started = Date.now()
        const note = (ok, text) => activity.emit('op', { op: name, ok, text, ms: Date.now() - started })
        try {
            const out = await op(body)
            note(true, SUMMARY[name]?.(body, out) ?? name)
            res.json(out)
        } catch (e) {
            note(false, `⚠️ ${name}: ${e.message}`)
            res.status(e.status || 500).json({ error: e.message })
        }
    })
    return router
}

export async function brainPrompt(req, res) {
    const text = (req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'no text' })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.flushHeaders?.()
    const send = (event, data) => !res.writableEnded && res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

    const ac = new AbortController()
    res.on('close', () => ac.abort())

    send('start', { prompt: text })
    try {
        const { url, token, deviceId, timeoutMs = 660_000 } = cfg.brain
        const r = await fetch(`${url.replace(/\/$/, '')}/turn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ text, deviceId }),
            signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]),
        })
        const data = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(data.error || `brain HTTP ${r.status}`)
        send('chunk', { text: data.reply ?? '' })
        send('done', { code: 0 })
    } catch (e) {
        if (e.name !== 'AbortError') send('error', { message: `brain: ${e.message}` })
    }
    res.end()
}