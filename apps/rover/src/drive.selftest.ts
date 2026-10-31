// ROVER_FAKE=1 ROVER_FAKE_FAST=1 npx tsx apps/rover/src/drive.selftest.ts
import assert from "node:assert/strict"
import { ARM_CM, CM_PER_SEC, NORMAL_SPEED, Rover } from "./drive.js"
import { FakeLink } from "./serial-link.js"

process.env.ROVER_FAKE_FAST = "1"
const fMs = (arm: 1 | 2 | 3 | 4) => Math.round((ARM_CM[arm] / CM_PER_SEC) * 1000)
const moves = (l: FakeLink) => l.sent.filter((s) => s !== "P" && s !== "S")
let n = 0
async function test(name: string, fn: () => Promise<void>) {
    await fn()
    n++
    console.log(`PASS ${name}`)
}

await test("drive(5,2): R 90 + F arm2, ends at 2 facing 90", async () => {
    const link = new FakeLink({ fast: true })
    const r = new Rover(link)
    const res = await r.drive(5, 2)
    assert.equal(res.ok, true)
    assert.deepEqual(r.where(), { at: 2, heading: 90 })
    assert.equal(res.legs.length, 1)
    assert.deepEqual(moves(link), ["R 90", `F ${fMs(2)} ${NORMAL_SPEED}`])
})

await test("drive(2,4): two legs via 5, R 180 then no turn (Part B worked example)", async () => {
    const link = new FakeLink({ fast: true })
    const r = new Rover(link, { at: 2, heading: 90 })
    const res = await r.drive(2, 4)
    assert.equal(res.ok, true)
    assert.equal(res.legs.length, 2)
    assert.deepEqual(
        res.legs.map((l) => [l.frm, l.to, l.turnedDeg, l.status]),
        [
            [2, 5, 180, "DONE"],
            [5, 4, 0, "DONE"],
        ],
    )
    assert.deepEqual(moves(link), ["R 180", `F ${fMs(2)} ${NORMAL_SPEED}`, `F ${fMs(4)} ${NORMAL_SPEED}`])
    assert.deepEqual(r.where(), { at: 4, heading: 270 })
})

await test("drive(5,4) from home = L 90; return 4→5 = R 180 → heading 90", async () => {
    const link = new FakeLink({ fast: true })
    const r = new Rover(link)
    await r.drive(5, 4)
    const back = await r.drive(4, 5)
    assert.equal(back.ok, true)
    assert.deepEqual(moves(link).filter((m) => !m.startsWith("F")), ["L 90", "R 180"])
    assert.deepEqual(r.where(), { at: 5, heading: 90 })
})

await test("state_mismatch and bad_point move nothing", async () => {
    const link = new FakeLink({ fast: true })
    const r = new Rover(link) // at 5
    const a = await r.drive(1, 2)
    assert.equal(a.ok, false)
    assert.equal(a.error, "state_mismatch")
    const b = await r.drive(5, 5)
    assert.equal(b.error, "bad_point")
    const c = await r.drive(5, 9 as never)
    assert.equal(c.error, "bad_point")
    assert.equal(link.sent.length, 0)
    assert.deepEqual(r.where(), { at: 5, heading: 0 })
})

await test("blocked leg → at=null, refusal until home()", async () => {
    const link = new FakeLink({ fast: true, blockOn: { "5-2": 18 } })
    const r = new Rover(link)
    const res = await r.drive(5, 2)
    assert.equal(res.ok, false)
    assert.equal(res.error, "blocked")
    assert.equal(res.at, null)
    assert.equal(res.legs[0].status, "BLOCKED")
    assert.equal(res.legs[0].blockedCm, 18)
    const before = link.sent.length
    const refused = await r.drive(5, 4)
    assert.equal(refused.error, "state_mismatch")
    assert.equal(link.sent.length, before, "no motion while pose unknown")
    r.home()
    link.blockOn = {}
    const ok = await r.drive(5, 4)
    assert.equal(ok.ok, true)
    assert.equal(ok.at, 4)
})

await test("stop() mid-move → S sent, at=null, then refused", async () => {
    const link = new FakeLink({ fast: true })
    const r = new Rover(link)
    const p = r.drive(5, 1)
    await new Promise((res) => setTimeout(res, 50))
    await r.stop()
    const res = await p
    assert.equal(res.ok, false)
    assert.equal(res.at, null)
    assert.ok(link.sent.includes("S"))
    assert.equal((await r.drive(5, 1)).error, "state_mismatch")
})

await test("nudge right then drive back corrects trim (R 180 - 10 = R 170)", async () => {
    const link = new FakeLink({ fast: true })
    const r = new Rover(link)
    await r.drive(5, 2)
    await r.nudge("right")
    await r.drive(2, 5)
    assert.deepEqual(moves(link).filter((m) => !m.startsWith("F")), ["R 90", "R 10", "R 170"])
    assert.deepEqual(r.where(), { at: 5, heading: 270 })
})

await test("two drives at once serialize (lock)", async () => {
    const link = new FakeLink({ fast: true })
    const r = new Rover(link)
    const [a, b] = await Promise.all([r.drive(5, 1), r.drive(1, 5)])
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.equal(r.where().at, 5)
})

await test("distance() wraps D", async () => {
    const r = new Rover(new FakeLink({ fast: true }))
    assert.equal(await r.distance(), 120)
})

console.log(`\nALL ${n} TESTS PASSED`)
