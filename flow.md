> Historical planning doc. The final design is in [DECISIONS.md](DECISIONS.md) and [README.md](README.md).

# Rover Relay: overall flow

**In one sentence:** agents talk over **Agent Relay**, the **Terse actor** decides, the **bridge** executes, the **Arduino** keeps it safe,
and every decision shows up live on the **board**.

Interfaces (serial protocol, step and result JSON, actor methods, Relay actions) are in [initial-plan.md](initial-plan.md).
The 5-point map and the Python `drive(from_point, to_point)` method the rover agent calls are in [hardware-tests.md](hardware-tests.md) Part B.
The hardware calibration values come from [hardware-tests.md](hardware-tests.md).

## Main flow: "@rover, find the ghost"

```
 P1 types ─► @navigator (Claude Code, P1's laptop)
                │ ① Relay: rover.mission {goal:"find the ghost", priority:1}
                ▼
         Agent Relay (cloud)
                │ ② delivered to @rover
                ▼
   rover agent (Python, on the Framework on the rover)
                │ ③ turns the goal into map steps on the fixed 5-point map:
                │    [goto 2, look, goto 5, goto 1, look …]   (points 1–5, see hardware-tests.md Part B)
                │ ④ actor.enqueue(@navigator, steps, priority)
                ▼
   Terse Rover actor (cloud) ── the source of truth
                │ ⑤ checks the rules: e-stop? who holds control? priority? → accepted and queued
                │ ⑥ marks step 1 "inflight", pushes it to the bridge (WebSocket)
                │    and pushes new state to the board (map, queue, controller)
                ▼
   rover agent
                │ ⑦ runStep → drive(from_point, to_point)  (Python, routes via 5)
                │    → USB serial "R 90", then "F 1250 150"
                ▼
   Arduino ─► L298N ─► wheels move
                │ ⑧ ultrasonic sensor: obstacle under 20 cm → stops itself → "BLOCKED 18"
                ▼
   rover agent  ─► ⑨ actor.reportStep({blockedCm:18, leg:[5,2], at:null})
                │
   Terse actor  ─► ⑩ updates the position estimate, logs it, clears inflight,
                │    (position = point 1–5, or unknown until re-homed), tells the rover agent to re-plan, posts to #rover:
                │    "@rover: blocked at 18 cm"
                ▼
   Relay ─► @navigator and @spotter see it
            @spotter: rover.look → bridge takes a camera photo → OpenAI vision
            → photo saved, caption "white shape, left side" → posted in #rover → shown on the board
            @navigator re-plans: "go to point 4, look again" → back to ①
```

Repeat until Spotter confirms the ghost. Then the rover says a spooky line through its speaker and its screen shows FOUND.

**Who does what:**
- **Relay** carries every conversation.
- **The actor** decides every move.
- **The bridge** is the only thing connected to the wheels.
- **The Arduino** can refuse any move, whatever the AI says.

## Side flows (the demo beats)

### Conflicting orders
```
@navigator "go left" ─┐
                      ├─► actor (one request at a time) → applies the rule → only one runs
@engineer  "spin"    ─┘                                   the other waits in the queue (board shows it)
@safety    E-STOP    ───► actor → mode=estopped → bridge sends "S" right away → wheels stop
                          (only @safety can resume)
```

### Crash and recovery
```
kill the bridge mid-move ─► no commands for 500 ms ─► Arduino stops the wheels by itself
actor: step still "inflight", heartbeat alarm notices silence → "rover offline" posted to #rover
restart the bridge ─► actor: "inflight step may or may not have happened"
                  ─► sends look + distance first (re-observe) ─► then continues the same mission
```

### New skill
```
@engineer ─► Mastra coding agent writes "scan-sweep" inside a Freestyle VM
          ─► rover.skill.submit ─► runs in a Superserve sandbox against the 2D simulator
          ─► PASS + path image shown on the board
@safety   ─► rover.skill.approve (Relay allows only @safety to call this)
          ─► the skill runs in a locked-down Superserve sandbox → can only reach the actor
          ─► the actor queues its steps like any other mission → same path ⑥–⑩ → wheels
```

## The live board (always on the big screen)
The Terse actor pushes its state over WebSocket, and the board on Freestyle's `style.dev` address shows it:
- the map with the rover dot
- the mission queue
- who holds control
- the #rover feed
- the latest photo
- the mode (idle, executing, emergency-stopped or offline)

## Who owns which box
| Box in the flow | Owner |
|---|---|
| Arduino, bridge serial layer, camera, speaker, eyes display | A: Hardware |
| Terse `Rover` actor (steps ④–⑥, ⑨–⑩, conflict rule, crash recovery) | B: Actor |
| Relay workspace, typed actions, role agents, Mastra RoverPilot, vision | C: Relay + Mastra |
| Live board, Freestyle hosting and workspace, Superserve simulator | D: Board + sandboxes |
