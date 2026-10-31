import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { WebSocket } from "ws"

// supabase-js refuses to start on Node 20 without a global WebSocket.
;(globalThis as any).WebSocket ??= WebSocket

let sb: SupabaseClient | null = null

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let t: NodeJS.Timeout
    return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error("timeout")), ms)))]).finally(() =>
        clearTimeout(t),
    )
}

/** Upload a JPEG to the `evidence` bucket; returns its public URL or null. Never throws. */
export async function uploadEvidence(jpegB64: string, missionId: string): Promise<string | null> {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY
    if (!url || !key) {
        console.warn("[evidence] SUPABASE_URL / SUPABASE_SERVICE_KEY not set")
        return null
    }
    try {
        sb ??= createClient(url, key, { auth: { persistSession: false } })
        const path = `missions/${missionId}-${Date.now()}.jpg`
        const { error } = await withTimeout(
            sb.storage.from("evidence").upload(path, Buffer.from(jpegB64, "base64"), { contentType: "image/jpeg", upsert: true }),
            8000,
        )
        if (error) throw error
        return sb.storage.from("evidence").getPublicUrl(path).data.publicUrl
    } catch (e) {
        console.error("[evidence] upload failed:", (e as Error).message)
        return null
    }
}
