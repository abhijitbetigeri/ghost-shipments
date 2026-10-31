// inventory-agent: P2 cycle-count pages. `npm run inventory -- page C SHP-2001`
import "./env.ts"
import type { Bay } from "@app/shared/types"
import { parseBay, startPager, type Pager } from "./pager.ts"

export const HANDLE = "inventory-agent"

export async function startInventory(): Promise<Pager> {
    return startPager(HANDLE)
}

export async function cycleCount(p: Pager, bay: Bay, shipmentId: string) {
    return p.pageRover(bay, shipmentId, "cycle count", 2)
}

if (process.argv[1]?.endsWith("inventory-agent.ts")) {
    const p = await startInventory()
    const [cmd, bayArg, shp] = process.argv.slice(2)
    if (cmd === "page") await cycleCount(p, parseBay(bayArg ?? "C"), (shp ?? "SHP-2001").toUpperCase())
    console.log(`[${HANDLE}] online (Ctrl-C to quit)`)
}
