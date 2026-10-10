// server/config.js
//
// Loads config.json at the app root, watches it for changes, and exposes
// it as a Proxy so every read hits the current values. Mirrors the pattern
// used in the main STTS module — edit config.json and the next request
// picks up the new values (no restart needed).

import { readFileSync, watch } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = join(__dirname, '.', 'config.json')

let cache = {}
let debounceTimer = null

function loadConfigFile() {
    try {
        const raw = readFileSync(CONFIG_PATH, 'utf-8')
        return JSON.parse(raw)
    } catch (err) {
        console.error(`[config] failed to read/parse config.json: ${err.message}`)
        return null
    }
}

cache = loadConfigFile() ?? {}

function watchConfig() {
    try {
        const watcher = watch(CONFIG_PATH, (eventType) => {
            clearTimeout(debounceTimer)
            debounceTimer = setTimeout(() => {
                const next = loadConfigFile()
                if (next) {
                    cache = next
                    console.log('[config] config.json reloaded')
                }
            }, 150)
            if (eventType === 'rename') {
                watcher.close()
                setTimeout(watchConfig, 150)
            }
        })
    } catch (err) {
        console.error(`[config] watch error: ${err.message}`)
    }
}
watchConfig()

const cfg = new Proxy(
    {},
    {
        get(_target, prop) { return cache[prop] },
        has(_target, prop) { return prop in cache },
        ownKeys() { return Reflect.ownKeys(cache) },
        getOwnPropertyDescriptor(_target, prop) {
            return Object.getOwnPropertyDescriptor(cache, prop)
        },
    },
)

// Derives the health endpoint from the transcribe URL, unless the user
// explicitly set one. e.g. http://host:8775/transcribe → http://host:8775/health
export function whisperHealthUrl() {
    const url = cfg.whisper?.url
    if (!url) return null
    return url.replace(/\/transcribe\/?$/, '/health')
}

export default cfg