// Mission loop: recover → poll startNext() → ACCEPT, DRIVE, ALIGN, INSPECT, REPORT → drive home.
// Each step is persisted with advance() BEFORE acting on it, so a restart resumes at that step.
import type { Bay, Inspection, Mission, MissionResult, MissionStep, RoverState } from "@app/shared/types"
import { BAY_NAME } from "@app/shared/types"
import { actor, logEvent } from "./actor.js"
import type { DriveResult, Rover } from "./drive.js"
import { uploadEvidence } from "./evidence.js"
import { say } from "./speech.js"
import { align, capture, inconclusive, inspect } from "./vision.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type Reporter = (m: Mission, result: MissionResult, sentence: string) => Promise<void>

class EStopped extends Error {
    constructor() {
        super("estopped")
    }
}

export function verdictOf(ins: Inspection | null, expectedId: string): MissionResult["verdict"] {
    if (!ins || ins.confidence < 0.6) return "inconclusive"
    if (!ins.present) return "ghost"
    const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")
    if (ins.shipmentId && norm(ins.shipmentId) !== norm(expectedId)) return "mismatch"
    if (!ins.shipmentId) return "inconclusive"
    if (ins.damaged) return "damaged"
    return "confirmed"
}

export function sentenceFor(m: Pick<Mission, "bay" | "shipmentId">, r: MissionResult): string {
    const bay = `bay ${BAY_NAME[m.bay]}`
    const ins = r.inspection
    switch (r.verdict) {
        case "ghost":
            return `Ghost shipment! ${bay[0].toUpperCase() + bay.slice(1)} is empty. ${m.shipmentId} is not here.`
        case "mismatch":
            return `Mismatch in ${bay}: expected ${m.shipmentId}, but the label says ${ins?.shipmentId}.`
        case "damaged":
            return `${m.shipmentId} is in ${bay}, but it looks damaged.${ins?.destination ? ` Bound for ${ins.destination}.` : ""}`
        case "confirmed":
            return `${m.shipmentId} confirmed in ${bay}${ins?.destination ? `, bound for ${ins.destination}` : ""}.${ins?.labelStatus === "hold" ? " Label says HOLD." : ""}`
        default:
            return `Inspection of ${bay} for ${m.shipmentId} is inconclusive. A human should check.`
    }
}

export class Executor {
    state: RoverState | null = null
    reporter: Reporter | null = null
    private ins = new Map<string, Inspection>()
    private frames = new Map<string, string>()

    constructor(private rover: Rover) {}

    /** poll actor state; on transition into estopped → stop the motors at once */
    startStateWatch(everyMs = 500) {
        let lastMode: string | null = null
        setInterval(async () => {
            try {
                const s = await actor.getState()
                this.state = s
                if (s.mode === "estopped" && lastMode !== "estopped") {
                    console.warn("[exec] E-STOP from actor → S")
                    await this.rover.stop()
                    void actor.setPose(null, this.rover.heading).catch(() => {})
                }
                lastMode = s.mode
                // someone re-homed the rover via the actor (server "home" button → setPose(5, 0))
                if (this.rover.at === null && s.pose.at === 5 && s.mode !== "estopped") {
                    console.log("[exec] actor pose says at=5 → home()")
                    this.rover.home(5, s.pose.heading)
                }
            } catch {}
        }, everyMs).unref?.()
    }

    private async checkEstop() {
        const s = await actor.getState()
        this.state = s
        if (s.mode === "estopped") {
            await this.rover.stop()
            throw new EStopped()
        }
    }

    private async waitWhileEstopped() {
        let said = false
        for (;;) {
            const s = await actor.getState().catch(() => null)
            if (s && s.mode !== "estopped") return
            if (!said) await say("Emergency stop. Waiting.")
            said = true
            await sleep(1000)
        }
    }

    private async ensurePose(): Promise<void> {
        let said = false
        while (this.rover.at === null) {
            const s = await actor.getState().catch(() => null)
            if (s?.pose.at === 5 && s.mode !== "estopped") {
                this.rover.home(5, s.pose.heading)
                break
            }
            if (!said) await say("I don't know where I am. Please place me at home, facing bay A, and press home.")
            said = true
            await sleep(1000)
        }
    }

    private async driveTo(to: 1 | 2 | 3 | 4 | 5): Promise<DriveResult | null> {
        await this.ensurePose()
        if (this.rover.at === to) return null
        const res = await this.rover.drive(this.rover.at!, to)
        await actor.setPose(res.at, res.heading).catch(() => {})
        logEvent("rover", `drive → ${to}: ${res.ok ? "ok" : res.error} ${JSON.stringify(res.legs.map((l) => [l.frm, l.to, l.status, l.blockedCm ?? null]))}`)
        if (!res.ok) {
            if (res.error === "blocked") await say(`Path blocked ${res.legs.at(-1)?.blockedCm ?? ""} centimeters ahead. I stopped.`)
            throw new Error(`drive_${res.error}`)
        }
        return res
    }

