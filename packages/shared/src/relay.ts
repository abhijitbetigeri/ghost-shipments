// Agent Relay adapter. The ONLY file in the repo that imports @agent-relay/sdk.
// Contract: see DECISIONS.md ("Relay" section). Channel #warehouse.
import { AgentRelay } from "@agent-relay/sdk"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export interface RelayMessage {
    messageId: string
    threadId?: string
    from: string
    channel?: string
    text: string
}
export interface RelayAgent {
    handle: string
    send(to: string, text: string): Promise<{ messageId: string }> // to: "#warehouse" or "@rover"
    reply(messageId: string, text: string): Promise<{ messageId: string }>
    onMessage(cb: (m: RelayMessage) => void): () => void // excludes the agent's own messages
    close(): Promise<void>
}

export const WAREHOUSE_CHANNEL = "warehouse"
const TIMEOUT_MS = 10_000
const POLL_MS = Number(process.env.RELAY_POLL_MS ?? 2500)
const POLL_THREADS = 6

function withTimeout<T>(p: Promise<T>, what: string, ms = TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout>
    return Promise.race([
        p,
        new Promise<T>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`relay: ${what} timed out after ${ms} ms`)), ms)
        }),
    ]).finally(() => clearTimeout(timer))
}

/** withTimeout + up to 4 retries on retryable relay errors (e.g. 503 database_overloaded). */
async function call<T>(fn: () => Promise<T>, what: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await withTimeout(fn(), what)
        } catch (e: any) {
            if (attempt >= 4 || !e?.retryable) throw e
            const wait = Math.min(Number(e.retryAfterMs) || 1000, 8000)
            console.warn(`[relay] ${what}: ${e.message} (retry in ${wait} ms)`)
            await new Promise((r) => setTimeout(r, wait))
        }
    }
}

let workspaceKeyPromise: Promise<string> | null = null

/** Returns RELAY_WORKSPACE_KEY, creating a workspace if the env var is unset (prints the key to persist). */
export async function ensureWorkspace(): Promise<string> {
    const existing = process.env.RELAY_WORKSPACE_KEY
    if (existing) return existing
    if (!workspaceKeyPromise) {
        workspaceKeyPromise = (async () => {
            const relay = await withTimeout(
                AgentRelay.createWorkspace({ name: `ghost-shipments-${Date.now()}` }),
                "createWorkspace",
            )
            const key = relay.workspaceKey
            if (!key) throw new Error("relay: createWorkspace returned no workspaceKey")
            process.env.RELAY_WORKSPACE_KEY = key
            console.log(`[relay] created workspace. Add to .env:\nRELAY_WORKSPACE_KEY=${key}`)
            return key
        })()
    }
    return workspaceKeyPromise
}

