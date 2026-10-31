# DECISIONS: this file overrides every other doc in the repo

Locked at 14:45 on 2026-10-31. Submission is due at 16:00. If another doc disagrees with this one, this one wins.

## Product: "Ghost Shipments", warehouse remote hands
It's 3 a.m. in a warehouse. The system says shipment **SHP-1042** is staged in **Bay B** for the 6 a.m. truck, but the scanner
never confirmed it. **`shipping-agent`** pages **`@rover`** over Agent Relay: "check bay B: is SHP-1042 there, what does the label say, any damage?"
The rover drives to Bay B, reads the shipping label with OpenAI vision, says what it found out loud, and replies in the Relay thread
with a photo. `shipping-agent` then files a Supabase exception ticket. A **ghost shipment** is one that's in the system but not on the shelf.

- **Conflict beat:** `shipping-agent` (P1, truck leaving) and `inventory-agent` (P2, cycle count) page the rover at the same moment.
  The Terse Rover actor queues them by priority. `inventory-agent` then tries to drive the rover directly and is **REJECTED**:
  "rover is possessed by shipping-agent".
- **Crash beat:** kill the rover process mid-mission. The Arduino watchdog stops the wheels. `run-rover.sh` restarts the process, it
  calls `Rover.recover()` and says "Resuming mission, step N of 5".

## Stack (all TypeScript, npm workspaces; Node 20 + tsx for apps, Bun for Terse actors)
| Piece | Tech |
|---|---|
| Durable state, queue, lock, crash recovery | **Terse Durable Actors** (`actors/`) |
| Agent-to-agent messages | **Agent Relay** `@agent-relay/sdk` (behind `packages/shared/src/relay.ts`) |
| Agent brains (message parsing, shipping/inventory agents) | **Mastra** `@mastra/core` with OpenAI models |
| Vision, speech fallback | **OpenAI** |
| Tickets, evidence photos | **Supabase** (table `tickets`, bucket `evidence`) |
| Dashboard hosting (stretch) | **Freestyle** `style.dev` |
| Superserve, the "new skill" beat, the old Ghost Hunt story | **Dropped** (no time) |

## Floor map (from hardware-tests.md Part B, unchanged)
```
            1  Bay A
            |
 Bay D 4 -- 5 -- 2  Bay B        5 = HOME / dock (rover starts here facing 1)
            |                    heading: toward 1 = 0°, 2 = 90°, 3 = 180°, 4 = 270°
            3  Bay C             every path goes through 5
```
**No physical boxes. Bays are floor coordinates** (cm, rover starts at HOME facing Bay A):

| Point | Name | x, y (cm) |
|---|---|---|
| 5 | HOME / dock | 0, 0 |
| 1 | Bay A | 0, +80 |
| 2 | Bay B | +80, 0 |
| 3 | Bay C | 0, -80 |
| 4 | Bay D | -80, 0 |

- `ARM_CM` = 80 for every arm (change in `apps/rover/calibration.json` if the space is smaller). A small tape "x" at HOME and Bay B helps
  calibration and re-homing but isn't required.
- **The "package" is a screen:** a teammate stands about 40 cm past Bay B, crouched so the screen is at the rover's camera height, and holds a phone
  showing `/bay?bay=2` (the shipping label) facing the rover. For the **ghost shipment**, they tap "Remove package" (an empty-shelf screen)
  or simply step away. A printed label taped to a chair leg works too.
- The ultrasonic sensor stops the rover if it gets within 20 cm of the person, so standing ~40 cm past the bay point is safe.

