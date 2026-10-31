// Fallback trigger when Agent Relay is overloaded: submit a mission straight to the Terse actor.
// usage: npx tsx scripts/page-direct.mts B SHP-1042
import { actors } from "../actors/generated/index.js"
const bay = ({ A: 1, B: 2, C: 3, D: 4 } as const)[(process.argv[2] ?? "B").toUpperCase() as "A" | "B" | "C" | "D"] ?? 2
const shipmentId = process.argv[3] ?? "SHP-1042"
const r = await actors.Rover.get("rover-1").submitMission({ from: "shipping-agent", priority: 1, bay, shipmentId, question: `is ${shipmentId} in bay ${process.argv[2] ?? "B"}?` })
console.log("submitted", r)
