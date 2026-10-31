// Thin access to the Terse Rover actor (generated client at actors/generated/index.js). Never throws on logEvent.
import "./env.ts"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const CLIENT_URL = new URL("../../../actors/generated/index.js", import.meta.url)
let mod: Promise<any> | null = null

async function client(): Promise<any> {
    if (!existsSync(fileURLToPath(CLIENT_URL))) {
        throw new Error(
            `Terse client not found at actors/generated/index.js (the actors agent generates it; run its generate step and start the actor server on TERSE_ACTOR_URL).`,
        )
    }
    mod ??= import(CLIENT_URL.href)
    return (await mod).actors
}

function timeout<T>(p: Promise<T>, ms = 5000): Promise<T> {
    let t: ReturnType<typeof setTimeout>
    return Promise.race([p, new Promise<T>((_, r) => (t = setTimeout(() => r(new Error(`actor call timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t))
}

export async function rover(): Promise<any> {
    return (await client()).Rover.get("rover-1")
}

export async function command(agentId: string, cmd: "drive" | "stop" | "home"): Promise<{ ok: boolean; reason?: string }> {
    return timeout((await rover()).command(agentId, cmd))
}

/** Best-effort mirror into the dashboard feed. */
export async function logEvent(source: string, text: string): Promise<void> {
    try {
        await timeout((await rover()).logEvent(source, text), 3000)
    } catch (e) {
        if (process.env.DEBUG) console.warn("[rover-actor] logEvent failed:", (e as Error).message)
    }
}
