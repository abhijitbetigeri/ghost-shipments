// Ghost Shipments web server: /face, /bay, /dashboard pages + capture/say relay + actor proxy.
import express from "express"
import { createServer } from "node:http"
import { networkInterfaces } from "node:os"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { WebSocketServer, WebSocket } from "ws"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../../..")
const PORT = Number(process.env.SERVER_PORT ?? process.env.PORT ?? 8787)
const ACTOR_TIMEOUT_MS = Number(process.env.ACTOR_CALL_TIMEOUT_MS ?? 4000)
const CAPTURE_TIMEOUT_MS = 5000

const ACTOR_IDS = { Rover: "rover-1", Warehouse: "wh-1" } as const
type ActorName = keyof typeof ACTOR_IDS

// ---------- Terse generated client, loaded lazily so the server starts without it ----------
let actorsPromise: Promise<any> | null = null
async function loadActors(): Promise<any> {
    if (!actorsPromise) {
        const candidates = [
            process.env.ACTORS_CLIENT_PATH,
            resolve(repoRoot, "actors/generated/index.js"),
            resolve(repoRoot, "actors/generated/index.ts"),
            resolve(repoRoot, "apps/server/generated/index.js"),
            resolve(repoRoot, "apps/server/generated/index.ts"),
        ].filter(Boolean) as string[]
        const path = candidates.find((p) => existsSync(p))
        if (!path) return Promise.reject(new Error("actor client not generated yet (actors/generated/index.js missing)"))
        actorsPromise = import(pathToFileURL(path).href)
            .then((m) => m.actors ?? m.default?.actors ?? m.default ?? m)
            .catch((e) => {
                actorsPromise = null // retry next time
                throw e
            })
    }
    return actorsPromise
}

function withTimeout<T>(p: Promise<T>, ms = ACTOR_TIMEOUT_MS, what = "actor call"): Promise<T> {
    return new Promise<T>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)
        p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)))
    })
}

async function call(actor: ActorName, method: string, ...args: unknown[]): Promise<any> {
    const actors = await loadActors()
    const handle = actors[actor].get(ACTOR_IDS[actor])
    return withTimeout(Promise.resolve(handle[method](...args)), ACTOR_TIMEOUT_MS, `${actor}.${method}`)
}

function actorDown(res: express.Response, e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    res.status(503).json({ error: "actor server unavailable", message })
}

// ---------- App ----------
const app = express()
app.use(express.json({ limit: "10mb" }))
const pub = resolve(here, "../public")
app.get("/", (_req, res) => res.redirect("/dashboard"))
for (const page of ["face", "bay", "dashboard"]) {
    app.get(`/${page}`, (_req, res) => res.sendFile(resolve(pub, `${page}.html`)))
}
app.use(express.static(pub))

// ---------- /ws/face: webcam + speaker on the rover laptop ----------
const server = createServer(app)
const wss = new WebSocketServer({ server, path: "/ws/face" })
let face: WebSocket | null = null
let lastFrame: { jpeg: Buffer; t: number } | null = null
const pendingCaptures = new Map<string, (jpegBase64: string) => void>()

function stripDataUrl(b64: string) {
    const i = b64.indexOf("base64,")
    return i >= 0 ? b64.slice(i + 7) : b64
}

wss.on("connection", (ws) => {
    face = ws
    console.log("[face] connected")
    ws.on("message", (raw) => {
        let msg: any
        try {
            msg = JSON.parse(raw.toString())
        } catch {
            return
        }
        if (msg?.type === "frame" && typeof msg.jpegBase64 === "string") {
            const b64 = stripDataUrl(msg.jpegBase64)
            lastFrame = { jpeg: Buffer.from(b64, "base64"), t: Date.now() }
            if (msg.id && pendingCaptures.has(msg.id)) {
                pendingCaptures.get(msg.id)!(b64)
                pendingCaptures.delete(msg.id)
            }
        }
    })
    ws.on("close", () => {
        if (face === ws) face = null
        console.log("[face] disconnected")
    })
})

function faceSend(obj: unknown): boolean {
    if (!face || face.readyState !== WebSocket.OPEN) return false
    face.send(JSON.stringify(obj))
    return true
}

app.post("/api/capture", async (_req, res) => {
    const id = randomUUID()
    const got = new Promise<string>((resolveFrame) => pendingCaptures.set(id, resolveFrame))
    if (!faceSend({ type: "capture", id })) {
        pendingCaptures.delete(id)
        return res.status(503).json({ error: "face page not connected (open /face on the rover laptop)" })
    }
    try {
        const jpegBase64 = await withTimeout(got, CAPTURE_TIMEOUT_MS, "capture")
        res.json({ jpegBase64 })
    } catch (e) {
        pendingCaptures.delete(id)
        res.status(504).json({ error: (e as Error).message })
    }
})

