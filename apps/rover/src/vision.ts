// Camera frame (via the server's /face page) + OpenAI vision for INSPECT and ALIGN.
import { readFileSync } from "node:fs"
import OpenAI from "openai"
import { z } from "zod"
import type { Bay, Inspection } from "@app/shared/types"
import { BAY_NAME } from "@app/shared/types"

export const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:8787"
const VISION_MODEL = process.env.VISION_MODEL ?? "gpt-5.5"

// 16x16 grey JPEG, used only with ROVER_FAKE=1 when the server/webcam is unavailable
const PLACEHOLDER_JPEG =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwAooooA/9k="

export async function capture(): Promise<string> {
    try {
        const r = await fetch(`${SERVER_URL}/api/capture`, { method: "POST", signal: AbortSignal.timeout(5000) })
        if (!r.ok) throw new Error(`capture HTTP ${r.status}`)
        const j = (await r.json()) as { jpegBase64?: string }
        if (!j.jpegBase64) throw new Error("capture: no jpegBase64")
        return j.jpegBase64.replace(/^data:image\/\w+;base64,/, "")
    } catch (e) {
        if (process.env.ROVER_FAKE === "1") {
            console.warn(`[vision] capture failed (${(e as Error).message}); using fake frame`)
            if (process.env.FAKE_FRAME) {
                try {
                    return readFileSync(process.env.FAKE_FRAME).toString("base64")
                } catch {}
            }
            return PLACEHOLDER_JPEG
        }
        throw e
    }
}

let client: OpenAI | null = null
const openai = () => (client ??= new OpenAI({ timeout: 15_000, maxRetries: 0 }))

async function askJson<T>(schemaName: string, schema: Record<string, unknown>, zod: z.ZodType<T>, prompt: string, jpegB64: string): Promise<T> {
    const r = await openai().chat.completions.create(
        {
            model: VISION_MODEL,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpegB64}` } },
                    ],
                },
            ],
            response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
        },
        { signal: AbortSignal.timeout(15_000) },
    )
    const text = r.choices[0]?.message?.content ?? ""
    return zod.parse(JSON.parse(text))
}

const InspectionZ = z.object({
    present: z.boolean(),
    shipmentId: z.string().nullable(),
    destination: z.string().nullable(),
    damaged: z.boolean(),
    labelStatus: z.enum(["ready", "hold", "unknown"]),
    confidence: z.number().min(0).max(1),
    summary: z.string(),
})
const InspectionSchema = {
    type: "object",
    additionalProperties: false,
    required: ["present", "shipmentId", "destination", "damaged", "labelStatus", "confidence", "summary"],
    properties: {
        present: { type: "boolean", description: "is a package / box with a shipping label visible in the bay?" },
        shipmentId: { type: ["string", "null"], description: "shipment id exactly as printed on the label, e.g. SHP-1042" },
        destination: { type: ["string", "null"], description: "destination city on the label" },
        damaged: { type: "boolean", description: "visible damage: crushed, torn, wet, open" },
        labelStatus: { type: "string", enum: ["ready", "hold", "unknown"] },
        confidence: { type: "number", description: "0..1" },
        summary: { type: "string", description: "one short sentence to be spoken aloud" },
    },
}

export function inconclusive(why = "inconclusive"): Inspection {
    return {
        present: false,
        shipmentId: null,
        destination: null,
        damaged: false,
        labelStatus: "unknown",
        confidence: 0,
        summary: why,
    }
}

export async function inspect(jpegB64: string, expected: { bay: Bay; shipmentId: string }): Promise<Inspection> {
    try {
        const prompt =
            `You are a warehouse rover camera at bay ${BAY_NAME[expected.bay]}. The system expects shipment ${expected.shipmentId} here. ` +
            `Look for a box or package with a shipping label (it may be a printed label or a phone screen showing a label). ` +
            `Read the shipment id and destination exactly as printed; do not assume they match what is expected. ` +
            `If no package is visible, present=false. Report visible damage. labelStatus is "hold" if the label says HOLD, "ready" if it says ready/staged, else "unknown".`
        return await askJson("inspection", InspectionSchema, InspectionZ, prompt, jpegB64)
    } catch (e) {
        console.error("[vision] inspect failed:", (e as Error).message)
        return inconclusive()
    }
}

export interface Alignment {
    visible: boolean
    horizontal: "left" | "center" | "right"
    distance: "far" | "ok" | "near"
}
const AlignZ = z.object({
    visible: z.boolean(),
    horizontal: z.enum(["left", "center", "right"]),
    distance: z.enum(["far", "ok", "near"]),
})
const AlignSchema = {
    type: "object",
    additionalProperties: false,
    required: ["visible", "horizontal", "distance"],
    properties: {
        visible: { type: "boolean", description: "is a box/package or shipping label visible?" },
        horizontal: { type: "string", enum: ["left", "center", "right"], description: "where the label/box is in the frame" },
        distance: {
            type: "string",
            enum: ["far", "ok", "near"],
            description: "far = label too small to read, near = cut off by the frame edges, ok = readable",
        },
    },
}

export async function align(jpegB64: string): Promise<Alignment> {
    try {
        return await askJson(
            "alignment",
            AlignSchema,
            AlignZ,
            "Rover camera framing check. Where is the shipping box / label in this frame, and is it at a readable distance?",
            jpegB64,
        )
    } catch (e) {
        console.error("[vision] align failed:", (e as Error).message)
        return { visible: false, horizontal: "center", distance: "ok" }
    }
}
