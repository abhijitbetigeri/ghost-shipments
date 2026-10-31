// npm start (or `npm run rover` from the repo root)
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// load repo-root .env before anything reads process.env (Node 20.12+)
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
for (const f of [join(root, ".env"), join(root, "apps", "rover", ".env")]) {
    if (existsSync(f)) process.loadEnvFile(f)
}

const { openLink } = await import("./serial-link.js")
const { Rover } = await import("./drive.js")
const { Executor } = await import("./executor.js")
const { startHeartbeat, logEvent } = await import("./actor.js")
const { startRelayAgent } = await import("./relay-agent.js")

const link = await openLink()
const rover = new Rover(link, { at: null }) // pose comes from the actor in Executor.run()

const shutdown = async (sig: string) => {
    console.log(`[rover] ${sig}: stopping motors`)
    try {
        link.writeNow("S")
    } catch {}
    setTimeout(() => process.exit(0), 150)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("unhandledRejection", (e) => console.error("[rover] unhandledRejection:", e))

startHeartbeat(4000)
logEvent("rover", `rover process up (link ${link.name})`)

const exec = new Executor(rover)
exec.startStateWatch(3000) // the dev actor serialises calls; polling faster piles them up
// Agent Relay's hosted service returns 503 under load; keep retrying in the background
// so the executor runs now and Relay attaches whenever the connect succeeds.
void (async () => {
    for (let attempt = 1; ; attempt++) {
        const relay = await startRelayAgent()
        if (relay) {
            exec.reporter = relay.reporter
            return
        }
        if (process.env.ROVER_NO_RELAY === "1") return
        console.error(`[relay] retrying connect in 15 s (attempt ${attempt})`)
        await new Promise((r) => setTimeout(r, 15_000))
    }
})()

console.log("[rover] executor running")
await exec.run()