app.post("/api/say", (req, res) => {
    const text = String(req.body?.text ?? "").trim()
    if (!text) return res.status(400).json({ error: "text required" })
    const delivered = faceSend({ type: "say", text })
    res.json({ ok: true, delivered })
})

app.get("/api/last-frame", (_req, res) => {
    if (!lastFrame) return res.status(204).end()
    res.set("Cache-Control", "no-store").set("X-Frame-Time", String(lastFrame.t)).type("image/jpeg").send(lastFrame.jpeg)
})

app.get("/api/face-status", (_req, res) => {
    res.json({ connected: !!face && face.readyState === WebSocket.OPEN, lastFrameAt: lastFrame?.t ?? null })
})

// ---------- Actor proxy ----------
app.get("/api/ws-url", async (req, res) => {
    const actor = String(req.query.actor ?? "Rover") as ActorName
    if (!(actor in ACTOR_IDS)) return res.status(400).json({ error: "actor must be Rover or Warehouse" })
    try {
        const actors = await loadActors()
        const grant = await withTimeout<any>(
            Promise.resolve(actors[actor].prepareWebsocket({ actorId: ACTOR_IDS[actor], metadata: { role: "viewer", page: String(req.query.page ?? "dashboard") } })),
            ACTOR_TIMEOUT_MS,
            `${actor}.prepareWebsocket`,
        )
        res.set("Cache-Control", "no-store").json({ websocketUrl: grant.websocketUrl ?? grant.url ?? grant })
    } catch (e) {
        actorDown(res, e)
    }
})

app.get("/api/state", async (_req, res) => {
    try {
        const [rover, warehouse] = await Promise.all([call("Rover", "getState"), call("Warehouse", "getState")])
        res.set("Cache-Control", "no-store").json({ rover, warehouse })
    } catch (e) {
        actorDown(res, e)
    }
})

app.post("/api/estop", async (_req, res) => {
    try {
        res.json({ ok: true, result: (await call("Rover", "estop", "dashboard")) ?? null })
    } catch (e) {
        actorDown(res, e)
    }
})

app.post("/api/resume", async (_req, res) => {
    try {
        res.json({ ok: true, result: (await call("Rover", "resume", "dashboard")) ?? null })
    } catch (e) {
        actorDown(res, e)
    }
})

// A human placed the rover on HOME facing Bay A; the rover waits for this after a block or e-stop.
app.post("/api/home", async (_req, res) => {
    try {
        res.json({ ok: true, result: (await call("Rover", "setPose", 5, 0)) ?? null })
    } catch (e) {
        actorDown(res, e)
    }
})

app.post("/api/bay/:n", async (req, res) => {
    const bay = Number(req.params.n)
    if (![1, 2, 3, 4].includes(bay)) return res.status(400).json({ error: "bay must be 1-4" })
    const patch: Record<string, unknown> = {}
    for (const k of ["status", "shipmentId", "destination"]) if (req.body?.[k] !== undefined) patch[k] = req.body[k]
    if (patch.status !== undefined && !["staged", "missing", "hold"].includes(String(patch.status)))
        return res.status(400).json({ error: "status must be staged|missing|hold" })
    try {
        res.json({ ok: true, result: (await call("Warehouse", "setBay", bay, patch)) ?? null })
    } catch (e) {
        actorDown(res, e)
    }
})

app.post("/api/reset", async (_req, res) => {
    try {
        await Promise.all([call("Rover", "reset"), call("Warehouse", "reset")])
        res.json({ ok: true })
    } catch (e) {
        actorDown(res, e)
    }
})

// ---------- Start ----------
function lanAddresses(): string[] {
    const out: string[] = []
    for (const list of Object.values(networkInterfaces()))
        for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address)
    return out
}

server.listen(PORT, "0.0.0.0", () => {
    const hosts = ["localhost", ...lanAddresses()]
    console.log(`Ghost Shipments server on :${PORT}`)
    for (const h of hosts) console.log(`  http://${h}:${PORT}/dashboard   /face   /bay?bay=2`)
    loadActors().then(
        () => console.log("[actors] generated client loaded"),
        (e) => console.log(`[actors] not available yet: ${e.message} (pages still render; API returns 503)`),
    )
})
