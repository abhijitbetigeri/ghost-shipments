// Interactive serial console for firmware testing: `npm run console -w apps/rover`.
// Sends raw protocol lines (F/B/L/R/M/S/D/P) with the same keepalive the rover uses,
// so moves are not cut short by the 500 ms watchdog like they are in the Serial Monitor.
// Extra commands: `drive A B` (uses drive.ts routing), `home`, `where`, `quit`.

import { createInterface } from "node:readline"
import { openLink } from "./serial-link.ts"
import { Rover, ARM_CM, CM_PER_SEC, MS_PER_DEG_L, MS_PER_DEG_R, NORMAL_SPEED } from "./drive.ts"
import type { Point } from "@app/shared/types"

const link = await openLink()
const rover = new Rover(link)
console.log(`[console] link: ${link.name}`)
console.log(`[console] ARM_CM=${JSON.stringify(ARM_CM)} CM_PER_SEC=${CM_PER_SEC} NORMAL_SPEED=${NORMAL_SPEED} MS_PER_DEG L/R=${MS_PER_DEG_L}/${MS_PER_DEG_R}`)
console.log("[console] type a protocol line (F 1000 150 | L 90 | S | D | P), or: drive 5 2 | home | where | quit")

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "rover> " })
rl.prompt()
// Run lines one at a time (piped input delivers them all at once).
let chain: Promise<unknown> = Promise.resolve()
rl.on("line", (raw) => {
    chain = chain.then(() => handle(raw))
})
async function handle(raw: string) {
    const line = raw.trim()
    if (!line) return rl.prompt()
    const [cmd, ...args] = line.split(/\s+/)
    const t0 = Date.now()
    try {
        if (cmd === "quit" || cmd === "exit") {
            await link.close()
            process.exit(0)
        } else if (cmd === "home") {
            rover.home()
            console.log("pose", rover.where())
        } else if (cmd === "where") {
            console.log("pose", rover.where())
        } else if (cmd === "drive") {
            const res = await rover.drive(Number(args[0]) as Point, Number(args[1]) as Point)
            console.log(JSON.stringify(res), `${Date.now() - t0} ms`)
        } else if (cmd.toUpperCase() === "S") {
            await rover.stop()
            console.log("stopped (pose unknown until `home`)")
        } else {
            const upper = cmd.toUpperCase()
            const isMove = ["F", "B", "L", "R", "M"].includes(upper)
            const ms = upper === "F" || upper === "B" ? Number(args[0]) : upper === "M" ? Number(args[2]) : Number(args[0]) * Math.max(MS_PER_DEG_L, MS_PER_DEG_R)
            const timeout = isMove ? (Number.isFinite(ms) ? ms : 3000) + 2000 : 1500
            const reply = await link.send([upper, ...args].join(" "), timeout, { keepalive: isMove })
            console.log(reply, `${Date.now() - t0} ms`)
        }
    } catch (e) {
        console.log("ERROR", (e as Error).message)
    }
    rl.prompt()
}
