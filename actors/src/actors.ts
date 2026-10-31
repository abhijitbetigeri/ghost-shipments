import { Actor, Emittable, Persisted } from "terse-sdk/actor"
import {
    STEP_NAME,
    type Bay,
    type BaySlot,
    type Heading,
    type LogEvent,
    type Mission,
    type MissionInput,
    type MissionResult,
    type MissionStep,
    type Point,
    type RoverCommand,
    type RoverMode,
    type RoverState,
    type WarehouseState,
} from "./types.js"

const LOG_CAP = 200
const FINISHED_CAP = 30 // keep the last N done/failed missions
const LEASE_MS = 120_000
const HEARTBEAT_TIMEOUT_MS = 5_000

const byQueueOrder = (a: Mission, b: Mission) => a.priority - b.priority || a.createdAt - b.createdAt

export class Rover extends Actor {
    @Persisted @Emittable missions: Mission[] = []
    @Persisted @Emittable currentMissionId: string | null = null
    @Persisted @Emittable possessedBy: string | null = null
    @Persisted @Emittable leaseExpiry: number | null = null
    @Persisted @Emittable pose: { at: Point | null; heading: Heading } = { at: 5, heading: 0 }
    @Persisted @Emittable mode: RoverMode = "idle"
    @Persisted @Emittable lastHeartbeat: number | null = null
    @Persisted @Emittable lastEvidenceUrl: string | null = null
    @Persisted @Emittable log: LogEvent[] = []

    @Persisted private seq = 0
    @Persisted private modeBeforeOffline: RoverMode = "idle"

