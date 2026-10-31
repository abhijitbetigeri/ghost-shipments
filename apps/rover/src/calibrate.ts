// npm run calibrate -w apps/rover : measure CM_PER_SEC and turn angles on the floor, write calibration.json
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { CALIBRATION_FILE, NORMAL_SPEED } from "./drive.js"
import { openLink } from "./serial-link.js"

const rl = createInterface({ input: process.stdin, output: process.stdout })
const ask = async (q: string, d?: number): Promise<number> => {
    for (;;) {
        const a = (await rl.question(`${q}${d !== undefined ? ` [${d}]` : ""}: `)).trim()
        if (!a && d !== undefined) return d
        const n = Number(a)
        if (Number.isFinite(n) && n > 0) return n
        console.log("  enter a positive number")
    }
}

const prev = existsSync(CALIBRATION_FILE) ? JSON.parse(readFileSync(CALIBRATION_FILE, "utf8")) : {}
const oldMsPerDegL = await ask("Current firmware MS_PER_DEG_L", prev.msPerDegL ?? 6)
const oldMsPerDegR = await ask("Current firmware MS_PER_DEG_R", prev.msPerDegR ?? 6)
const speed = await ask("Drive speed (PWM)", prev.normalSpeed ?? NORMAL_SPEED)

const link = await openLink()
const run = async (cmd: string, ms: number) => {
    const r = await link.send(cmd, ms + 2000, { keepalive: true })
    console.log(`  ${cmd} → ${r}`)
}

await rl.question(`\nPlace the rover with room ahead. Enter to run F 1000 ${speed}`)
await run(`F 1000 ${speed}`, 1000)
const cm = await ask("Measured distance travelled (cm)")
const cmPerSec = cm / 1.0

await rl.question("\nMark the heading. Enter to run L 90")
await run("L 90", 90 * oldMsPerDegL)
const degL = await ask("Measured left turn (deg)")

await rl.question("\nMark the heading. Enter to run R 90")
await run("R 90", 90 * oldMsPerDegR)
const degR = await ask("Measured right turn (deg)")

const msPerDegL = Math.round(((oldMsPerDegL * 90) / degL) * 100) / 100
const msPerDegR = Math.round(((oldMsPerDegR * 90) / degR) * 100) / 100
const armCm = prev.armCm ?? { 1: 80, 2: 80, 3: 80, 4: 80 }
for (const k of [1, 2, 3, 4] as const) armCm[k] = await ask(`ARM_CM[${k}] (measured 5→${k}, cm)`, armCm[k])

const out = { ...prev, cmPerSec, armCm, normalSpeed: speed, msPerDegL, msPerDegR, measuredAt: new Date().toISOString() }
writeFileSync(CALIBRATION_FILE, JSON.stringify(out, null, 2) + "\n")
console.log(`\nWrote ${CALIBRATION_FILE}:\n${JSON.stringify(out, null, 2)}`)
console.log(`\nPut these in firmware/rover/rover.ino and re-upload:\n  const float MS_PER_DEG_L = ${msPerDegL};\n  const float MS_PER_DEG_R = ${msPerDegR};`)
await link.close()
rl.close()
process.exit(0)
