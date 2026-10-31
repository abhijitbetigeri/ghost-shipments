// Terse actor client wrapper (generated client from actors/generated/index.js).
// Every call has a timeout. Loaded lazily so a missing client fails loudly at boot, not at import.
import type {
    Heading,
    Inspection,
    LogEvent,
    Mission,
    MissionInput,
    MissionResult,
    MissionStep,
    Point,
    RoverCommand,
    RoverState,
} from "@app/shared/types"

export interface RoverActor {
    submitMission(input: MissionInput): Promise<{ missionId: string; position: number }>
    startNext(): Promise<Mission | null>
    advance(missionId: string, step: MissionStep, data?: unknown): Promise<unknown>
    complete(missionId: string, result: MissionResult): Promise<unknown>
    fail(missionId: string, error: string): Promise<unknown>
    command(agentId: string, cmd: RoverCommand): Promise<{ ok: boolean; reason?: string }>
    recover(): Promise<Mission | null>
    setPose(at: Point | null, heading: Heading): Promise<unknown>
    heartbeat(): Promise<unknown>
    logEvent(source: string, text: string, kind?: LogEvent["kind"]): Promise<unknown>
    getState(): Promise<RoverState>
}

const CLIENT_PATH = "../../../actors/generated/index.js"
const TIMEOUT_MS = Number(process.env.ACTOR_TIMEOUT_MS ?? 5000)

function withTimeout<T>(p: Promise<T>, what: string, ms = TIMEOUT_MS): Promise<T> {
    let t: NodeJS.Timeout
    return Promise.race([
        p,
        new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`actor ${what} timed out after ${ms} ms`)), ms))),
    ]).finally(() => clearTimeout(t))
}

let raw: any = null
async function rawRover(): Promise<any> {
    if (raw) return raw
    const mod: any = await import(CLIENT_PATH)
    const actors = mod.actors ?? mod.default?.actors ?? mod.default
    if (!actors?.Rover?.get) throw new Error(`actors client at ${CLIENT_PATH} has no actors.Rover.get`)
    raw = actors.Rover.get(process.env.ROVER_ACTOR_ID ?? "rover-1")
    return raw
}

/** Proxy: actor.<method>(...args) → timed-out call on the generated client. */
export const actor: RoverActor = new Proxy({} as RoverActor, {
    get(_t, method: string) {
        return async (...args: unknown[]) => {
            const r = await rawRover()
            if (typeof r[method] !== "function") throw new Error(`actor has no method ${method}`)
            return withTimeout(r[method](...args), method)
        }
    },
})

/** Fire-and-forget log line to the dashboard feed; never throws. */
export function logEvent(source: string, text: string, kind?: LogEvent["kind"]) {
    actor.logEvent(source, text.slice(0, 500), kind).catch((e) => console.warn("[actor] logEvent failed:", (e as Error).message))
}

export function startHeartbeat(everyMs = 2000): () => void {
    let warned = false
    const beat = () =>
        actor.heartbeat().then(
            () => (warned = false),
            (e) => {
                if (!warned) console.warn("[actor] heartbeat failed:", (e as Error).message)
                warned = true
            },
        )
    void beat()
    const t = setInterval(beat, everyMs)
    return () => clearInterval(t)
}

export type { Inspection }
