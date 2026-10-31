// Common bits for agents that page @rover: connect, mirror every message to Rover.logEvent, format pages.
import "./env.ts"
import { connectAgent, type RelayAgent, type RelayMessage } from "@app/shared/relay"
import { BAY_NAME, type Bay, type Priority } from "@app/shared/types"
import { logEvent } from "./rover-actor.ts"

export interface Pager {
    relay: RelayAgent
    pageRover(bay: Bay, shipmentId: string, reason: string, priority?: Priority): Promise<{ messageId: string }>
    reply(messageId: string, text: string): Promise<{ messageId: string }>
    /** Threads this agent started (page messageId -> page details). */
    threads: Map<string, { bay: Bay; shipmentId: string; priority: Priority }>
}

export function parseBay(s: string): Bay {
    const u = s.trim().toUpperCase()
    const map: Record<string, Bay> = { A: 1, B: 2, C: 3, D: 4, "1": 1, "2": 2, "3": 3, "4": 4 }
    const b = map[u]
    if (!b) throw new Error(`bad bay "${s}" (use A-D)`)
    return b
}

export async function startPager(handle: string, onMsg?: (m: RelayMessage, p: Pager) => void | Promise<void>): Promise<Pager> {
    const relay = await connectAgent(handle)
    const threads = new Map<string, { bay: Bay; shipmentId: string; priority: Priority }>()
    const p: Pager = {
        relay,
        threads,
        async pageRover(bay, shipmentId, reason, priority = 1) {
            const text = `@rover check bay ${BAY_NAME[bay]}: is ${shipmentId} there? what does the label say, any damage? (P${priority}, ${reason})`
            // Relay's hosted service times out under load: retry the page a few times before giving up.
            let r: { messageId: string } | null = null
            for (let attempt = 1; attempt <= 4 && !r; attempt++) {
                try {
                    r = await relay.send("#warehouse", text)
                } catch (e) {
                    console.warn(`[${handle}] page send failed (attempt ${attempt}/4): ${(e as Error).message}`)
                    if (attempt === 4) throw e
                    await new Promise((res) => setTimeout(res, 3000))
                }
            }
            threads.set(r!.messageId, { bay, shipmentId, priority })
            console.log(`[${handle}] -> #warehouse: ${text}`)
            void logEvent(handle, text)
            void logEvent("relay", `${handle}: ${text}`)
            return r!
        },
        async reply(messageId, text) {
            const r = await relay.reply(messageId, text)
            console.log(`[${handle}] -> thread ${messageId}: ${text}`)
            void logEvent(handle, text)
            void logEvent("relay", `${handle}: ${text}`)
            return r
        },
    }
    relay.onMessage((m) => {
        console.log(`[${handle}] <- ${m.from}${m.threadId ? ` (thread ${m.threadId})` : ""}: ${m.text.slice(0, 200)}`)
        void logEvent(handle, `<- ${m.from}: ${m.text.slice(0, 300)}`)
        if (onMsg) Promise.resolve(onMsg(m, p)).catch((e) => console.error(`[${handle}] handler error:`, e))
    })
    console.log(`[${handle}] connected to Agent Relay as @${relay.handle}`)
    return p
}
