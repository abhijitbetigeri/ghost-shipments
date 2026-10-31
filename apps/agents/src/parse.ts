// parsePage: plain-English page ("@rover check bay B for SHP-1042, truck leaves at 6") -> MissionInput fields.
// Mastra agent with structured output; regex fallback if the LLM fails or takes > 8 s.
import { Agent } from "@mastra/core/agent"
import { z } from "zod"
import type { Bay, Priority } from "@app/shared/types"
import { TEXT_MODEL, withTimeout } from "./llm.ts"

export interface ParsedPage {
    bay: Bay
    shipmentId: string
    question: string
    priority: Priority
}

const schema = z.object({
    bay: z.number().int().min(1).max(4).describe("Bay number: A=1, B=2, C=3, D=4"),
    shipmentId: z.string().describe('Shipment id like "SHP-1042", or "" if none'),
    question: z.string().describe("What the requester wants to know, one short sentence"),
    priority: z.number().int().min(1).max(3).describe("1 = urgent (truck leaving soon), 2 = routine/cycle count, 3 = low"),
})

let agent: Agent | null = null
function parser(): Agent {
    agent ??= new Agent({
        name: "page-parser",
        instructions:
            "You turn warehouse pages to a rover into structured fields. Bays are letters A-D mapping to 1-4. " +
            "Priority 1 if a truck/departure/urgent is mentioned or the text says P1; 2 for cycle counts or P2; otherwise 2. " +
            "Shipment ids look like SHP-1234; normalise to upper case.",
        model: TEXT_MODEL,
    })
    return agent
}

const BAY_LETTER: Record<string, Bay> = { A: 1, B: 2, C: 3, D: 4 }

export function parsePageRegex(text: string): ParsedPage {
    const bayM = text.match(/\bbay\s*([A-D1-4])\b/i)
    const raw = bayM?.[1]?.toUpperCase()
    const bay: Bay = raw ? (BAY_LETTER[raw] ?? (Number(raw) as Bay)) : 2
    const shp = text.match(/\bSHP[-\s]?(\d+)\b/i)
    const shipmentId = shp ? `SHP-${shp[1]}` : ""
    const pM = text.match(/\bP([1-3])\b/i)
    const priority: Priority = pM ? (Number(pM[1]) as Priority) : /truck|depart|leav|urgent|asap/i.test(text) ? 1 : 2
    const question = text.replace(/^\s*@\w[\w-]*[:,]?\s*/, "").trim() || `Is ${shipmentId || "the shipment"} in bay ${raw ?? "B"}?`
    return { bay, shipmentId, question, priority }
}

export async function parsePage(text: string): Promise<ParsedPage> {
    try {
        if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY unset")
        const res = await withTimeout(parser().generate(text, { structuredOutput: { schema } }), 8000, "parsePage LLM")
        const o = res.object as z.infer<typeof schema>
        const fb = parsePageRegex(text)
        return {
            bay: o.bay as Bay,
            shipmentId: (o.shipmentId || fb.shipmentId).toUpperCase(),
            question: o.question || fb.question,
            priority: o.priority as Priority,
        }
    } catch (e) {
        console.warn(`[parse] LLM failed (${(e as Error).message}); using regex fallback`)
        return parsePageRegex(text)
    }
}
