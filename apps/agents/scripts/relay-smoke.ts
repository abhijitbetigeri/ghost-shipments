// Real Agent Relay round trip: two agents, one posts to #warehouse, the other receives and replies in thread.
import "../src/env.ts"
import { connectAgent, ensureWorkspace, type RelayMessage } from "@app/shared/relay"

const key = await ensureWorkspace()
console.log("workspace key:", key.slice(0, 12) + "…")
const a = await connectAgent("smoke-a")
const b = await connectAgent("smoke-b")
console.log("connected:", a.handle, b.handle)

const nonce = `smoke ${Date.now()}`
const got = new Promise<RelayMessage>((res) => b.onMessage((m) => m.text.includes(nonce) && res(m)))
const replied = new Promise<RelayMessage>((res) => a.onMessage((m) => m.text.startsWith("ack") && res(m)))

await new Promise((r) => setTimeout(r, 1500)) // let websockets subscribe
const sent = await a.send("#warehouse", `hello from smoke-a: ${nonce}`)
console.log("a sent", sent)

const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))
const m = await Promise.race([got, timeout(15000)])
console.log("b received", m)
const r = await b.reply(m.messageId, `ack ${nonce}`)
console.log("b replied", r)
const back = await Promise.race([replied, timeout(15000)])
console.log("a received reply", back)
await a.close()
await b.close()
console.log("SMOKE OK")
process.exit(0)