## Firmware serial protocol (NEW firmware, `firmware/rover/rover.ino`)
115200 baud, newline-terminated, one reply line per command. Boot prints `READY`.
| Cmd | Meaning | Reply |
|---|---|---|
| `F <ms> <speed>` | forward; obstacle under 20 cm stops it | `DONE` or `BLOCKED <cm>` |
| `B <ms> <speed>` | back (never blocked) | `DONE` |
| `L <deg>` / `R <deg>` | turn in place, using `MS_PER_DEG_L/R` constants in the firmware | `DONE` |
| `M <left> <right> <ms>` | raw tank drive, -255..255 (calibration, align nudges) | `DONE` |
| `S` | stop now (works mid-move) | `OK` |
| `D` | distance in cm (`999` = nothing in range) | `D <cm>` |
| `P` | ping / keepalive (harmless mid-move) | `OK` |
| anything else | | `ERR` |

- Moves are capped at 3000 ms. Speed is capped at `MAX_SPEED` 200.
- **Watchdog:** while moving, if no line arrives for 500 ms, stop. The host sends `P` every 200 ms during moves. (So killing the host mid-move stops the wheels: that's the crash beat.)
- Pins: ENA D5, ENB D6 (PWM), IN1 D7, IN2 D8, IN3 D9, IN4 D10, ultrasonic TRIG D2, ECHO D3. Motor invert flags as constants.

## Repo layout and owners
```
firmware/rover/rover.ino            firmware agent
actors/                             actors agent (Terse: Rover + Warehouse actors, generated client)
packages/shared/src/types.ts        shared types (written first, see below)
packages/shared/src/relay.ts        agents agent (Relay adapter, the only file that imports @agent-relay/sdk)
apps/rover/                         rover agent (serial link, drive(), mission executor, vision, Relay "rover" agent)
apps/server/ + apps/server/public/  web agent (Express on :8787; pages /face /bay /dashboard; capture/say relay)
apps/agents/                        agents agent (Mastra shipping-agent + inventory-agent, conflict script)
supabase/migrations/001_init.sql    agents agent
scripts/run-rover.sh                rover agent
.env.example                        everyone adds their variables
```

## Contracts between pieces
- **Actors** (local dev: `TERSE_ACTOR_URL=http://127.0.0.1:7100/v1/projects/local/actors`). The generated client is imported from `actors/generated/index.js`.
  - `Rover` id `rover-1`. Emitted state matches `RoverState` in `packages/shared/src/types.ts`. Methods:
    `submitMission(input) → {missionId, position}`, `startNext() → Mission|null`, `advance(missionId, step, data)`,
    `complete(missionId, result)`, `fail(missionId, error)`, `command(agentId, cmd) → {ok, reason?}`, `estop(agentId)`, `resume(agentId)`,
    `recover() → Mission|null`, `setPose(at, heading)`, `heartbeat()`, `logEvent(source, text)`, `getState() → RoverState`.
  - `Warehouse` id `wh-1`: `getState() → WarehouseState`, `setBay(bay, patch)`, `reset()`.
- **Server** (`http://<rover-laptop-ip>:8787`): `POST /api/capture → {jpegBase64}` (asks the /face page for a webcam frame),
  `POST /api/say {text}` (the /face page speaks), `GET /api/ws-url?actor=Rover|Warehouse` → `{websocketUrl}` for browsers,
  `POST /api/estop`, `POST /api/resume`, `POST /api/bay/:n {status}`, `POST /api/reset`.
- **Relay:** channel `#warehouse`. Handles `rover`, `shipping-agent`, `inventory-agent`. Every Relay message is also mirrored into
  `Rover.logEvent("relay", "<from>: <text>")`, so the dashboard shows the feed.
- **Mission steps:** 1 ACCEPT, 2 DRIVE (`drive(5, bay)`), 3 ALIGN, 4 INSPECT (vision → `Inspection`), 5 REPORT (upload photo,
  speak, Relay reply, `complete`), then drive back to 5. **Persist each step with `advance()` before acting on it.**

## Rules for everyone
- Never fake Terse or Agent Relay. If a sponsor API blocks you for more than 15 min, tell the team.
- Motors stop on any error. Secrets only in `.env` (gitignored). No auth, no over-engineering.
- Every external call gets a timeout. If vision fails, the rover says "inconclusive" instead of hanging.
