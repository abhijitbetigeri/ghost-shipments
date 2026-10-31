// Shared contracts. Change only with the whole team; see DECISIONS.md.

export type Point = 1 | 2 | 3 | 4 | 5 // 5 = home/dock, 1-4 = bays A-D
export type Bay = 1 | 2 | 3 | 4
export const BAY_NAME: Record<Bay, string> = { 1: "A", 2: "B", 3: "C", 4: "D" }
export type Heading = 0 | 90 | 180 | 270
export type Priority = 1 | 2 | 3 // P1 most urgent

export type MissionStatus = "queued" | "active" | "done" | "failed"
export type MissionStep = 1 | 2 | 3 | 4 | 5 // ACCEPT, DRIVE, ALIGN, INSPECT, REPORT
export const STEP_NAME: Record<MissionStep, string> = {
    1: "ACCEPT",
    2: "DRIVE",
    3: "ALIGN",
    4: "INSPECT",
    5: "REPORT",
}

export interface MissionInput {
    from: string // relay handle of the requesting agent, e.g. "shipping-agent"
    priority: Priority
    bay: Bay
    shipmentId: string // e.g. "SHP-1042"
    question: string
    threadId?: string // relay message id to reply to
}

export interface Inspection {
    present: boolean // is a package with a label visible in the bay?
    shipmentId: string | null // as read from the label
    destination: string | null
    damaged: boolean
    labelStatus: "ready" | "hold" | "unknown"
    confidence: number // 0..1
    summary: string // one sentence, spoken aloud
}

export interface MissionResult {
    inspection: Inspection | null
    photoUrl: string | null
    verdict: "confirmed" | "ghost" | "mismatch" | "damaged" | "inconclusive"
}

export interface Mission extends MissionInput {
    id: string // "M-0001"
    status: MissionStatus
    step: MissionStep
    createdAt: number
    result?: MissionResult
    error?: string
}

export type RoverMode = "idle" | "executing" | "estopped" | "offline"

export interface LogEvent {
    t: number
    source: string // "relay" | "rover" | "actor" | agent handle
    text: string
    kind?: "info" | "reject" | "error"
}

export interface RoverState {
    missions: Mission[] // queued + recent
    currentMissionId: string | null
    possessedBy: string | null // agent handle that currently controls the rover
    leaseExpiry: number | null
    pose: { at: Point | null; heading: Heading } // at=null means unknown until re-homed
    mode: RoverMode
    lastHeartbeat: number | null
    lastEvidenceUrl: string | null
    log: LogEvent[] // last 200
}

export type BayStatus = "staged" | "missing" | "hold"
export interface BaySlot {
    shipmentId: string
    destination: string
    status: BayStatus // "missing" = the ghost shipment (box removed)
}
export interface WarehouseState {
    bays: Record<Bay, BaySlot>
}

export type RoverCommand = "drive" | "stop" | "home"
