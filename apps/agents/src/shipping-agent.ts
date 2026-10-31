// shipping-agent: pages @rover about P1 shipments, turns the rover's REPORT into a Supabase exception ticket.
// npm start                      -> stay online, listen for reports
// npm start -- page B SHP-1042   -> page once (then keep listening for the report)
import "./env.ts"
import { Agent } from "@mastra/core/agent"
import type { RelayMessage } from "@app/shared/relay"
import type { Bay, MissionResult } from "@app/shared/types"
import { BAY_NAME } from "@app/shared/types"
import { TEXT_MODEL, withTimeout } from "./llm.ts"
import { parseBay, startPager, type Pager } from "./pager.ts"
import { supabase } from "./supabase.ts"

export const HANDLE = "shipping-agent"

interface Report extends MissionResult {
    missionId: string
    shipmentId: string
    bay: Bay
}

let writer: Agent | null = null
async function summarize(r: Report): Promise<string> {
    const fallback = r.inspection?.summary ?? `Bay ${BAY_NAME[r.bay] ?? r.bay}: ${r.verdict}.`
    try {
        if (!process.env.OPENAI_API_KEY) return fallback
        writer ??= new Agent({
            name: "ticket-writer",
            instructions:
                "You write warehouse exception tickets. Given a rover inspection report as JSON, reply with ONE plain sentence " +
                "(max 30 words) a shift lead can act on: what was expected, what the rover found, and the verdict. No preamble.",
            model: TEXT_MODEL,
        })
        const res = await withTimeout(writer.generate(JSON.stringify(r)), 8000, "ticket summary")
        return res.text.trim().split("\n")[0] || fallback
    } catch (e) {
        console.warn(`[${HANDLE}] summary LLM failed (${(e as Error).message}); using inspection summary`)
        return fallback
    }
}

function parseReport(text: string): Report | null {
    const i = text.indexOf("REPORT ")
    if (i < 0) return null
    const line = text.slice(i + 7)
    const start = line.indexOf("{")
    const end = line.lastIndexOf("}")
    if (start < 0 || end < start) return null
    try {
        const raw = JSON.parse(line.slice(start, end + 1))
        // the rover nests verdict/inspection/photoUrl under `result`
        return (raw.result ? { ...raw, ...raw.result } : raw) as Report
    } catch {
        return null
    }
}

const handled = new Set<string>()
async function onMessage(m: RelayMessage, p: Pager) {
    if (m.from !== "rover") return
    const report = parseReport(m.text)
    if (!report) return
    const key = report.missionId ?? m.messageId
    if (handled.has(key)) return
    handled.add(key)
    const threadId = m.threadId ?? m.messageId
    const code = `EXC-${String(Math.floor(1000 + Math.random() * 9000))}`
    const summary = await summarize(report)
    try {
        const { error } = await withTimeout(
            Promise.resolve(
                supabase().from("tickets").insert({
                    code,
                    shipment_id: report.shipmentId ?? p.threads.get(threadId)?.shipmentId ?? null,
                    bay: report.bay ?? p.threads.get(threadId)?.bay ?? null,
                    verdict: report.verdict,
                    summary,
                    photo_url: report.photoUrl ?? null,
                    mission_id: report.missionId ?? null,
                    raw: report,
                }),
            ),
            8000,
            "supabase insert",
        )
        if (error) throw new Error(error.message)
        await p.reply(threadId, `Ticket ${code} created: ${report.verdict}. ${summary}`)
    } catch (e) {
        console.error(`[${HANDLE}] ticket insert failed:`, (e as Error).message)
        await p.reply(threadId, `Could not file ticket (${(e as Error).message}); verdict was ${report.verdict}.`).catch(() => {})
    }
}

export async function startShipping(): Promise<Pager> {
    return startPager(HANDLE, onMessage)
}

export async function pageRover(p: Pager, bay: Bay, shipmentId: string, reason = "truck departs 06:00", priority: 1 | 2 | 3 = 1) {
    return p.pageRover(bay, shipmentId, reason, priority)
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("shipping-agent.ts")
if (isMain) {
    const p = await startShipping()
    const [cmd, bayArg, shp] = process.argv.slice(2)
    if (cmd === "page") {
        await pageRover(p, parseBay(bayArg ?? "B"), (shp ?? "SHP-1042").toUpperCase())
    }
    console.log(`[${HANDLE}] listening for rover reports… (Ctrl-C to quit)`)
}
