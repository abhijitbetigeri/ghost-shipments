// drive(from, to) on the 5-point map — TypeScript port of hardware-tests.md Part B.
//
//            1  Bay A
//            |
// Bay D 4 -- 5 -- 2  Bay B      5 = HOME, heading toward 1 = 0°, 2 = 90°, 3 = 180°, 4 = 270°
//            |
//            3  Bay C           every path goes through 5
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Heading, Point } from "@app/shared/types"
import type { Link } from "./serial-link.js"

const here = dirname(fileURLToPath(import.meta.url))
export const CALIBRATION_FILE = join(here, "..", "calibration.json")

interface Calibration {
    cmPerSec?: number
    armCm?: Partial<Record<1 | 2 | 3 | 4, number>>
    normalSpeed?: number
    msPerDegL?: number
    msPerDegR?: number
}
function loadCalibration(): Calibration {
    try {
        if (existsSync(CALIBRATION_FILE)) return JSON.parse(readFileSync(CALIBRATION_FILE, "utf8"))
    } catch (e) {
        console.warn("[drive] bad calibration.json:", (e as Error).message)
    }
    return {}
}
const cal = loadCalibration()
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d)

// ---- constants (env > calibration.json > defaults) -----------------------------------------
export const ARM_CM: Record<1 | 2 | 3 | 4, number> = {
    1: num(process.env.ARM_CM_1 ?? process.env.ARM_CM, cal.armCm?.[1] ?? 80),
    2: num(process.env.ARM_CM_2 ?? process.env.ARM_CM, cal.armCm?.[2] ?? 80),
    3: num(process.env.ARM_CM_3 ?? process.env.ARM_CM, cal.armCm?.[3] ?? 80),
    4: num(process.env.ARM_CM_4 ?? process.env.ARM_CM, cal.armCm?.[4] ?? 80),
}
export const CM_PER_SEC = num(process.env.CM_PER_SEC, cal.cmPerSec ?? 30)
export const NORMAL_SPEED = num(process.env.NORMAL_SPEED, cal.normalSpeed ?? 150)
/** only used for reply timeouts; the turn itself is timed in firmware */
export const MS_PER_DEG_L = num(process.env.MS_PER_DEG_L, cal.msPerDegL ?? 6)
export const MS_PER_DEG_R = num(process.env.MS_PER_DEG_R, cal.msPerDegR ?? 6)
export const CLEAR_READING = 999
export const MAX_MOVE_MS = 3000 // firmware cap: longer F moves are split into chunks
export const HEADING_TO: Record<1 | 2 | 3 | 4, Heading> = { 1: 0, 2: 90, 3: 180, 4: 270 }

export type LegStatus = "DONE" | "BLOCKED" | "ERR"
export interface LegResult {
    frm: Point
    to: Point
    turnedDeg: number // + right, - left
    droveCm: number
    status: LegStatus
    blockedCm?: number
    elapsedMs: number
}
export interface DriveResult {
    ok: boolean
    at: Point | null
    heading: Heading
    legs: LegResult[]
    error?: "bad_point" | "state_mismatch" | "blocked" | "serial_timeout" | "firmware_err" | "watchdog" | "stopped"
}

const isPoint = (p: unknown): p is Point => p === 1 || p === 2 || p === 3 || p === 4 || p === 5
const norm360 = (d: number) => (((d % 360) + 360) % 360) as Heading
/** normalise to (-180, 180] */
export function normDelta(d: number): number {
    let x = ((d % 360) + 360) % 360
    if (x > 180) x -= 360
    return x
}

class Lock {
    private tail: Promise<void> = Promise.resolve()
    async run<T>(fn: () => Promise<T>): Promise<T> {
        const prev = this.tail
        let release!: () => void
        this.tail = new Promise<void>((r) => (release = r))
        await prev
        try {
            return await fn()
        } finally {
            release()
        }
    }
}

class MoveError extends Error {
    constructor(public code: "serial_timeout" | "firmware_err" | "watchdog" | "stopped") {
        super(code)
    }
}

export class Rover {
    at: Point | null
    heading: Heading
    /** small heading error introduced by ALIGN nudges (deg, + right); corrected on the next turn */
    private trimDeg = 0
    private lock = new Lock()
    private stopGen = 0

    constructor(
        public link: Link,
        opts: { at?: Point | null; heading?: Heading } = {},
    ) {
        this.at = opts.at === undefined ? 5 : opts.at
        this.heading = opts.heading ?? 0
    }

    where(): { at: Point | null; heading: Heading } {
        return { at: this.at, heading: this.heading }
    }

    /** a human placed the rover; no motion */
    home(point: Point = 5, heading: Heading = 0) {
        this.at = point
        this.heading = heading
        this.trimDeg = 0
    }

    /** E-stop: sends S immediately (bypasses the lock, works mid-move). Pose becomes unknown. */
    async stop(): Promise<void> {
        this.stopGen++
        this.at = null
        try {
            this.link.writeNow("S")
        } catch (e) {
            console.error("[drive] stop write failed:", (e as Error).message)
        }
    }

