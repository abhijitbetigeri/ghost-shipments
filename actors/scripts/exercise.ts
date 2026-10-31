// Exercise every Rover/Warehouse method against a running `terse actor dev` (or TERSE_ACTOR_URL).
// Run: bun scripts/exercise.ts            (from actors/)
//      bun scripts/exercise.ts --check    (only print persisted state, no reset; for the restart test)
import { actors } from "../generated/index.js"

const rover = actors.Rover.get("rover-1")
const wh = actors.Warehouse.get("wh-1")
const show = (label: string, v: unknown) => console.log(`${label}:`, JSON.stringify(v))

if (process.argv.includes("--check")) {
    const s = await rover.getState()
    show("persisted missions", s.missions.map(m => `${m.id} ${m.status}`))
    show("persisted mode", s.mode)
    show("persisted lastEvidenceUrl", s.lastEvidenceUrl)
    show("persisted bay 2", (await wh.getState()).bays[2])
    process.exit(0)
}

await rover.reset()
await wh.reset()

// Conflict beat: P2 arrives first, P1 second; P1 must run first.
show(
    "submit P2 inventory",
    await rover.submitMission({ from: "inventory-agent", priority: 2, bay: 4, shipmentId: "SHP-1051", question: "cycle count bay D" }),
)
show(
    "submit P1 shipping",
    await rover.submitMission({ from: "shipping-agent", priority: 1, bay: 2, shipmentId: "SHP-1042", question: "is SHP-1042 there?", threadId: "msg-1" }),
)

const m1 = await rover.startNext()
show("startNext", { id: m1?.id, from: m1?.from, priority: m1?.priority, status: m1?.status })
if (m1?.from !== "shipping-agent") throw new Error("expected P1 shipping-agent first")
show("startNext again while active", await rover.startNext())

show("command by inventory-agent", await rover.command("inventory-agent", "drive"))
show("command by shipping-agent", await rover.command("shipping-agent", "drive"))
show("command by rover", await rover.command("rover", "stop"))

show("advance step 2", (await rover.advance(m1.id, 2, { to: 2 })).step)
show("advance step 3", (await rover.advance(m1.id, 3)).step)
await rover.setPose(2, 90)
await rover.heartbeat()

show("estop", await rover.estop("dashboard"))
show("startNext while estopped", await rover.startNext())
show("resume", await rover.resume("dashboard"))

const rec = await rover.recover()
show("recover (crash resume)", { id: rec?.id, step: rec?.step })

show("advance step 4", (await rover.advance(m1.id, 4)).step)
show("advance step 5", (await rover.advance(m1.id, 5)).step)
const done = await rover.complete(m1.id, {
    verdict: "confirmed",
    photoUrl: "https://example.supabase.co/storage/v1/object/public/evidence/M-0002.jpg",
    inspection: {
        present: true,
        shipmentId: "SHP-1042",
        destination: "Reno, NV",
        damaged: false,
        labelStatus: "ready",
        confidence: 0.92,
        summary: "SHP-1042 is in bay B, label ready, no damage.",
    },
})
show("complete", { id: done.id, status: done.status, verdict: done.result?.verdict })
show("recover after complete", await rover.recover())

const m2 = await rover.startNext()
show("startNext (P2 now)", { id: m2?.id, from: m2?.from })
show("fail", (await rover.fail(m2!.id, "BLOCKED 12 cm")).status)

await rover.logEvent("relay", "shipping-agent: thanks rover")

show("setBay 2 missing", (await wh.setBay(2, { status: "missing" })).bays[2])

const s = await rover.getState()
show("state.mode", s.mode)
show("state.currentMissionId", s.currentMissionId)
show("state.possessedBy", s.possessedBy)
show("state.pose", s.pose)
show("state.lastEvidenceUrl", s.lastEvidenceUrl)
show("state.missions", s.missions.map(m => `${m.id} P${m.priority} ${m.from} ${m.status} step${m.step}`))
console.log("log:")
for (const e of s.log) console.log(`  [${e.kind}] ${e.source}: ${e.text}`)

// Heartbeat timeout -> offline via alarm
await rover.heartbeat()
console.log("waiting 6.5 s with no heartbeat ...")
await new Promise(r => setTimeout(r, 6500))
show("mode after silence", (await rover.getState()).mode)
await rover.heartbeat()
show("mode after heartbeat", (await rover.getState()).mode)

// Websocket grant + first state message
const { websocketUrl } = await actors.Rover.prepareWebsocket({ actorId: "rover-1", metadata: null })
const first = await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(websocketUrl)
    ws.addEventListener("message", ev => {
        resolve(JSON.parse(String(ev.data)))
        ws.close()
    })
    ws.addEventListener("error", () => reject(new Error("ws error")))
    setTimeout(() => reject(new Error("ws timeout")), 5000)
})
show("websocket first message", { type: first.type, keys: Object.keys(first.state ?? {}), mode: first.state?.mode })
console.log("OK")
