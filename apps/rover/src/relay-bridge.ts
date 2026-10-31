// The rover's Agent Relay side as its own process (`npm run relay -w apps/rover`).
// Relay's retries under load starve the executor when they share a process, so the executor
// runs with ROVER_NO_RELAY=1 and this bridge handles pages (-> actor.submitMission) and posts
// the thread reply for every mission the actor finishes.
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Mission, MissionResult } from "@app/shared/types"
import { BAY_NAME } from "@app/shared/types"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
for (const f of [join(root, ".env"), join(root, "apps", "rover", ".env")]) {
    if (existsSync(f)) process.loadEnvFile(f)
}
delete process.env.ROVER_NO_RELAY

const { actor } = await import("./actor.js")
const { startRelayAgent } = await import("./relay-agent.js")
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

process.on("unhandledRejection", (e) => console.error("[bridge] unhandledRejection:", e))

const relay = await (async () => {
    for (let attempt = 1; ; attempt++) {
        const r = await startRelayAgent()
        if (r) return r
        console.error(`[bridge] Relay connect failed, retrying in 15 s (attempt ${attempt})`)
        await sleep(15_000)
    }
})()
console.log("[bridge] connected; watching the actor for finished missions")

function sentenceFor(m: Mission, r: MissionResult): string {
    const bay = BAY_NAME[m.bay] ?? String(m.bay)
    if (m.status === "failed") return `Mission ${m.id} failed: ${m.error ?? "unknown error"}.`
    const dest = r.inspection?.destination ? `, bound for ${r.inspection.destination}` : ""
    switch (r.verdict) {
        case "confirmed":
            return `${m.shipmentId} confirmed in bay ${bay}${dest}.`
        case "ghost":
            return `Ghost shipment! Bay ${bay} is empty. ${m.shipmentId} is not here.`
        case "mismatch":
            return `Wrong package in bay ${bay}: label reads ${r.inspection?.shipmentId ?? "unknown"}, expected ${m.shipmentId}.`
        case "damaged":
            return `${m.shipmentId} is in bay ${bay} but looks damaged.`
        default:
            return `Inspection of bay ${bay} for ${m.shipmentId} is inconclusive. A human should check.`
    }
}

// Missions already finished before this bridge started are not re-reported.
const reported = new Set<string>()
const attempts = new Map<string, number>()
const initial = await actor.getState().catch(() => null)
for (const m of initial?.missions ?? []) if (m.status === "done" || m.status === "failed") reported.add(m.id)

for (;;) {
    await sleep(2000)
    const s = await actor.getState().catch(() => null)
    if (!s) continue
    for (const m of s.missions) {
        if ((m.status !== "done" && m.status !== "failed") || reported.has(m.id)) continue
        reported.add(m.id)
        const result: MissionResult = m.result ?? { inspection: null, photoUrl: null, verdict: "inconclusive" }
        try {
            await relay.reporter(m, result, sentenceFor(m, result))
            console.log(`[bridge] reported ${m.id}: ${result.verdict}`)
        } catch (e) {
            // Relay times out under load: try again on the next pass, up to 4 times
            const n = (attempts.get(m.id) ?? 0) + 1
            attempts.set(m.id, n)
            if (n < 4) reported.delete(m.id)
            console.error(`[bridge] report ${m.id} failed (attempt ${n}):`, (e as Error).message)
        }
    }
}
