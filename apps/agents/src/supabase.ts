import "./env.ts"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { WebSocket } from "ws"

// supabase-js refuses to start on Node 20 without a global WebSocket.
;(globalThis as any).WebSocket ??= WebSocket

let sb: SupabaseClient | null = null
export function supabase(): SupabaseClient {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY
    if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set")
    sb ??= createClient(url, key, { auth: { persistSession: false } })
    return sb
}
