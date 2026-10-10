// public/app.js
//
// Frontend:
//   • MicVAD (Silero VAD in WASM) runs on the getUserMedia stream
//   • onSpeechEnd → Float32 @ 16k → WAV blob → POST /api/transcribe
//   • transcript → wake-word gate → POST /api/prompt (SSE)
//   • pi output → POST /api/speak → <audio> play

const $ = (id) => document.getElementById(id)
const logEl = $('log')
const statusEl = $('status')
const micBtn = $('mic-toggle')
const wakeBadge = $('wake-badge')
const whisperBadge = $('whisper-badge')
const typeInput = $('type-input')

let VAD = null
let micOn = false
let speaking = false            // true while TTS is playing → ignore mic
let currentPromptAbort = null   // AbortController for the active /api/prompt
let currentAudio = null
let currentAudioUrl = null

let WAKE_WORDS = []
let LEADING_ONLY = []   // wake words that only count in the first few words (see wake-word helpers)
let REQUIRE_WAKE = true

    // ─── boot ─────────────────────────────────────────────────────
    ; (async function boot() {
        try {
            const r = await fetch('/api/health')
            const h = await r.json()
            WAKE_WORDS = h.wakeWord?.words || []
            LEADING_ONLY = h.wakeWord?.leadingOnly || []
            REQUIRE_WAKE = !!h.wakeWord?.required
            wakeBadge.textContent = REQUIRE_WAKE
                ? `wake: ${WAKE_WORDS.slice(0, 3).join('/')}…`
                : 'wake: off'
            whisperBadge.textContent = h.whisper?.ok
                ? `whisper: ok (${h.whisper.info?.model || '?'})`
                : 'whisper: unreachable'
        } catch (e) {
            setStatus('err', 'health failed')
        }
    })()

// ─── activity feed: what the brain just did on this machine ───
new EventSource('/api/events').onmessage = (e) => {
    const a = JSON.parse(e.data)
    if (a.ok) appendSys(`${a.text} · ${(a.ms / 1000).toFixed(1)}s`)
    else appendErr(a.text)
}

// ─── mic toggle ───────────────────────────────────────────────
micBtn.addEventListener('click', async () => {
    if (micOn) return stopMic()
    return startMic()
})

// Replace your existing startMic() and stopMic() in public/app.js with these.
// Everything else in app.js stays the same (handleSpeechEnd already receives
// a Float32Array at 16 kHz, which is exactly what MicVAD hands to onSpeechEnd).

const VAD_ONNX_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/'
const VAD_ASSET_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/'

async function startMic() {
    // getUserMedia only exists on HTTPS or http://localhost.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        appendErr('Mic blocked: this page must be opened over HTTPS or http://localhost (not http://<ip>).')
        setStatus('err', 'insecure context')
        return
    }
    if (!window.vad?.MicVAD || !window.ort) {
        appendErr('VAD scripts did not load. Open devtools > Network and check the two jsdelivr requests in index.html.')
        setStatus('err', 'vad not loaded')
        return
    }

    try {
        setStatus('thinking', 'loading VAD…')

        // Create once, then just pause/start on later toggles.
        if (!VAD) {
            VAD = await window.vad.MicVAD.new({
                onnxWASMBasePath: VAD_ONNX_BASE,
                baseAssetPath: VAD_ASSET_BASE,
                positiveSpeechThreshold: 0.6,
                negativeSpeechThreshold: 0.35,
                redemptionMs: 700,      // silence needed to end an utterance
                minSpeechMs: 250,       // ignore clicks and coughs
                preSpeechPadMs: 300,    // keep a little audio before speech starts
                onSpeechStart: () => {
                    if (speaking) return
                    setStatus('listening', 'speech detected…')
                },
                onVADMisfire: () => setStatus(micOn ? 'listening' : 'idle'),
                onSpeechEnd: handleSpeechEnd,
            })
        }

        VAD.start()
        micOn = true
        micBtn.classList.add('on')
        micBtn.textContent = '🎤 Mic on, click to stop'
        setStatus('listening', 'listening…')
    } catch (e) {
        VAD = null
        appendErr(`mic failed: ${e.message}`)
        setStatus('err', 'mic failed')
    }
}

