// The "rover" Relay agent: turns @rover pages into actor missions, replies in-thread with the report.
import type { Mission, MissionInput, MissionResult } from "@app/shared/types"
import { actor, logEvent } from "./actor.js"
import type { Reporter } from "./executor.js"

type RelayAgent = {
    handle: string
    send(to: string, text: string): Promise<unknown>
    reply(messageId: string, text: string): Promise<unknown>
    onMessage(cb: (m: { messageId: string; threadId?: string; from: string; channel?: string; text: string }) => void): unknown
    close(): Promise<void>
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let t: NodeJS.Timeout
    return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out`)), ms)))]).finally(() =>
        clearTimeout(t),
    )
}

export interface RoverRelay {
    reporter: Reporter
}

export async function startRelayAgent(): Promise<RoverRelay | null> {
    if (process.env.ROVER_NO_RELAY === "1") {
        console.log("[relay] ROVER_NO_RELAY=1: Relay disabled in the rover process")
        return null
    }
    let agent: RelayAgent
    let parsePage: (text: string) => Promise<any> | any
    try {
        const relay: any = await import("@app/shared/relay")
        const agents: any = await import("@app/agents/parse")
        parsePage = agents.parsePage
        agent = await withTimeout<RelayAgent>(relay.connectAgent("rover"), 20_000, "relay connect")
    } catch (e) {
        console.error("\n!!!!!!!! [relay] RELAY UNAVAILABLE — rover runs without Relay (missions via actor only) !!!!!!!!")
        console.error("[relay]", (e as Error).message, "\n")
        logEvent("rover", `relay unavailable: ${(e as Error).message}`, "error")
        return null
    }
    console.log(`[relay] connected as @${agent.handle}`)

    const reply = async (messageId: string, text: string) => {
        try {
            await withTimeout(agent.reply(messageId, text), 10_000, "relay reply")
            logEvent("relay", `rover: ${text}`)
        } catch (e) {
            console.error("[relay] reply failed:", (e as Error).message)
        }
    }

    // A page whose send "timed out" on Relay may still have been delivered, and the sender retries:
    // treat an identical page from the same agent within 90 s as the same request.
    const recentPages = new Map<string, { at: number; missionId: string }>()
    agent.onMessage(async (m) => {
        logEvent("relay", `${m.from}: ${m.text}`)
        if (!/@rover\b/i.test(m.text)) return
        const dupKey = `${m.from}|${m.text.trim()}`
        const dup = recentPages.get(dupKey)
        if (dup && Date.now() - dup.at < 90_000) {
            await reply(m.messageId, `Already on it (${dup.missionId}), duplicate page ignored.`)
            return
        }
        try {
            const parsed = await withTimeout(Promise.resolve(parsePage(m.text)), 20_000, "parsePage")
            const input: MissionInput = {
                bay: parsed.bay,
                shipmentId: parsed.shipmentId,
                question: parsed.question ?? m.text,
                priority: parsed.priority ?? 2,
                from: m.from,
                threadId: m.messageId,
            }
            const { missionId, position } = await actor.submitMission(input)
            recentPages.set(dupKey, { at: Date.now(), missionId })
            if (position === 0) await reply(m.messageId, `On my way 🛞 (${missionId})`)
            else {
                const s = await actor.getState().catch(() => null)
                await reply(m.messageId, `Queued #${position} behind ${s?.possessedBy ?? "another mission"} (${missionId})`)
            }
        } catch (e) {
            console.error("[relay] page handling failed:", (e as Error).message)
            await reply(m.messageId, `Sorry, I couldn't take that page: ${(e as Error).message}`)
        }
    })

    const reporter: Reporter = async (mission: Mission, result: MissionResult, sentence: string) => {
        const thread = mission.threadId
        const human = `${sentence}${result.photoUrl ? ` Photo: ${result.photoUrl}` : " (no photo)"}`
        const machine = `REPORT ${JSON.stringify({ missionId: mission.id, shipmentId: mission.shipmentId, bay: mission.bay, result })}`
        if (thread) {
            await reply(thread, human)
            await reply(thread, machine)
        } else {
            // submitted directly to the actor, no thread: post to the requester
            for (const text of [human, machine]) {
                try {
                    await withTimeout(agent.send(`@${mission.from}`, text), 10_000, "relay send")
                    logEvent("relay", `rover: ${text}`)
                } catch (e) {
                    console.error("[relay] send failed:", (e as Error).message)
                }
            }
        }
    }
    return { reporter }
}