    async distance(): Promise<number> {
        return this.lock.run(async () => {
            const r = await this.link.send("D", 1000)
            const m = /^D\s+(-?\d+)/.exec(r)
            if (!m) throw new Error(`bad D reply: ${r}`)
            return Number(m[1])
        })
    }

    /** one move command; keepalives always on (firmware watchdog counts from the last line, turns > 500 ms too) */
    private async move(line: string, expectMs: number, leg?: [number, number]): Promise<string> {
        const gen = this.stopGen
        let reply: string
        try {
            reply = await this.link.send(line, expectMs + 2000, { keepalive: true, leg })
        } catch (e) {
            this.link.writeNow("S")
            throw new MoveError("serial_timeout")
        }
        if (gen !== this.stopGen) throw new MoveError("stopped")
        if (reply === "ERR") {
            this.link.writeNow("S")
            throw new MoveError("firmware_err")
        }
        if (reply.startsWith("WATCHDOG")) throw new MoveError("watchdog")
        return reply
    }

    private async turn(delta: number): Promise<void> {
        if (delta === 0) return
        const deg = Math.abs(Math.round(delta))
        const cmd = delta > 0 ? `R ${deg}` : `L ${deg}`
        await this.move(cmd, deg * (delta > 0 ? MS_PER_DEG_R : MS_PER_DEG_L))
    }

    drive(from: Point, to: Point): Promise<DriveResult> {
        return this.lock.run(() => this.driveLocked(from, to))
    }

    private async driveLocked(from: Point, to: Point): Promise<DriveResult> {
        const legs: LegResult[] = []
        const res = (ok: boolean, error?: DriveResult["error"]): DriveResult => ({
            ok,
            at: this.at,
            heading: this.heading,
            legs,
            ...(error ? { error } : {}),
        })
        // 1. validate
        if (!isPoint(from) || !isPoint(to) || from === to) return res(false, "bad_point")
        if (this.at === null || from !== this.at) return res(false, "state_mismatch")

        // 2. route
        const route: [Point, Point][] = from === 5 || to === 5 ? [[from, to]] : [[from, 5], [5, to]]

        // 3. legs
        for (const [a, b] of route) {
            const t0 = Date.now()
            const arm = (a === 5 ? b : a) as 1 | 2 | 3 | 4
            const target = a === 5 ? HEADING_TO[b as 1 | 2 | 3 | 4] : norm360(HEADING_TO[a as 1 | 2 | 3 | 4] + 180)
            const delta = normDelta(target - this.heading - this.trimDeg)
            const leg: LegResult = { frm: a, to: b, turnedDeg: delta, droveCm: 0, status: "DONE", elapsedMs: 0 }
            legs.push(leg)
            try {
                await this.turn(delta)
                this.heading = target
                this.trimDeg = 0

                let remainingMs = Math.round((ARM_CM[arm] / CM_PER_SEC) * 1000)
                while (remainingMs > 0) {
                    const ms = Math.min(remainingMs, MAX_MOVE_MS)
                    const reply = await this.move(`F ${ms} ${NORMAL_SPEED}`, ms, [a, b])
                    const blocked = /^BLOCKED\s+(-?\d+)/.exec(reply)
                    if (blocked) {
                        leg.status = "BLOCKED"
                        leg.blockedCm = Number(blocked[1])
                        leg.elapsedMs = Date.now() - t0
                        leg.droveCm = Math.round((leg.droveCm + (leg.elapsedMs / 1000) * CM_PER_SEC) * 10) / 10
                        this.at = null
                        await this.link.send("S", 1000).catch(() => {})
                        return res(false, "blocked")
                    }
                    leg.droveCm += (ms / 1000) * CM_PER_SEC
                    remainingMs -= ms
                }
                leg.droveCm = Math.round(leg.droveCm * 10) / 10
                leg.elapsedMs = Date.now() - t0
                this.at = b
            } catch (e) {
                leg.status = "ERR"
                leg.elapsedMs = Date.now() - t0
                this.at = null
                const code = e instanceof MoveError ? e.code : "firmware_err"
                return res(false, code)
            }
        }
        return res(true)
    }

    /**
     * Small correction for ALIGN. Does not change `at`.
     * left/right: turn 10°, remembered as trim and undone on the next leg's turn.
     * forward/back: a short straight move.
     */
    nudge(dir: "left" | "right" | "forward" | "back", deg = 10): Promise<string> {
        return this.lock.run(async () => {
            if (this.at === null) throw new Error("pose unknown: home() first")
            try {
                switch (dir) {
                    case "left":
                        await this.turn(-deg)
                        this.trimDeg -= deg
                        return "DONE"
                    case "right":
                        await this.turn(deg)
                        this.trimDeg += deg
                        return "DONE"
                    case "forward":
                        return await this.move(`M 120 120 250`, 250)
                    case "back":
                        return await this.move(`B 250 120`, 250)
                }
            } catch (e) {
                this.at = null
                throw e
            }
        })
    }
}