function stripHandle(s: string | undefined): string {
    return (s ?? "").replace(/^[@#]/, "")
}

// Re-registering an existing name fails with 409 name_conflict on this relay, so tokens are persisted
// in <repo>/.relay-tokens.json (gitignored), keyed by workspace + agent name, and reused via reconnect().
const TOKENS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.relay-tokens.json")
type TokenMap = Record<string, string>
function readTokens(): TokenMap {
    try {
        return existsSync(TOKENS_FILE) ? JSON.parse(readFileSync(TOKENS_FILE, "utf8")) : {}
    } catch {
        return {}
    }
}
function saveToken(key: string, token: string | undefined) {
    if (!token) return
    const all = readTokens()
    all[key] = token
    try {
        writeFileSync(TOKENS_FILE, JSON.stringify(all, null, 2))
    } catch (e) {
        console.warn("[relay] could not persist token:", (e as Error).message)
    }
}

async function registerOrReconnect(relay: AgentRelay, workspaceKey: string, name: string) {
    const tokenKey = `${workspaceKey.slice(0, 20)}:${name}`
    const saved = readTokens()[tokenKey]
    if (saved) {
        try {
            return await call(() => relay.workspace.reconnect({ apiToken: saved }), `reconnect ${name}`)
        } catch (e) {
            console.warn(`[relay] reconnect ${name} failed (${(e as Error).message}); re-registering`)
        }
    }
    const register = () => call(() => relay.workspace.register({ name, type: "agent" }), `register ${name}`)
    let agent
    try {
        agent = await register()
    } catch (e: any) {
        if (e?.code !== "name_conflict" && e?.statusCode !== 409) throw e
        // Name taken and we lost its token: delete the old identity, then register fresh.
        console.warn(`[relay] ${name} already registered without a saved token; deleting and re-registering`)
        await call(() => relay.agents.delete(name), `delete ${name}`)
        agent = await register()
    }
    saveToken(tokenKey, (agent as { token?: string }).token)
    return agent
}

/** Registers (or re-adopts) the agent `name`, joins #warehouse (creating it if missing). */
export async function connectAgent(name: string): Promise<RelayAgent> {
    const workspaceKey = await ensureWorkspace()
    // SDK-internal retries are off; call() retries with our own 10 s per-attempt timeout instead.
    const relay = new AgentRelay({ workspaceKey, retryPolicy: { maxRetries: 0 } })
    const agent = await registerOrReconnect(relay, workspaceKey, name)
    const handle = stripHandle(agent.name ?? name)

    try {
        await call(() => agent.channels.join(WAREHOUSE_CHANNEL), "join #warehouse")
    } catch {
        try {
            await call(
                () => agent.channels.create({ name: WAREHOUSE_CHANNEL, topic: "Ghost Shipments: warehouse remote hands" }),
                "create #warehouse",
            )
        } catch (e) {
            // Another agent may have created it concurrently; fall through to join.
            if (!/exist|conflict|409/i.test(String((e as Error)?.message ?? e))) throw e
        }
        await call(() => agent.channels.join(WAREHOUSE_CHANNEL), "join #warehouse")
    }

    const unsubs = new Set<() => void>()
    // The websocket only delivers channel events for channels explicitly subscribed on the agent-scoped
    // connection (joining is not enough). The SDK keeps that client private, so reach it via its token.
    const agentToken = (agent as { token?: string }).token
    const agentEvents = agentToken ? (relay as any).messagingForToken?.(agentToken)?.events : undefined
    try {
        agentEvents?.connect?.()
        agentEvents?.subscribe?.([WAREHOUSE_CHANNEL])
    } catch (e) {
        console.warn("[relay] channel subscribe failed:", (e as Error).message)
    }
    if (process.env.RELAY_DEBUG) {
        const ws = (relay as any).messagingForToken?.(agentToken)?.agentClient?.ws
        for (const e of ["open", "close", "error", "permanently_disconnected"]) ws?.on?.(e, (x: any) => console.log(`[relay:${handle}] ws ${e}`, String(x?.message ?? x?.error?.message ?? (()=>{try{return JSON.stringify(x)}catch{return x}})()).slice(0, 300)))
        console.log(`[relay:${handle}] ws object present:`, !!ws)
        relay.addListener("*", (ev: any) => console.log(`[relay:${handle}] event`, ev?.type, JSON.stringify(ev).slice(0, 400)))
    }

    // Threads this agent started or replied in are always polled for replies.
    const watched = new Set<string>()
    const remember = (id: string) => {
        watched.add(id)
        if (watched.size > 20) watched.delete(watched.values().next().value as string)
    }

    return {
        handle,
        async send(to, text) {
            const m = await call(() => agent.sendMessage({ to, text } as never), `send ${to}`)
            const id = (m as { messageId?: string; id?: string }).messageId ?? (m as { id: string }).id
            remember(id)
            return { messageId: id }
        },
        async reply(messageId, text) {
            const m = await call(() => agent.reply({ messageId, text }), "reply")
            remember(messageId)
            return { messageId: (m as { messageId?: string; id?: string }).messageId ?? (m as { id: string }).id }
        },
        onMessage(cb) {
            const seen = new Set<string>()
            const handler = (ev: { message: any; envelope?: any }) => {
                const msg = ev.message
                if (!msg) return
                const id: string = msg.messageId ?? msg.id
                if (!id || seen.has(id)) return
                seen.add(id)
                if (seen.size > 2000) seen.clear()
                const from = stripHandle(ev.envelope?.from?.name ?? ev.envelope?.from?.handle ?? msg.from?.name)
                if (from === handle) return
                const threadId: string | undefined = msg.threadId ?? msg.parentId ?? ev.envelope?.parent ?? undefined
                const channel = ev.envelope?.channel?.name ?? msg.channel?.name
                try {
                    cb({ messageId: id, threadId: threadId || undefined, from, channel: channel ? stripHandle(channel) : undefined, text: msg.text ?? "" })
                } catch (e) {
                    console.warn("[relay] onMessage callback threw:", e)
                }
            }
            // Polling fallback: the hosted relay websocket is unreliable under load ("ws error", 503s), so we
            // also poll #warehouse and recent threads over REST. `seen` dedupes against websocket delivery.
            let stopped = false
            const since = Date.now() - 5000 // ignore history from before this listener existed
            const isOld = (m: any) => {
                const t = Date.parse(m.createdAt ?? "")
                return Number.isFinite(t) && t < since
            }
            const poll = async () => {
                try {
                    const top = await withTimeout(agent.messages.list(WAREHOUSE_CHANNEL, { limit: 25 }), "poll list", 8000)
                    const recent = [...top].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))).slice(0, POLL_THREADS)
                    const threadIds = new Set([...recent.map((m) => m.messageId ?? m.id), ...watched])
                    const threads = await Promise.all(
                        [...threadIds].map((tid) =>
                            withTimeout(agent.threads.get(tid, { limit: 50 }), "poll thread", 8000).catch(() => null),
                        ),
                    )
                    const all: any[] = [...top]
                    for (const t of threads) if (t) for (const r of t.replies) all.push({ ...r, threadId: r.threadId ?? r.parentId ?? (t.parent.messageId ?? t.parent.id) })
                    all.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
                    for (const m of all) {
                        if (isOld(m)) seen.add(m.messageId ?? m.id)
                        else handler({ message: { ...m, channel: m.channel ?? { name: WAREHOUSE_CHANNEL } } })
                    }
                } catch (e) {
                    if (process.env.RELAY_DEBUG) console.warn("[relay] poll failed:", (e as Error).message)
                }
                if (!stopped) setTimeout(poll, POLL_MS)
            }
            void poll()
            const offs = [
                () => {
                    stopped = true
                },
                relay.addListener("message.created", handler as never),
                relay.addListener("thread.reply", handler as never),
                relay.addListener("dm.received", handler as never),
            ]
            const off = () => offs.forEach((f) => f())
            unsubs.add(off)
            return () => {
                off()
                unsubs.delete(off)
            }
        },
        async close() {
            for (const off of unsubs) off()
            unsubs.clear()
            try {
                await withTimeout(relay.events.disconnect(), "disconnect", 3000)
            } catch {
                /* best effort */
            }
        },
    }
}
