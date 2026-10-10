// server/index.js
//
// STTS web app backend.
// Endpoints:
//   GET  /api/health          – status of whisper + pi + edge-tts
//   GET  /api/events          – SSE: what the brain just did on this machine (screenshots, typing, keys...)
//   POST /api/transcribe      – multipart audio → whisper → { text }
//   POST /api/prompt          – { text } → SSE stream (brain reply if "brain" is set, else `pi -p <text>`)
//   POST /device/<op>         – brain → this machine (screenshot, typing, keys, clipboard, VS Code, ask, pi); token-protected
//   POST /api/speak           – { text } → audio/mpeg stream (edge-tts)
//
// Listeners: the UI (/api/*) binds to config "host"; /device/* binds to "deviceHost" when that differs.
// Typing into the machine makes an open UI port a real risk, so the safe setup is
//   "host": "127.0.0.1"   (UI only on this machine, reach it from a phone via `tailscale serve`)
//   "deviceHost": "<this machine's tailscale IP>"   (just /device/*, token-protected, for the brain)
// Leave both unset and one listener on 0.0.0.0 serves everything, as before.
//
// All config lives in ../config.json — see server/config.js. Optional env:
//   PI_EXTRA_ARGS   extra flags for pi, e.g. PI_EXTRA_ARGS="--yolo"

import express from 'express'
import multer from 'multer'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import cfg, { whisperHealthUrl } from './config.js'
import { deviceRouter, brainPrompt, activity } from './remote.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
})

app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.join(__dirname, '.', 'public')))

// ─── logging helpers ──────────────────────────────────────────
const ts = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log(`[${ts()}]`, ...a)
const preview = (s, n = 160) => JSON.stringify(String(s).slice(0, n))


// ─── /api/health ──────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
    let whisperOk = false
    let whisperInfo = null
    try {
        const r = await fetch(whisperHealthUrl(), {
            signal: AbortSignal.timeout(cfg.whisper.healthTimeoutMs),
        })
        whisperOk = r.ok
        if (r.ok) whisperInfo = await r.json()
    } catch { /* whisper down or slow */ }

    res.json({
        ok: true,
        whisper: { ok: whisperOk, url: cfg.whisper.url, info: whisperInfo },
        edgeTts: { voice: cfg.tts.voice, rate: cfg.tts.rate },
        pi: { bin: cfg.pi.bin, cwd: cfg.pi.cwd || os.homedir(), timeoutMs: cfg.pi.timeoutMs },
        wakeWord: { required: cfg.wake.required, words: cfg.wake.words, leadingOnly: cfg.wake.leadingOnly ?? [] },
    })
})

