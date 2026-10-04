// server/index.js
//
// STTS web app backend.
// Endpoints:
//   GET  /api/health          – status of whisper + pi + edge-tts
//   POST /api/transcribe      – multipart audio → whisper → { text }
//   POST /api/prompt          – { text } → SSE stream of `pi -p <text>` output
//   POST /api/speak           – { text } → audio/mpeg stream (edge-tts)
//
// All config lives in ../config.json — see server/config.js. No env vars
// required; edit config.json and the next request picks it up.

import express from 'express'
import multer from 'multer'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import cfg, { whisperHealthUrl } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
})

app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.join(__dirname, '.', 'public')))

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
        wakeWord: { required: cfg.wake.required, words: cfg.wake.words },
    })
})

// ─── /api/transcribe ──────────────────────────────────────────
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no audio field' })
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
            return res.status(502).json({ error: `whisper ${r.status}: ${t}` })
        }
        const data = await r.json()
        res.json({ text: (data.text || '').trim(), raw: data })
    } catch (e) {
        res.status(500).json({ error: e.message })
    }
})

// ─── /api/prompt (SSE) ────────────────────────────────────────
app.post('/api/prompt', (req, res) => {
    const text = (req.body?.text || '').trim()
    if (!text) return res.status(400).json({ error: 'no text' })

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()

    const send = (event, data) => {
        res.write(`event: ${event}\n`)
        res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    send('start', { prompt: text })

    const child = spawn(cfg.pi.bin, ['-p', text], {
        cwd: cfg.pi.cwd || os.homedir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    let done = false
    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
        if (done) return
        send('error', { message: `pi timed out after ${cfg.pi.timeoutMs}ms` })
        try { child.kill('SIGTERM') } catch { }
    }, cfg.pi.timeoutMs)

    child.stdout.on('data', (d) => {
        const s = d.toString('utf8')
        stdout += s
        send('chunk', { text: s })
    })
    child.stderr.on('data', (d) => {
        stderr += d.toString('utf8')
        // stderr is usually progress noise — don't spam the UI by default.
    })
    child.on('error', (e) => {
        if (done) return
        done = true
        clearTimeout(timer)
        send('error', { message: `pi spawn failed: ${e.message}` })
        res.end()
    })
    child.on('close', (code) => {
        if (done) return
        done = true
        clearTimeout(timer)
        send('done', { code, stdout, stderr })
        res.end()
    })

    req.on('close', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { child.kill('SIGTERM') } catch { }
    })
})

// ─── /api/speak (mp3 stream) ──────────────────────────────────
app.post('/api/speak', (req, res) => {
    const raw = (req.body?.text || '').trim()
    if (!raw) return res.status(400).json({ error: 'no text' })
    const clean = sanitizeForTts(raw).slice(0, cfg.tts.maxChars)
    if (!clean) return res.status(400).json({ error: 'nothing to say' })

    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'no-cache')

    const proc = spawn(cfg.tts.bin, [
        '--voice', cfg.tts.voice,
        '--rate', cfg.tts.rate,
        '--text', clean,
        '--write-media', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    proc.stdout.pipe(res)
    proc.stderr.on('data', () => { /* edge-tts chatter */ })

    proc.on('error', (e) => {
        if (!res.headersSent) res.status(500).json({ error: e.message })
        else try { res.end() } catch { }
    })
    proc.on('close', () => { try { res.end() } catch { } })

    req.on('close', () => { try { proc.kill('SIGTERM') } catch { } })
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
app.listen(PORT, '0.0.0.0', () => {
    console.log(`STTS web app listening on http://0.0.0.0:${PORT}`)
    console.log(`  config  : ${path.join(__dirname, '..', 'config.json')}`)
    console.log(`  whisper : ${cfg.whisper.url}`)
    console.log(`  pi      : ${cfg.pi.bin}  (cwd=${cfg.pi.cwd || os.homedir()})`)
    console.log(`  edge-tts: ${cfg.tts.bin}  (${cfg.tts.voice}, rate ${cfg.tts.rate})`)
    console.log(`  wake    : ${cfg.wake.required ? `required [${cfg.wake.words.join(', ')}]` : 'disabled'}`)
})