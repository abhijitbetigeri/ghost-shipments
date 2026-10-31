# Rover Relay: initial plan

> Draft for team review. Haunted Hacks (YC), Sat Oct 31. Hacking runs 11:00–16:00.
> Leave comments on anything you'd change: roles, scope, cut line.

AI agents can reason and write code, but they can't see or act in the physical world. **Rover Relay** gives any teammate's
agent a body it can message over **Agent Relay**. A **Terse Durable Actor** owns the rover's position and mission queue,
so agents never send conflicting orders and missions survive crashes.

**Stack:**
- Hosts: Terse (body and memory) · Agent Relay (agent-to-agent messaging)
- Organizers: Freestyle (where agents write code) · Superserve (where untrusted code runs)
- Also: Mastra (brain) · OpenAI (vision, models, voice) · Supabase (photo storage)

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
| **Mind** | Terse + Relay + Mastra + Freestyle + Superserve | 100 ms+ | Mission queue, arbitration, pose, history, planning, agent conversation, testing new skills. |

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
new skills: written in Freestyle VM → tested in Superserve sandbox (sim) → @safety approves → runs in Superserve → actor → wheels
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

### Freestyle: where agents write code (organizer)
- `@engineer`'s Mastra coding agent works in a Freestyle VM, through a Mastra Workspace (Freestyle publishes a guide for this).
  It writes new rover skills there.
- The VM also hosts the **live board** at a public `*.style.dev` URL, so judges can open it on their phones. This part is cheap,
  so do it even if the "New skill" beat is cut.
- Pause and resume: the actor stores the `vmId`, so after a crash the engineer's workspace comes back as it was.

### Superserve: where untrusted code runs (organizer)
Any agent can send code to a physical robot, so that code only ever runs inside a Superserve sandbox:
- **Simulate:** a small 2D simulator **we write**. A fake rover takes the same commands as the Arduino, on a map of the taped arena.
  - A skill **passes** if it never hits a wall, stays in the arena, finishes within N steps and uses only allowed commands.
  - The output is pass/fail and a path image.
  - It catches logic bugs, not physics.
- **Run live:** after `@safety` approves, the skill runs in a Superserve sandbox whose **network rules allow only the Terse
  actor URL**. It can't reach the bridge, the Arduino or the internet directly.
- **Secrets never enter the sandbox:** the Terse key is bound through Superserve's secret proxy, so a bad skill can't leak it.
  The network log shows judges that the skill only talked to the actor.
- **Optional, if time allows:** snapshot the simulator and fork 3–5 copies to test candidate plans in parallel. (SDK method names not verified yet.)

### OpenAI (event sponsor)
- Models for the Mastra agents, and vision for `rover.look`.
- Optional: the Realtime API (`gpt-realtime-2.1`) gives the rover a live voice through its mic and speaker. That fits the event's "Real-Time AI" theme.

### Supabase (event sponsor)
- Storage bucket for camera snapshots: the actor log and Relay messages carry only the URL.
- Optional: a `fleet` table (one row per rover actor) for the "one actor per robot, scales to any fleet" story.

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
| P4 | `@engineer` | Writes new skills in Freestyle, tests them in Superserve | `skill.submit` |
| (no human) | `@rover` | Mastra pilot on the Framework | The only one that touches the Arduino |

### Script
| Time | Beat | What happens | Proves |
|---|---|---|---|
| 0:00 | Hook | P1: "Agents can reason and code but can't see or touch anything. We gave four agents one shared body." | — |
| 0:15 | Mission | Navigator gets "find the ghost" and asks Spotter for eyes. The rover drives; the ultrasonic sensor stops it at a box. | Relay; hardware safety |
| 0:40 | Eyes | Spotter calls `look` and the photo appears. "Something white on the left." Navigator re-plans and the rover turns. | Camera + vision; coordination |
| 1:00 | Conflict | Engineer sends "spin" at the same moment Navigator sends "go left". The board shows the actor queueing by rule. Safety sends E-STOP, which wins instantly. | Terse: no conflicting orders |
| 1:25 | Crash | P4 kills the bridge mid-move. The wheels stop (watchdog). Restart: "resuming mission, re-observing first", and it continues. | Terse: missions survive crashes |
| 1:50 | New skill | Engineer writes "scan-sweep" in Freestyle. It passes the simulator in a Superserve sandbox (path image shown). Safety approves, and it runs from the locked-down sandbox on the real rover. | Freestyle + Superserve; roles |
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
| Sandboxes | Freestyle VM + Mastra Workspace; host the board on style.dev | Superserve sandbox: 2D simulator, network rules, secret binding; skill submit/approve | Rehearse the "New skill" beat |

### Priorities
**Must**
1. Arduino: protocol, ultrasonic stop, 500 ms watchdog, speed cap
2. Bridge: serial, camera snapshot, speaker, display
3. Terse actor: queue, priority, lease, e-stop, inflight + re-observe, heartbeat
4. Relay: 5 handles, `#rover`, typed actions with `availableTo`
5. Live board, hosted on Freestyle (`*.style.dev`)
6. Mastra pilot + OpenAI vision
7. Superserve sandbox running the simulator, plus the Freestyle coding workspace and skill approve. Both organizers' tools are
   used here, so this is the last thing to cut.

**— cut line: drop from the bottom if behind —**

8. Superserve network rules and secret binding for the live run (if cut, show only the simulator step)
9. Supabase Storage for photos
10. OpenAI Realtime voice (mic and speaker), spooky voice, Supabase fleet table, Superserve forks

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
- [ ] Redeem the credit PDFs from the organizers: **Freestyle** (`npx freestyle@latest login`, `FREESTYLE_API_KEY`) and **Superserve**
      (`SUPERSERVE_API_KEY`, `npm i @superserve/sdk`)
- [ ] OpenAI key (credits handed out at check-in). Supabase project with a public `snapshots` bucket
- [ ] Framework detects the Uno over USB. Arduino IDE or CLI installed. Camera, mic and speaker work
- [ ] Motors, L298N and ultrasonic sensor wired and tested. Batteries charged. Laptop mounted
- [ ] Phone hotspot, tape for the arena, a white sheet for the ghost, costumes
- [ ] Builderbase signup at check-in. Submit before 16:00

## Open questions for the hosts
- Terse: can an actor make outbound HTTP calls and read env secrets? Are there quotas on a same-day `terse deploy`?
- Agent Relay: what's the recommended way to forward Relay messages into an actor that sleeps?

## Docs
docs.useterse.ai · agentrelay.com/docs · github.com/agentworkforce/relay · mastra.ai/docs · freestyle.sh/docs ·
docs.superserve.ai · developers.openai.com/api/docs · supabase.com/docs