async function stopMic() {
    if (VAD) {
        try { await VAD.pause() } catch { }
    }
    micOn = false
    micBtn.classList.remove('on')
    micBtn.textContent = '🎤 Enable mic'
    setStatus('idle')
}
// ─── speech end → transcribe → route ──────────────────────────
async function handleSpeechEnd(float32) {
    if (speaking) return  // we're hearing our own TTS
    if (!float32 || float32.length < 1600) return  // < 100ms, ignore

    setStatus('transcribing', 'transcribing…')

    let text = ''
    try {
        const wav = float32ToWav(float32, 16000)
        const fd = new FormData()
        fd.append('audio', wav, 'speech.wav')
        const r = await fetch('/api/transcribe', { method: 'POST', body: fd })
        const data = await r.json()
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
        text = (data.text || '').trim()
    } catch (e) {
        appendErr(`transcribe failed: ${e.message}`)
        setStatus('err', 'transcribe failed')
        return
    }

    if (!text) { setStatus(micOn ? 'listening' : 'idle'); return }

    appendMsg('me', text)

    // wake-word gate
    if (REQUIRE_WAKE && WAKE_WORDS.length) {
        if (!hasWakeWord(text)) {
            setStatus(micOn ? 'listening' : 'idle', 'no wake word')
            return
        }
        text = stripWakeWords(text).trim() || text
    }

    await runPi(text)
}

// ─── /api/prompt SSE ──────────────────────────────────────────
async function runPi(prompt) {
    // Interrupt any in-flight pi run — new prompt wins.
    if (currentPromptAbort) currentPromptAbort.abort()
    const ac = new AbortController()
    currentPromptAbort = ac

    stopAudio()  // kill any TTS already playing

    setStatus('thinking', 'pi is thinking…')

    let resp
    try {
        resp = await fetch('/api/prompt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: prompt }),
            signal: ac.signal,
        })
    } catch (e) {
        if (e.name !== 'AbortError') {
            appendErr(`prompt failed: ${e.message}`)
            setStatus('err', 'prompt failed')
        }
        return
    }
    if (!resp.ok || !resp.body) {
        appendErr(`prompt HTTP ${resp.status}`)
        setStatus('err', 'prompt failed')
        return
    }

    const msgEl = appendMsg('lily', '', true)
    let piText = ''
    let buffer = ''
    let done = false

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    try {
        while (!done) {
            const { value, done: eof } = await reader.read()
            if (eof) break
            buffer += decoder.decode(value, { stream: true })

            let idx
            while ((idx = buffer.indexOf('\n\n')) !== -1) {
                const rawEvent = buffer.slice(0, idx)
                buffer = buffer.slice(idx + 2)
                const evt = parseSseBlock(rawEvent)
                if (!evt) continue

                if (evt.event === 'chunk') {
                    piText += evt.data?.text ?? ''
                    msgEl.textContent = piText
                    logEl.scrollTop = logEl.scrollHeight
                } else if (evt.event === 'error') {
                    appendErr(`pi: ${evt.data?.message || 'unknown error'}`)
                    setStatus('err', 'pi error')
                    done = true
                } else if (evt.event === 'done') {
                    done = true
                }
            }
        }
    } catch (e) {
        if (e.name !== 'AbortError') appendErr(`stream failed: ${e.message}`)
    } finally {
        if (currentPromptAbort === ac) currentPromptAbort = null
    }

    const finalText = piText.trim()
    if (!finalText) {
        setStatus(micOn ? 'listening' : 'idle')
        return
    }

    await speak(finalText)
}

// ─── /api/speak → audio ───────────────────────────────────────
async function speak(text) {
    setStatus('speaking', 'speaking…')
    speaking = true
    try {
        const r = await fetch('/api/speak', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const blob = await r.blob()
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        currentAudio = audio
        currentAudioUrl = url
        await new Promise((resolve) => {
            audio.onended = resolve
            audio.onerror = resolve
            audio.play().catch(resolve)
        })
    } catch (e) {
        appendErr(`tts failed: ${e.message}`)
    } finally {
        if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl)
        currentAudio = null
        currentAudioUrl = null
        speaking = false
        setStatus(micOn ? 'listening' : 'idle')
    }
}

