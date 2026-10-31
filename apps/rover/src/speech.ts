import { SERVER_URL } from "./vision.js"

/** Speak through the /face page. Never throws. */
export async function say(text: string): Promise<void> {
    console.log(`[say] ${text}`)
    try {
        const r = await fetch(`${SERVER_URL}/api/say`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
            signal: AbortSignal.timeout(3000),
        })
        if (!r.ok) console.warn(`[say] HTTP ${r.status}`)
    } catch (e) {
        console.warn(`[say] failed: ${(e as Error).message}`)
    }
}
