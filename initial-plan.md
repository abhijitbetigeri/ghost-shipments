# Rover Relay: initial plan

> Draft for team review. Haunted Hacks (YC), Sat Oct 31. Hacking runs 11:00–16:00.
> Leave comments on anything you'd change: roles, scope, cut line.

AI agents can reason and write code, but they can't see or act in the physical world. **Rover Relay** gives any teammate's
agent a body it can message over **Agent Relay**. A **Terse Durable Actor** owns the rover's position and mission queue,
so agents never send conflicting orders and missions survive crashes.

**Stack:** Terse (body and memory) · Agent Relay (agent-to-agent messaging) · Mastra (brain) · Freestyle (code sandbox)

**Why a robot:** a robot shared by many agents has two hard problems: *who is in control* and *what happens after a crash*.
Terse solves both (one request at a time, state in SQLite, alarms). Relay solves how *any* agent reaches the robot.

---

## Hardware

Framework laptop · camera · microphone · speaker · Wi-Fi · Bluetooth · display · wheels · Arduino Uno · L298N motor driver · ultrasonic proximity sensor

## Architecture: reflexes, brain stem, mind

| Tier | Where | Latency | Does |
|---|---|---|---|
| **Reflexes** | Arduino Uno + L298N + ultrasonic | ~ms | Motor PWM. **Stops if an obstacle is under 20 cm.** **Stops if no command for 500 ms** (watchdog). Speed cap. Ignores the AI. |
| **Brain stem** | Framework laptop on the rover | 10–100 ms | `rover-bridge` process: USB serial to the Arduino, camera, speaker, display (eyes), Relay listener, Mastra pilot. Runs one step at a time. |
| **Mind** | Terse + Relay + Mastra + Freestyle | 100 ms+ | Mission queue, arbitration, pose, history, planning, agent conversation, testing new skills. |

**Rule:** safety lives in the lowest tier. The AI can never drive the rover into a wall, because the Arduino refuses.

```
teammate agents ──Relay (#rover, typed actions)──► rover-bridge (Framework)
                                                   │ forwards every request
                                                   ▼
                                     Terse actor  Rover("rover-1")
                                     queue · lease · e-stop · pose · inflight
                                                   │ pushes next step (WebSocket)
                                                   ▼
                       rover-bridge ──USB serial──► Arduino ──► L298N ──► wheels
                       Mastra pilot: mission → steps · vision "look" · speech
live board (actor state over WebSocket) ◄── browsers / big screen
new skills: written by an agent → Freestyle VM simulator → approved → real wheels
```

## What each technology does

### Terse: the `Rover` actor (source of truth)
```
@Persisted @Emittable pose        {x, y, heading}   // dead-reckoned estimate
@Persisted @Emittable mode        idle | executing | estopped | offline
@Persisted @Emittable controller  {agent, leaseUntil} | null
@Persisted            queue       [{id, by, priority, steps[], status}]
@Persisted            inflight    {stepId, startedAt} | null
SQLite table log                  every command: who, what, result, photo
```
- **Conflict rule:**
  - E-stop always wins, from anyone.
  - Higher priority preempts.
  - Equal priority is first-in-first-out, and the lease holder goes first. The lease expires through an alarm.
- **Crash rule:** a step is marked `inflight` before it runs. After a crash it is **not replayed blindly**: the rover re-observes
  (camera + distance) first, then continues.
- **Heartbeat:** `onAlarm` marks the rover `offline` if the bridge goes silent for more than 5 s and posts that to Relay.
- **Gotchas:**
  - `this.arr.push()` isn't saved, so reassign the array.
  - Re-run `terse actor generate` after changing methods.

### Agent Relay: the rover is `@rover`
- Typed actions (Zod): `rover.move`, `rover.turn`, `rover.stop`, `rover.look`, `rover.say`, `rover.mission`, `rover.status`,
  `rover.skill.submit`, `rover.skill.approve`.
- `availableTo` enforces roles. For example, only `@safety` can approve a skill.
- Every action goes through the actor, never straight to the motors.

### Mastra: the rover's pilot
- A `RoverPilot` Agent with tools for move, turn, distance, look (vision) and say. It turns a goal into steps and re-plans when blocked.
- Runs in the bridge on the Framework. Don't use Mastra memory or workflows; Terse owns state.

### Freestyle: test before wheels
- A small 2D simulator **we write**, running in a Freestyle VM. A fake rover takes the same commands as the Arduino, on a map of the taped arena.
- An agent's new skill **passes** if it:
  - never hits a wall,
  - stays in the arena,
  - finishes within N steps,
  - uses only allowed commands.
- The output is pass/fail and a path image.
- It catches logic bugs, not physics.
- Optionally, the VM also hosts the live board at a `*.style.dev` URL.

### Arduino serial protocol
```
F <ms> <speed>   forward      B <ms> <speed>   back
L <deg>  R <deg> turn (time-calibrated)
S                stop         D  → "D 42" (cm)      P → "OK"
replies: DONE <id> | BLOCKED <cm> | ERR
```

---

## Demo: Ghost Hunt (~2.5 min)

A "ghost" (a teammate in a sheet, or a printed ghost) hides in a taped ~2×2 m arena. Each of us drives our own agent in a
different role, and together the agents hunt it with one shared rover. The big screen shows the live board: map and rover
dot, queue, who holds control, the `#rover` feed and the latest photo.

