// lily-gate.ts
//
// pi extension: asks the Lily brain before every bash/write/edit tool call.
// Loaded by deviceLocal.runPi with `pi -e <this file> --yolo -p "<prompt>"`.
// Fails CLOSED: any error, timeout or missing config blocks the call.
//
// NOTE: written against pi's extension API as I understand it
// (pi.on("tool_call", ...) returning { block, reason }). Verify the event
// and field names against the docs of your installed pi version.
import { writeFileSync } from 'node:fs'

const URL_ = process.env.LILY_GATE_URL
const TOKEN = process.env.LILY_GATE_TOKEN
const DEVICE = process.env.LILY_GATE_DEVICE || 'local'
const POLL_MS = 1000
const MAX_WAIT_MS = Number(process.env.LILY_GATE_MAX_WAIT_MS) || 15 * 60_000
const MAX_POLL_ERRORS = 5
const GATED = new Set(['bash', 'write', 'edit'])

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function call(method: string, route: string, body?: unknown): Promise<any> {
    const res = await fetch(URL_ + route, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TOKEN}`,
            'X-Lily-Device': DEVICE,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
    })
    return res.json().catch(() => ({}))
}

// Send only what the human needs to judge; never ship file contents.
function summarize(tool: string, input: any) {
    if (tool === 'bash') return { command: String(input?.command ?? '') }
    const p = input?.path ?? input?.file_path
    if (tool === 'write') return { path: p, bytes: String(input?.content ?? '').length }
    return { path: p }
}

const block = (why: string) => ({
    block: true,
    reason: `${why} Do not retry this or work around it; tell the user it was not allowed.`,
})

export default function (pi: any) {
    // Handshake so runPi can tell the gate actually loaded (otherwise --yolo would run ungated).
    if (process.env.LILY_GATE_SENTINEL) {
        try { writeFileSync(process.env.LILY_GATE_SENTINEL, 'loaded') } catch { /* runPi will notice */ }
    }

    pi.on('tool_call', async (event: any) => {
        if (!GATED.has(event.toolName)) return
        if (!URL_ || !TOKEN) return block('Approval gate is not configured.')

        try {
            const first = await call('POST', '/approval/request', {
                tool: event.toolName,
                input: summarize(event.toolName, event.input),
                cwd: process.cwd(),
            })
            if (first.status === 'approved') return
            if (first.status !== 'pending' || !first.id) return block(`Rejected (${first.reason ?? 'no approval id'}).`)

            const deadline = Date.now() + MAX_WAIT_MS
            let errors = 0
            while (Date.now() < deadline) {
                await sleep(POLL_MS)
                let r: any
                try { r = await call('GET', `/approval/${first.id}`); errors = 0 }
                catch { if (++errors >= MAX_POLL_ERRORS) return block('Lost contact with the approval service.'); continue }

                if (r.status === 'approved') return
                if (r.status === 'denied') return block(`Denied by the user${r.reason ? ` (${r.reason})` : ''}.`)
                // 'pending' -> keep polling
            }
            return block('Approval timed out.')
        } catch (e: any) {
            return block(`Approval service unreachable (${e?.message ?? e}).`)
        }
    })
}