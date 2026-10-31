# actors/: Terse Durable Actors (Rover + Warehouse)

`src/actors.ts` defines `Rover` (id `rover-1`) and `Warehouse` (id `wh-1`). `src/types.ts` is a local copy of the actor types in `packages/shared/src/types.ts`. If you change the shared types, mirror the change in the copy.

## Run

```sh
export PATH="$HOME/.bun/bin:$PATH"      # bun + terse (install: bunx terse-cli@latest install --yes)
cd actors
bun install                              # first time only
terse actor dev                          # local runtime on http://127.0.0.1:7100, no login needed
# in a second terminal, after changing actor methods:
terse actor generate                     # writes actors/generated/ (committed; other apps import it)
bun scripts/exercise.ts                  # calls every method and prints the results (it resets both actors)
bun scripts/exercise.ts --check          # read-only: prints the persisted state
```

Local state lives in `actors/.durable-actors/` (gitignored) and survives a dev-server restart.

## Using the client from apps (Node 20 / tsx / Bun)

`actors/generated/` is plain ESM JS with `.d.ts` files and its own copy of the runtime, so you don't need to install anything extra.

```ts
import { actors } from "../../actors/generated/index.js"   // adjust the relative path to your file

const rover = actors.Rover.get("rover-1")
const wh = actors.Warehouse.get("wh-1")

const { missionId, position } = await rover.submitMission({ from: "shipping-agent", priority: 1, bay: 2, shipmentId: "SHP-1042", question: "is it there?" })
const m = await rover.startNext()            // Mission | null
await rover.advance(m!.id, 2)                // persist before acting
const r = await rover.command("inventory-agent", "drive")   // { ok: false, reason: "rover is possessed by shipping-agent" }
const state = await rover.getState()         // RoverState
await wh.setBay(2, { status: "missing" })

// Browser websocket grant (do this in the server, hand websocketUrl to the page):
const { websocketUrl } = await actors.Rover.prepareWebsocket({ actorId: "rover-1", metadata: null })
// The page runs: new WebSocket(websocketUrl). The first message is {type:"state", state}, then {type:"state_update", changes} after each change.
// Open the socket before the grant's connectByMs deadline. Fetch a fresh grant for each reconnect.
```

Types: `actors.Rover.State`, `actors.Warehouse.State` (from `index.d.ts`).

## Configuration (env, read from `process.env` on each call, so load dotenv first)

| Var | Meaning |
|---|---|
| `TERSE_ACTOR_URL` | Unset means `http://127.0.0.1:7100/v1/projects/local/actors`. For a deployed project, use the URL `terse deploy` prints (`https://api.useterse.ai/<projectId>/actors`). To reach the dev server on the rover laptop from another machine, use `http://<laptop-ip>:7100/v1/projects/local/actors`. |
| `TERSE_API_KEY` | Required for any URL that is not localhost/127.0.0.1. Create it in app.useterse.ai under API keys. |
| `TERSE_ACTOR_SETUP_TIMEOUT_MS` | Optional websocket-grant timeout (1000 to 600000 ms). |

Caveat: the generated client only skips the API key for localhost. A LAN URL to another laptop's dev server needs a non-empty `TERSE_API_KEY` to pass the client check. This setup is untested; the simplest option is to run apps that call the actor on the same laptop as `terse actor dev`.

## Rover behaviour

- Queue order is priority (1 first), then `createdAt`. `position` is the index in the queued list, where 0 means it runs next.
- `startNext()` returns null while e-stopped or while a mission is active. Otherwise it sets `possessedBy = mission.from`, a lease of 120 s (renewed on `advance`), and mode `executing`.
- `command(agentId, cmd)` is allowed for `rover`, for the possessor, or for anyone when nobody possesses the rover. Otherwise it logs `REJECTED: rover is possessed by X` (kind `reject`). Commands other than `stop` are also rejected while e-stopped.
- `heartbeat()`: call it every 1 to 2 s. After 5 s with no heartbeat an alarm sets mode `offline` and logs it. The next heartbeat restores the previous mode.
- `complete`/`fail` clear `currentMissionId`/`possessedBy` and set mode `idle` (it stays `estopped` if e-stopped). The missions list keeps queued and active missions plus the last 30 finished ones. The log keeps the last 200 entries.
- Methods throw (the promise rejects) for an unknown mission id or for `advance` on a mission that is not active.