### Cast
| Human | Agent | Role | Enforced power |
|---|---|---|---|
| P1 (presenter) | `@navigator` | Plans the route, sends missions | Holds the control lease |
| P2 | `@spotter` | Eyes: asks for photos and interprets them | `look`, `say` |
| P3 | `@safety` | Watches telemetry, can veto | E-stop and resume; only one who approves skills |
| P4 | `@engineer` | Writes new skills, tests them in Freestyle | `skill.submit` |
| (no human) | `@rover` | Mastra pilot on the Framework | The only one that touches the Arduino |

### Script
| Time | Beat | What happens | Proves |
|---|---|---|---|
| 0:00 | Hook | P1: "Agents can reason and code but can't see or touch anything. We gave four agents one shared body." | — |
| 0:15 | Mission | Navigator gets "find the ghost" and asks Spotter for eyes. The rover drives; the ultrasonic sensor stops it at a box. | Relay; hardware safety |
| 0:40 | Eyes | Spotter calls `look` and the photo appears. "Something white on the left." Navigator re-plans and the rover turns. | Camera + vision; coordination |
| 1:00 | Conflict | Engineer sends "spin" at the same moment Navigator sends "go left". The board shows the actor queueing by rule. Safety sends E-STOP, which wins instantly. | Terse: no conflicting orders |
| 1:25 | Crash | P4 kills the bridge mid-move. The wheels stop (watchdog). Restart: "resuming mission, re-observing first", and it continues. | Terse: missions survive crashes |
| 1:50 | New skill | Engineer writes "scan-sweep", which passes the Freestyle sim (path image shown). Safety approves and the real rover runs it. | Mastra + Freestyle; roles |
| 2:15 | Found | The rover finds the ghost, Spotter confirms, the speaker says a spooky line and the display shows FOUND. | Payoff |
| 2:25 | Close | "Any agent, any laptop, one body. No conflicting orders, survives crashes." | — |

During the demo:
- **P1** narrates and types the mission.
- **P2** places the ghost and prompts Spotter.
- **P3** owns both e-stops (keyboard and the motor-battery switch) and approves the skill.
- **P4** sends the conflicting order, does the crash and submits the skill.

---

## Build plan

| Who | 11:00–13:00 | 13:00–15:00 | 15:00–16:00 |
|---|---|---|---|
| Hardware | Arduino firmware: protocol, watchdog, ultrasonic stop; calibrate turns | Bridge serial layer, camera, speaker, eyes display | Tape the arena, charge batteries |
| Actor | `Rover` actor: queue, lease, inflight, alarms | Live board over WebSocket; `terse deploy` | Crash-beat rehearsal |
| Relay + Mastra | `@rover` + typed actions → actor | RoverPilot, vision `look`, `say` | Cross-laptop run from Claude Code |
| Freestyle | Freestyle sandbox + Mastra Workspace | 2D simulator + skill submit/approve | Host the board on style.dev |

### Priorities
**Must**
1. Arduino: protocol, ultrasonic stop, 500 ms watchdog, speed cap
2. Bridge: serial, camera snapshot, speaker, display
3. Terse actor: queue, priority, lease, e-stop, inflight + re-observe, heartbeat
4. Relay: 5 handles, `#rover`, typed actions with `availableTo`
5. Live board
6. Mastra pilot + vision

**— cut line: drop from the bottom if behind —**

7. Freestyle simulator + skill approve (drop the "New skill" beat if cut)
8. Mic voice commands, spooky voice, Supabase Storage for photos, Superserve sandbox for running skills

## Risks
- **Venue Wi-Fi:** give the rover its own phone hotspot. The Arduino reflexes work offline.
- **Power:**
  - Separate motor battery (the L298N drops ~2 V).
  - Common ground between the Uno and the L298N.
  - Physical kill switch.
- **Accuracy:** no wheel encoders, so the pose is an estimate and time-based turns drift. Calibrate on the stage floor and keep moves short.
- **Live demo:**
  - Pre-write prompts.
  - Rehearse the same ghost position.
  - **Record a backup video by 15:45.**
- **Rules:** all code, including the Arduino firmware, must be written at the event. Wiring and assembly beforehand are fine.

## Setup before 11:00
- [ ] Bun ≥ 1.4.2, then `bunx terse-cli@latest install`. Terse account and API key at app.useterse.ai
- [ ] `npm i -g agent-relay`. Create a shared Agent Relay workspace and invite all 4 of us
- [ ] Freestyle account (`npx freestyle@latest login`). OpenAI key (credits are handed out at check-in)
- [ ] Framework detects the Uno over USB. Arduino IDE or CLI installed. Camera, mic and speaker work
- [ ] Motors, L298N and ultrasonic sensor wired and tested. Batteries charged. Laptop mounted
- [ ] Phone hotspot, tape for the arena, a white sheet for the ghost, costumes
- [ ] Builderbase signup at check-in. Submit before 16:00

## Open questions for the hosts
- Terse: can an actor make outbound HTTP calls and read env secrets? Are there quotas on a same-day `terse deploy`?
- Agent Relay: what's the recommended way to forward Relay messages into an actor that sleeps?

## Docs
docs.useterse.ai · agentrelay.com/docs · github.com/agentworkforce/relay · mastra.ai/docs · freestyle.sh/docs