    #push(source: string, text: string, kind: LogEvent["kind"] = "info") {
        const ev: LogEvent = { t: Date.now(), source, text, kind }
        this.log = [...this.log, ev].slice(-LOG_CAP)
    }

    #findMission(missionId: string): Mission {
        const m = this.missions.find(x => x.id === missionId)
        if (!m) throw new Error(`unknown mission ${missionId}`)
        return m
    }

    #patchMission(missionId: string, patch: Partial<Mission>) {
        this.missions = this.missions.map(m => (m.id === missionId ? { ...m, ...patch } : m))
    }

    #trimFinished() {
        const finished = this.missions.filter(m => m.status === "done" || m.status === "failed")
        if (finished.length <= FINISHED_CAP) return
        const drop = new Set(finished.slice(0, finished.length - FINISHED_CAP).map(m => m.id))
        this.missions = this.missions.filter(m => !drop.has(m.id))
    }

    #releaseMission() {
        this.currentMissionId = null
        this.possessedBy = null
        this.leaseExpiry = null
        if (this.mode !== "estopped" && this.mode !== "offline") this.mode = "idle"
        if (this.mode === "offline") this.modeBeforeOffline = "idle"
    }

    async submitMission(input: MissionInput): Promise<{ missionId: string; position: number }> {
        this.seq = this.seq + 1
        const id = `M-${String(this.seq).padStart(4, "0")}`
        const mission: Mission = { ...input, id, status: "queued", step: 1, createdAt: Date.now() }
        this.missions = [...this.missions, mission]
        const queue = this.missions.filter(m => m.status === "queued").sort(byQueueOrder)
        const position = queue.findIndex(m => m.id === id)
        this.#push(
            "actor",
            `QUEUED ${id} P${input.priority} from ${input.from}: bay ${input.bay} ${input.shipmentId} (position ${position})`,
        )
        return { missionId: id, position }
    }

    async startNext(): Promise<Mission | null> {
        if (this.mode === "estopped") return null
        if (this.currentMissionId) return null
        const next = this.missions.filter(m => m.status === "queued").sort(byQueueOrder)[0]
        if (!next) return null
        this.#patchMission(next.id, { status: "active", step: 1 })
        this.currentMissionId = next.id
        this.possessedBy = next.from
        this.leaseExpiry = Date.now() + LEASE_MS
        if (this.mode === "offline") this.modeBeforeOffline = "executing"
        else this.mode = "executing"
        this.#push("actor", `START ${next.id} for ${next.from}; rover possessed by ${next.from}`)
        return this.#findMission(next.id)
    }

    async advance(missionId: string, step: MissionStep, data?: Record<string, unknown>): Promise<Mission> {
        const m = this.#findMission(missionId)
        if (m.status !== "active") throw new Error(`mission ${missionId} is ${m.status}, not active`)
        this.#patchMission(missionId, { step })
        if (this.currentMissionId === missionId) this.leaseExpiry = Date.now() + LEASE_MS
        const extra = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : ""
        this.#push("rover", `STEP ${step} ${STEP_NAME[step]} (${missionId})${extra}`)
        return this.#findMission(missionId)
    }

    async complete(missionId: string, result: MissionResult): Promise<Mission> {
        this.#findMission(missionId)
        this.#patchMission(missionId, { status: "done", result })
        if (result.photoUrl) this.lastEvidenceUrl = result.photoUrl
        if (this.currentMissionId === missionId) this.#releaseMission()
        this.#push("rover", `DONE ${missionId}: ${result.verdict}`)
        const done = this.#findMission(missionId)
        this.#trimFinished()
        return done
    }

    async fail(missionId: string, error: string): Promise<Mission> {
        this.#findMission(missionId)
        this.#patchMission(missionId, { status: "failed", error })
        if (this.currentMissionId === missionId) this.#releaseMission()
        this.#push("rover", `FAILED ${missionId}: ${error}`, "error")
        const failed = this.#findMission(missionId)
        this.#trimFinished()
        return failed
    }

    async command(agentId: string, cmd: RoverCommand): Promise<{ ok: boolean; reason?: string }> {
        if (agentId !== "rover" && this.possessedBy && agentId !== this.possessedBy) {
            const reason = `rover is possessed by ${this.possessedBy}`
            this.#push(agentId, `REJECTED: ${reason}`, "reject")
            return { ok: false, reason }
        }
        if (this.mode === "estopped" && cmd !== "stop") {
            const reason = "rover is e-stopped"
            this.#push(agentId, `REJECTED: ${reason}`, "reject")
            return { ok: false, reason }
        }
        this.#push(agentId, `COMMAND ${cmd}`)
        return { ok: true }
    }

    async estop(agentId: string): Promise<RoverMode> {
        this.mode = "estopped"
        this.#push(agentId, "E-STOP", "error")
        return this.mode
    }

    async resume(agentId: string): Promise<RoverMode> {
        this.mode = this.currentMissionId ? "executing" : "idle"
        this.#push(agentId, `RESUME -> ${this.mode}`)
        return this.mode
    }

    async recover(): Promise<Mission | null> {
        if (!this.currentMissionId) return null
        const m = this.missions.find(x => x.id === this.currentMissionId && x.status === "active")
        if (!m) return null
        this.#push("actor", `RECOVER ${m.id} at step ${m.step} of 5`)
        return m
    }

    async setPose(at: Point | null, heading: Heading): Promise<void> {
        this.pose = { at, heading }
    }

    async heartbeat(): Promise<number> {
        const now = Date.now()
        this.lastHeartbeat = now
        if (this.mode === "offline") {
            this.mode = this.currentMissionId ? "executing" : this.modeBeforeOffline === "estopped" ? "estopped" : "idle"
            this.#push("actor", `rover back ONLINE -> ${this.mode}`)
        }
        this.alarm.set(now + HEARTBEAT_TIMEOUT_MS)
        return now
    }

    async onAlarm(): Promise<void> {
        const last = this.lastHeartbeat
        if (last === null || this.mode === "offline") return
        const silent = Date.now() - last
        if (silent >= HEARTBEAT_TIMEOUT_MS) {
            this.modeBeforeOffline = this.mode
            this.mode = "offline"
            this.#push("actor", `rover OFFLINE: no heartbeat for ${Math.round(silent / 1000)} s`, "error")
        } else {
            this.alarm.set(last + HEARTBEAT_TIMEOUT_MS)
        }
    }

    async logEvent(source: string, text: string, kind?: LogEvent["kind"]): Promise<void> {
        this.#push(source, text, kind ?? "info")
    }

    async getState(): Promise<RoverState> {
        return {
            missions: this.missions,
            currentMissionId: this.currentMissionId,
            possessedBy: this.possessedBy,
            leaseExpiry: this.leaseExpiry,
            pose: this.pose,
            mode: this.mode,
            lastHeartbeat: this.lastHeartbeat,
            lastEvidenceUrl: this.lastEvidenceUrl,
            log: this.log,
        }
    }

    async reset(): Promise<RoverState> {
        this.missions = []
        this.currentMissionId = null
        this.possessedBy = null
        this.leaseExpiry = null
        this.pose = { at: 5, heading: 0 }
        this.mode = "idle"
        this.modeBeforeOffline = "idle"
        this.lastHeartbeat = null
        this.lastEvidenceUrl = null
        this.seq = 0
        this.log = []
        this.#push("actor", "RESET")
        return this.getState()
    }
}

const SEED_BAYS: Record<Bay, BaySlot> = {
    1: { shipmentId: "SHP-1038", destination: "Oakland, CA", status: "staged" },
    2: { shipmentId: "SHP-1042", destination: "Reno, NV", status: "staged" },
    3: { shipmentId: "SHP-1047", destination: "Portland, OR", status: "hold" },
    4: { shipmentId: "SHP-1051", destination: "Fresno, CA", status: "staged" },
}

export class Warehouse extends Actor {
    @Persisted @Emittable bays: Record<Bay, BaySlot> = SEED_BAYS

    async getState(): Promise<WarehouseState> {
        return { bays: this.bays }
    }

    async setBay(bay: Bay, patch: Partial<BaySlot>): Promise<WarehouseState> {
        if (!this.bays[bay]) throw new Error(`unknown bay ${bay}`)
        this.bays = { ...this.bays, [bay]: { ...this.bays[bay], ...patch } }
        return { bays: this.bays }
    }

    async reset(): Promise<WarehouseState> {
        this.bays = { ...SEED_BAYS }
        return { bays: this.bays }
    }
}
