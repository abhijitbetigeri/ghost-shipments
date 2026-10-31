// Serial link to the rover firmware (DECISIONS.md protocol) + a FakeLink for no-hardware runs.
// Line-based: one command in flight at a time (mutex). Moves may get `P` keepalives while waiting.

import { existsSync, unlinkSync } from "node:fs"

export interface SendOpts {
    /** send `P` every 200 ms while waiting for the reply (moves; firmware watchdog is 500 ms) */
    keepalive?: boolean
    /** leg hint for FakeLink.blockOn, e.g. [5, 2] */
    leg?: [number, number]
}

export interface Link {
    /** send one command, resolve with its reply line; rejects with Error("serial_timeout") */
    send(line: string, timeoutMs: number, opts?: SendOpts): Promise<string>
    /** write immediately, bypassing the mutex (used for `S` mid-move) */
    writeNow(line: string): void
    close(): Promise<void>
    readonly name: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Which reply lines terminate a given command (others, e.g. stale keepalive `OK`s, are ignored). */
export function isReplyFor(cmd: string, line: string): boolean {
    const c = cmd.trim().charAt(0).toUpperCase()
    if (line === "ERR") return true
    switch (c) {
        case "D":
            return /^D\s+-?\d+/.test(line)
        case "P":
        case "S":
            return line === "OK"
        case "F":
        case "B":
        case "L":
        case "R":
        case "M":
            // keepalive `OK`s are ignored; WATCHDOG = firmware stopped the move (no line for 500 ms)
            return /^(DONE|BLOCKED|WATCHDOG)\b/.test(line)
        default:
            return true
    }
}

class Mutex {
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

// ---------------------------------------------------------------------------------------------
// Real hardware
// ---------------------------------------------------------------------------------------------

export async function findArduinoPort(): Promise<string | null> {
    if (process.env.SERIAL_PORT) return process.env.SERIAL_PORT
    const { SerialPort } = await import("serialport")
    const ports = await SerialPort.list()
    const re = /usbmodem|usbserial|ttyACM|ttyUSB|^COM\d+/i
    const hit =
        ports.find((p) => re.test(p.path) && /arduino|2341|1a86|wch|ch340/i.test(`${p.manufacturer ?? ""} ${p.vendorId ?? ""}`)) ??
        ports.find((p) => re.test(p.path))
    // macOS: prefer /dev/cu.* over /dev/tty.* (tty blocks on DCD)
    return hit ? hit.path.replace("/dev/tty.", "/dev/cu.") : null
}

export class SerialLink implements Link {
    private mutex = new Mutex()
    private buf = ""
    private waiter: ((line: string) => void) | null = null
    onLine: (line: string) => void = () => {}
    private constructor(
        private port: import("serialport").SerialPort,
        public readonly name: string,
    ) {
        port.on("data", (chunk: Buffer) => {
            this.buf += chunk.toString("utf8")
            let i: number
            while ((i = this.buf.search(/\r?\n/)) >= 0) {
                const line = this.buf.slice(0, i).trim()
                this.buf = this.buf.slice(i + (this.buf[i] === "\r" ? 2 : 1))
                if (!line) continue
                if (line === "READY") console.warn("[serial] READY (firmware booted/reset)")
                this.onLine(line)
                this.waiter?.(line)
            }
        })
        port.on("error", (e) => console.error("[serial] error:", e.message))
        port.on("close", () => console.error("[serial] port closed"))
    }

    static async open(path?: string): Promise<SerialLink> {
        const p = path ?? (await findArduinoPort())
        if (!p) throw new Error("no Arduino serial port found (set SERIAL_PORT)")
        const { SerialPort } = await import("serialport")
        const port = new SerialPort({ path: p, baudRate: 115200, autoOpen: false })
        await new Promise<void>((res, rej) => port.open((e) => (e ? rej(e) : res())))
        const link = new SerialLink(port, p)
        // opening resets the Uno: wait for READY or 2.5 s
        await new Promise<void>((res) => {
            const t = setTimeout(res, 2500)
            link.waiter = (l) => {
                if (l === "READY") {
                    clearTimeout(t)
                    res()
                }
            }
        })
        link.waiter = null
        console.log(`[serial] open ${p} @115200`)
        return link
    }

    writeNow(line: string): void {
        this.port.write(line + "\n")
    }