// ─── /api/events (SSE) ────────────────────────────────────────
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.flushHeaders?.()
    const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`)
    activity.on('op', send)
    req.on('close', () => activity.off('op', send))
})

// ─── /api/transcribe ──────────────────────────────────────────
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no audio field' })
    const startedAt = Date.now()
    log(`[transcribe] ${req.file.size}B ${req.file.mimetype || '?'}`)
    try {
        const fd = new FormData()
        fd.append(
            'file',
            new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' }),
            req.file.originalname || 'speech.wav',
        )
        const r = await fetch(cfg.whisper.url, {
            method: 'POST',
            body: fd,
            signal: AbortSignal.timeout(cfg.whisper.requestTimeoutMs),
        })
        if (!r.ok) {
            const t = await r.text().catch(() => '')
            log(`[transcribe] whisper ${r.status}: ${t.slice(0, 200)}`)
            return res.status(502).json({ error: `whisper ${r.status}: ${t}` })
        }
        const data = await r.json()
        const out = (data.text || '').trim()
        log(`[transcribe] ok in ${((Date.now() - startedAt) / 1000).toFixed(1)}s:`, preview(out, 120))
        res.json({ text: out, raw: data })
    } catch (e) {
        log('[transcribe] failed:', e.message)
        res.status(500).json({ error: e.message })
    }
})

// ─── remote mode ──────────────────────────────────────────────
// brain.url set  → prompts go to the brain; it calls back into /device/* for
//                  screenshots, VS Code and pi on THIS machine.
// brain.url unset → falls through to the local `pi -p` handler below.
app.post('/api/prompt', (req, res, next) => cfg.brain?.url ? brainPrompt(req, res) : next())

// ─── /api/prompt (SSE) ────────────────────────────────────────
app.post('/api/prompt', (req, res) => {
    const rid = Math.random().toString(36).slice(2, 6)
    const L = (...a) => log(`[prompt ${rid}]`, ...a)

    const text = (req.body?.text || '').trim()
    if (!text) {
        L('rejected: empty text')
        return res.status(400).json({ error: 'no text' })
    }
    L('request:', preview(text, 120))

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const send = (event, data) => {
        if (res.writableEnded || res.destroyed) return false
        res.write(`event: ${event}\n`)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
        return true
    }

    const extra = cfg.pi.extraArgs
        ?? (process.env.PI_EXTRA_ARGS ? process.env.PI_EXTRA_ARGS.split(/\s+/).filter(Boolean) : [])
    const args = ['-p', ...extra, text]
    const cwd = cfg.pi.cwd || os.homedir()
    L(`spawn: ${cfg.pi.bin} ${args.map(a => (a === text ? '<prompt>' : a)).join(' ')}  (cwd=${cwd}, timeout=${cfg.pi.timeoutMs}ms)`)

    send('start', { prompt: text })

    const startedAt = Date.now()
    const secs = () => ((Date.now() - startedAt) / 1000).toFixed(1)

    const child = spawn(cfg.pi.bin, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    L('pid:', child.pid ?? '(spawn failed)')

    let done = false
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let firstOutputAt = null
    let stderrBuf = ''

    const cleanup = () => {
        clearTimeout(timeoutTimer)
        clearInterval(heartbeat)
    }

    const heartbeat = setInterval(() => {
        const first = firstOutputAt ? `first output after ${((firstOutputAt - startedAt) / 1000).toFixed(1)}s` : 'NO output yet'
        L(`still running ${secs()}s | stdout=${stdoutBytes}B stderr=${stderrBytes}B | ${first}`)
        if (!firstOutputAt && Date.now() - startedAt > 15_000) {
            L('hint: no output for 15s+. If pi is waiting on a tool-confirmation prompt (no TTY here), run with PI_EXTRA_ARGS="--yolo".')
        }
    }, 5000)

    const timeoutTimer = setTimeout(() => {
        if (done) return
        L(`TIMEOUT after ${cfg.pi.timeoutMs}ms, killing pi`)
        send('error', { message: `pi timed out after ${cfg.pi.timeoutMs}ms` })
        try { child.kill('SIGTERM') } catch { }
        setTimeout(() => { try { child.kill('SIGKILL') } catch { } }, 3000)
        // Last resort: never leave the browser waiting on an open stream.
        setTimeout(() => {
            if (!res.writableEnded) {
                L('force-ending response after timeout')
                done = true
                cleanup()
                res.end()
            }
        }, 5000)
    }, cfg.pi.timeoutMs)

    child.stdout.on('data', (d) => {
        const s = d.toString('utf8')
        if (!firstOutputAt) {
            firstOutputAt = Date.now()
            L(`first stdout after ${secs()}s:`, preview(s, 120))
        }
        stdoutBytes += d.length
        stdout += s
        send('chunk', { text: s })
    })

    child.stderr.on('data', (d) => {
        const s = d.toString('utf8')
        if (!firstOutputAt) firstOutputAt = Date.now()
        stderrBytes += d.length
        stderr += s
        stderrBuf += s
        let nl
        while ((nl = stderrBuf.indexOf('\n')) !== -1) {
            const line = stderrBuf.slice(0, nl).trimEnd()
            stderrBuf = stderrBuf.slice(nl + 1)
            if (line) L('stderr:', line.slice(0, 300))
        }
    })

    child.on('error', (e) => {
        L('spawn error:', e.code || '', e.message)
        if (done) return
        done = true
        cleanup()
        send('error', { message: `pi spawn failed: ${e.message}` })
        res.end()
    })

    child.on('close', (code, signal) => {
        if (stderrBuf.trim()) L('stderr:', stderrBuf.trim().slice(0, 300))
        L(`exit code=${code} signal=${signal} after ${secs()}s | stdout=${stdoutBytes}B stderr=${stderrBytes}B`)
        if (code === 0 && stdoutBytes === 0) L('warning: pi exited cleanly but produced no stdout')
        if (done) return
        done = true
        cleanup()
        send('done', { code, signal, stdout, stderr })
        res.end()
    })

    // res 'close' (not req 'close'): fires when the client really goes away.
    res.on('close', () => {
        if (res.writableEnded) return
        L(`client disconnected after ${secs()}s, killing pi`)
        done = true
        cleanup()
        try { child.kill('SIGTERM') } catch { }
    })
})

// ─── /api/speak (mp3 stream) ──────────────────────────────────
app.post('/api/speak', (req, res) => {
    const rid = Math.random().toString(36).slice(2, 6)
    const L = (...a) => log(`[speak ${rid}]`, ...a)

    const raw = (req.body?.text || '').trim()
    if (!raw) return res.status(400).json({ error: 'no text' })
    const clean = sanitizeForTts(raw).slice(0, cfg.tts.maxChars)
    if (!clean) {
        L('rejected: nothing speakable after sanitising')
        return res.status(400).json({ error: 'nothing to say' })
    }
    L(`request: ${clean.length} chars`, preview(clean, 80))

    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'no-cache')

    const startedAt = Date.now()
    const proc = spawn(cfg.tts.bin, [
        '--voice', cfg.tts.voice,
        '--rate', cfg.tts.rate,
        '--text', clean,
        '--write-media', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let bytes = 0
    proc.stdout.on('data', (d) => { bytes += d.length })
    proc.stdout.pipe(res)
    proc.stderr.on('data', (d) => L('stderr:', d.toString('utf8').trim().slice(0, 300)))

    proc.on('error', (e) => {
        L('spawn error:', e.message)
        if (!res.headersSent) res.status(500).json({ error: e.message })
        else try { res.end() } catch { }
    })
    proc.on('close', (code) => {
        L(`exit code=${code} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${bytes}B audio`)
        try { res.end() } catch { }
    })

    res.on('close', () => {
        if (res.writableEnded) return
        L('client disconnected, killing edge-tts')
        try { proc.kill('SIGTERM') } catch { }
    })
})

// ─── TTS sanitiser ────────────────────────────────────────────
function sanitizeForTts(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')   // drop reasoning blocks
        .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // links → text
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // headers
        .replace(/[*_>#]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

// ─── boot ─────────────────────────────────────────────────────
const PORT = cfg.port
const HOST = cfg.host ?? '0.0.0.0'
const DEVICE_HOST = cfg.deviceHost ?? HOST

// /device/* for the brain. Its own app so it can sit on a different address than the UI.
const deviceApp = express()
deviceApp.use(express.json({ limit: '2mb' }))
deviceApp.use('/device', deviceRouter())
if (DEVICE_HOST === HOST) app.use(deviceApp)
else deviceApp.listen(PORT, DEVICE_HOST, () => console.log(`  /device : http://${DEVICE_HOST}:${PORT}  (brain only, token-protected)`))

app.listen(PORT, HOST, () => {
    console.log(`STTS web app listening on http://${HOST}:${PORT}`)
    console.log(`  config  : ${path.join(__dirname, 'config.json')}`)
    console.log(`  whisper : ${cfg.whisper.url}`)
    console.log(`  pi      : ${cfg.pi.bin}  (cwd=${cfg.pi.cwd || os.homedir()})`)
    console.log(`  edge-tts: ${cfg.tts.bin}  (${cfg.tts.voice}, rate ${cfg.tts.rate})`)
    console.log(`  wake    : ${cfg.wake.required ? `required [${cfg.wake.words.join(', ')}]` : 'disabled'}`)
})