    async run(): Promise<never> {
        // ---- recover (retry until the actor answers: skipping it would strand an active mission forever)
        for (let attempt = 0; ; attempt++) {
          try {
            await actor.getState()
            break
          } catch (e) {
            if (attempt % 10 === 0) console.error("[exec] actor unreachable, retrying recover:", (e as Error).message)
            await sleep(1000)
          }
        }
        try {
            const s = await actor.getState()
            this.state = s
            if (s.pose.at === 5) this.rover.home(5, s.pose.heading)
            else {
                this.rover.at = null
                console.warn(`[exec] actor pose at=${s.pose.at}; pose unknown until re-homed`)
            }
            const m = await actor.recover()
            // resuming after DRIVE finished: the rover was parked at the bay (pose is only set after a successful drive)
            if (m && this.rover.at === null && m.step >= 3 && s.pose.at === m.bay) this.rover.home(m.bay, s.pose.heading)
            if (m) {
                await say(`Resuming mission, step ${m.step} of 5.`)
                if (this.rover.at === null) await say("My position is unknown.")
                await this.runMission(m, m.step)
            }
        } catch (e) {
            console.error("[exec] recover failed:", (e as Error).message)
        }
        // ---- main loop
        let lastErr = ""
        for (;;) {
            try {
                const m = await actor.startNext()
                lastErr = ""
                if (m) await this.runMission(m, 1)
                else await sleep(1000)
            } catch (e) {
                const msg = (e as Error).message
                if (msg !== lastErr) console.error("[exec] loop error:", msg)
                lastErr = msg
                await sleep(1000)
            }
        }
    }

    private async runMission(m: Mission, from: MissionStep) {
        const bayName = BAY_NAME[m.bay]
        try {
            for (let step = from; step <= 5; step++) {
                await this.checkEstop()
                await actor.advance(m.id, step as MissionStep)
                await this.doStep(m, step as MissionStep)
            }
        } catch (e) {
            await this.rover.stop().catch(() => {})
            await actor.setPose(null, this.rover.heading).catch(() => {})
            const msg = (e as Error).message
            if (e instanceof EStopped) {
                await actor.fail(m.id, "estopped").catch(() => {})
                await say(`Mission for bay ${bayName} aborted: emergency stop.`)
                await this.waitWhileEstopped()
            } else {
                console.error(`[exec] mission ${m.id} failed:`, msg)
                await actor.fail(m.id, msg).catch((err) => console.error("[exec] fail() failed:", err.message))
                await say("Mission failed.")
            }
            return
        } finally {
            this.ins.delete(m.id)
            this.frames.delete(m.id)
        }
        // back to the dock (mission already complete; a failure here only affects pose)
        try {
            await this.driveTo(5)
        } catch (e) {
            console.error("[exec] return home failed:", (e as Error).message)
            await this.rover.stop().catch(() => {})
        }
    }

    private async doStep(m: Mission, step: MissionStep) {
        const bay = m.bay as Bay
        switch (step) {
            case 1:
                await say(`Boot sequence complete. Heading to bay ${BAY_NAME[bay]} for ${m.shipmentId}.`)
                return
            case 2:
                await this.driveTo(bay)
                return
            case 3: {
                for (let i = 0; i < 3 && this.rover.at !== null; i++) {
                    const frame = await capture()
                    const a = await align(frame)
                    logEvent("rover", `align ${i + 1}: ${JSON.stringify(a)}`)
                    if (!a.visible || (a.horizontal === "center" && a.distance === "ok")) break
                    if (a.horizontal === "left") await this.rover.nudge("left")
                    else if (a.horizontal === "right") await this.rover.nudge("right")
                    else if (a.distance === "far") await this.rover.nudge("forward")
                    else if (a.distance === "near") await this.rover.nudge("back")
                }
                return
            }
            case 4: {
                let frame = await capture()
                let ins = await inspect(frame, { bay, shipmentId: m.shipmentId })
                if (ins.confidence < 0.6) {
                    frame = await capture()
                    const again = await inspect(frame, { bay, shipmentId: m.shipmentId })
                    if (again.confidence >= ins.confidence) ins = again
                }
                logEvent("rover", `inspect: ${JSON.stringify(ins)}`)
                this.ins.set(m.id, ins)
                this.frames.set(m.id, frame)
                return
            }
            case 5: {
                let ins = this.ins.get(m.id) ?? null
                let frame = this.frames.get(m.id) ?? null
                if (!ins || !frame) {
                    // resumed at REPORT after a crash: look again
                    frame = await capture().catch(() => null)
                    ins = frame ? await inspect(frame, { bay, shipmentId: m.shipmentId }) : inconclusive()
                }
                const photoUrl = frame ? await uploadEvidence(frame, m.id) : null
                const result: MissionResult = { inspection: ins, photoUrl, verdict: verdictOf(ins, m.shipmentId) }
                const sentence = sentenceFor(m, result)
                await say(sentence)
                if (this.reporter) await this.reporter(m, result, sentence).catch((e) => console.error("[exec] reporter failed:", e.message))
                await actor.complete(m.id, result)
                return
            }
        }
    }
}
