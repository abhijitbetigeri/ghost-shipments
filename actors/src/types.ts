// Copy of the actor-facing parts of packages/shared/src/types.ts.
// Kept local so the Terse bundler and `terse actor generate` see a self-contained project.
// If you change packages/shared/src/types.ts, mirror the change here.

export type Point = 1 | 2 | 3 | 4 | 5
export type Bay = 1 | 2 | 3 | 4
export type Heading = 0 | 90 | 180 | 270
export type Priority = 1 | 2 | 3

export type MissionStatus = "queued" | "active" | "done" | "failed"
export type MissionStep = 1 | 2 | 3 | 4 | 5
export const STEP_NAME: Record<MissionStep, string> = {
    1: "ACCEPT",
    2: "DRIVE",
    3: "ALIGN",
    4: "INSPECT",
    5: "REPORT",
}

export interface MissionInput {
    from: string
    priority: Priority
    bay: Bay
    shipmentId: string
    question: string
    threadId?: string
}

export interface Inspection {
    present: boolean
    shipmentId: string | null
    destination: string | null
    damaged: boolean
    labelStatus: "ready" | "hold" | "unknown"
    confidence: number
    summary: string
}

export interface MissionResult {
    inspection: Inspection | null
    photoUrl: string | null
    verdict: "confirmed" | "ghost" | "mismatch" | "damaged" | "inconclusive"
}

export interface Mission extends MissionInput {
    id: string
    status: MissionStatus
    step: MissionStep
    createdAt: number
    result?: MissionResult
    error?: string
}

export type RoverMode = "idle" | "executing" | "estopped" | "offline"

export interface LogEvent {
    t: number
    source: string
    text: string
    kind?: "info" | "reject" | "error"
}

export interface RoverState {
    missions: Mission[]
    currentMissionId: string | null
    possessedBy: string | null
    leaseExpiry: number | null
    pose: { at: Point | null; heading: Heading }
    mode: RoverMode
    lastHeartbeat: number | null
    lastEvidenceUrl: string | null
    log: LogEvent[]
}

export type BayStatus = "staged" | "missing" | "hold"
export interface BaySlot {
    shipmentId: string
    destination: string
    status: BayStatus
}
export interface WarehouseState {
    bays: Record<Bay, BaySlot>
}

export type RoverCommand = "drive" | "stop" | "home"