    send(line: string, timeoutMs: number, opts: SendOpts = {}): Promise<string> {
        return this.mutex.run(
            () =>
                new Promise<string>((resolve, reject) => {
                    let ka: NodeJS.Timeout | undefined
                    const done = (fn: () => void) => {
                        clearTimeout(to)
                        if (ka) clearInterval(ka)
                        this.waiter = null
                        fn()
                    }
                    const to = setTimeout(() => done(() => reject(new Error("serial_timeout"))), timeoutMs)
                    this.waiter = (l) => {
                        if (isReplyFor(line, l)) done(() => resolve(l))
                    }
                    this.writeNow(line)
                    if (opts.keepalive) ka = setInterval(() => this.writeNow("P"), 200)
                }),
        )
    }

    async close() {
        await new Promise<void>((r) => this.port.close(() => r()))
    }
}

// ---------------------------------------------------------------------------------------------
// Fake (ROVER_FAKE=1)
// ---------------------------------------------------------------------------------------------

export interface FakeLinkOptions {
    /** key "a-b" (leg) → cm: the forward move on that leg replies `BLOCKED <cm>` */
    blockOn?: Record<string, number>
    fast?: boolean
    distanceCm?: number
}

export class FakeLink implements Link {
    readonly name = "fake"
    private mutex = new Mutex()
    private abort: (() => void) | null = null
    /** every line written, in order (keepalives excluded) — for tests */
    readonly sent: string[] = []
    blockOn: Record<string, number>
    fast: boolean
    distanceCm: number
    constructor(o: FakeLinkOptions = {}) {
        this.blockOn = o.blockOn ?? {}
        this.fast = o.fast ?? process.env.ROVER_FAKE_FAST === "1"
        this.distanceCm = o.distanceCm ?? 120
    }

    writeNow(line: string): void {
        this.sent.push(line)
        if (line.trim().toUpperCase() === "S") this.abort?.()
    }

    private wait(ms: number) {
        const real = this.fast ? Math.min(ms, 300) : ms
        return new Promise<boolean>((res) => {
            const t = setTimeout(() => res(false), real)
            this.abort = () => {
                clearTimeout(t)
                res(true)
            }
        }).finally(() => (this.abort = null))
    }

    send(line: string, timeoutMs: number, opts: SendOpts = {}): Promise<string> {
        return this.mutex.run(async () => {
            this.sent.push(line)
            const [c, ...args] = line.trim().split(/\s+/)
            const n = args.map(Number)
            const reply = await (async () => {
                switch (c.toUpperCase()) {
                    case "P":
                    case "S":
                        return "OK"
                    case "D":
                        return `D ${this.distanceCm}`
                    case "L":
                    case "R":
                        if (!Number.isFinite(n[0])) return "ERR"
                        await this.wait(Math.min(n[0] * 6, 3000)) // ~firmware MS_PER_DEG, so the demo paces like real turns
                        return "DONE"
                    case "B":
                        await this.wait(Math.min(n[0] ?? 0, 3000))
                        return "DONE"
                    case "M":
                        await this.wait(Math.min(n[2] ?? 0, 3000))
                        return "DONE"
                    case "F": {
                        const key = opts.leg ? `${opts.leg[0]}-${opts.leg[1]}` : ""
                        // Demo obstacle: `touch apps/rover/.block` (or ROVER_FAKE_BLOCK_FILE) makes the next forward move BLOCKED.
                        const blockFile = process.env.ROVER_FAKE_BLOCK_FILE ?? new URL("../.block", import.meta.url).pathname
                        let cm = this.blockOn[key]
                        if (cm === undefined && existsSync(blockFile)) {
                            cm = 18
                            try { unlinkSync(blockFile) } catch {}
                        }
                        if (cm !== undefined) {
                            await this.wait(Math.min(n[0] ?? 0, 3000) / 3)
                            return `BLOCKED ${cm}`
                        }
                        await this.wait(Math.min(n[0] ?? 0, 3000))
                        return "DONE"
                    }
                    default:
                        return "ERR"
                }
            })()
            if (timeoutMs <= 0) throw new Error("serial_timeout")
            return reply
        })
    }

    async close() {}
}

export async function openLink(): Promise<Link> {
    if (process.env.ROVER_FAKE === "1") {
        console.log("[serial] ROVER_FAKE=1 → FakeLink")
        return new FakeLink()
    }
    return SerialLink.open()
}

export { sleep }
