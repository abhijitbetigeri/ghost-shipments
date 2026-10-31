// Conflict beat: P1 and P2 page @rover at the same instant, then inventory-agent tries to drive directly and is REJECTED.
import "./env.ts"
import { startShipping, pageRover } from "./shipping-agent.ts"
import { startInventory, cycleCount, HANDLE as INV } from "./inventory-agent.ts"
import { command, logEvent } from "./rover-actor.ts"

const [ship, inv] = await Promise.all([startShipping(), startInventory()])
const pages = await Promise.allSettled([pageRover(ship, 2, "SHP-1042", "truck departs 06:00", 1), cycleCount(inv, 3, "SHP-2001")])
const ids = pages.map((r) => (r.status === "fulfilled" ? r.value.messageId : `FAILED (${(r.reason as Error)?.message})`))
console.log(`paged at the same instant: shipping=${ids[0]} inventory=${ids[1]}`)

await new Promise((r) => setTimeout(r, Number(process.env.CONFLICT_DELAY_MS ?? 4000))) // let the rover accept the P1 first
try {
    const res = await command(INV, "drive")
    if (res.ok) {
        console.log(`inventory-agent drive: ACCEPTED (rover not possessed yet?)`, res)
    } else {
        console.log(`inventory-agent drive: REJECTED: ${res.reason ?? "(no reason)"}`)
        void logEvent(INV, `drive REJECTED: ${res.reason ?? ""}`)
    }
} catch (e) {
    console.error(`could not reach Rover actor: ${(e as Error).message}`)
}
await Promise.all([ship.relay.close(), inv.relay.close()])
process.exit(0)