function stopAudio() {
    if (currentAudio) {
        try { currentAudio.pause() } catch { }
        currentAudio = null
    }
    if (currentAudioUrl) {
        try { URL.revokeObjectURL(currentAudioUrl) } catch { }
        currentAudioUrl = null
    }
    speaking = false
}

// ─── type-in fallback ─────────────────────────────────────────
typeInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return
    const text = typeInput.value.trim()
    if (!text) return
    typeInput.value = ''
    appendMsg('me', text)
    await runPi(text)
})

// ─── SSE parsing ──────────────────────────────────────────────
function parseSseBlock(block) {
    let event = 'message'
    const dataLines = []
    for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) return { event, data: null }
    try { return { event, data: JSON.parse(dataLines.join('\n')) } }
    catch { return { event, data: null } }
}

// ─── wake-word helpers ────────────────────────────────────────
// Whole words only, so "lil" no longer fires on "still" or "little". Words listed in config
// wake.leadingOnly are everyday English that whisper hears as "Lily" ("really"), so they only
// count at the start of an utterance, optionally after "hey" / "ok".
const wordRe = (w, flags = 'iu', tail = '') =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(w)}(?![\\p{L}\\p{N}])${tail}`, flags)
const leadRe = (w) =>
    new RegExp(`^\\s*(?:(?:hey|hi|ok|okay|oye|hola)\\W+)?${escapeRegExp(w)}(?![\\p{L}\\p{N}])\\W*`, 'iu')
const anywhereWords = () => WAKE_WORDS.filter(w => !LEADING_ONLY.includes(w))

function hasWakeWord(text) {
    return anywhereWords().some(w => wordRe(w).test(text)) || LEADING_ONLY.some(w => leadRe(w).test(text))
}
function stripWakeWords(text) {
    const out = anywhereWords().reduce((t, w) => t.replace(wordRe(w, 'giu', '[,.!?]?'), ' '), text)
    return LEADING_ONLY.reduce((t, w) => t.replace(leadRe(w), ' '), out).replace(/\s+/g, ' ').trim()
}
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// ─── Float32 → WAV blob ───────────────────────────────────────
function float32ToWav(float32, sampleRate) {
    const pcm16 = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]))
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    const dataSize = pcm16.length * 2
    const buf = new ArrayBuffer(44 + dataSize)
    const v = new DataView(buf)
    writeAscii(v, 0, 'RIFF')
    v.setUint32(4, 36 + dataSize, true)
    writeAscii(v, 8, 'WAVE')
    writeAscii(v, 12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)               // PCM
    v.setUint16(22, 1, true)               // mono
    v.setUint32(24, sampleRate, true)
    v.setUint32(28, sampleRate * 2, true)  // byte rate
    v.setUint16(32, 2, true)               // block align
    v.setUint16(34, 16, true)              // bits per sample
    writeAscii(v, 36, 'data')
    v.setUint32(40, dataSize, true)
    new Int16Array(buf, 44).set(pcm16)
    return new Blob([buf], { type: 'audio/wav' })
}
function writeAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

// ─── UI helpers ───────────────────────────────────────────────
function setStatus(kind, label) {
    statusEl.className = kind
    statusEl.textContent = label || kind
}
function appendMsg(role, text, returnEl = false) {
    const el = document.createElement('div')
    el.className = `msg ${role}`
    const roleEl = document.createElement('span')
    roleEl.className = 'role'
    roleEl.textContent = role === 'me' ? 'you' : 'lily'
    const body = document.createElement('span')
    body.textContent = text
    el.appendChild(roleEl)
    el.appendChild(body)
    logEl.appendChild(el)
    logEl.scrollTop = logEl.scrollHeight
    return returnEl ? body : el
}
function appendSys(text) {
    const el = document.createElement('div')
    el.className = 'msg sys'
    el.textContent = text
    logEl.appendChild(el)
    logEl.scrollTop = logEl.scrollHeight
}
function appendErr(text) {
    const el = document.createElement('div')
    el.className = 'msg err'
    el.textContent = text
    logEl.appendChild(el)
    logEl.scrollTop = logEl.scrollHeight
}