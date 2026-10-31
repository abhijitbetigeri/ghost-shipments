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

startHeartbeat(2000)
logEvent("rover", `rover process up (link ${link.name})`)

const exec = new Executor(rover)
exec.startStateWatch(500)
const relay = await startRelayAgent()
if (relay) exec.reporter = relay.reporter

console.log("[rover] executor running")
await exec.run()
