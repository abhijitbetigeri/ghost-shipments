> Historical planning doc. The final design is in [DECISIONS.md](DECISIONS.md) and [README.md](README.md).

# Rover hardware test plan (Arduino + L298N + ultrasonic)

**For:** the hardware owner. **Time box:** ~25 min. Test **on the demo floor** if possible.
Fill in the **Report back** table at the end and post it in the team chat: the actor, the bridge and the simulator all need these numbers.

Safety first: wheels off the ground (rover on a box) for tests 1–3. Keep a hand on the motor battery switch.

## How to run a test
1. Open the **Arduino IDE → Serial Monitor**, or any serial terminal, on the Framework laptop. Set the baud to match the firmware and the line ending to **Newline**.
2. Type a command (for example `F 500 150`) and press Enter.
3. **Watch** the rover: does it do the expected thing? **Read** the reply in the monitor: `DONE`, `BLOCKED 18`, `D 42`, `OK` or `ERR`.
4. **Measure** where the test asks for a number: a tape measure for distance, a protractor or tape marks on the floor for turn angles, a phone stopwatch for time.
5. Tick the box and write the number in the **Report back** table.

If the firmware uses different command letters than `F/B/L/R/S/D/P`, test with whatever it uses. **Post the actual command list in the team chat**, because the bridge has to match it.

### Command reference: use the column that matches the firmware on the Uno
The firmware in [use-case.md](use-case.md) (Day's plan) uses `M/S/H` at **115200 baud**, newline-terminated. Translate each test like this:

| Test asks for | This plan (`F/B/L/R/S/D/P`) | use-case.md firmware (`M/S/H`) | Expected reply |
|---|---|---|---|
| Forward 1 s | `F 1000 150` | `M 150 150 1000` | `DONE` |
| Back 0.5 s | `B 500 150` | `M -150 -150 500` | `DONE` |
| Turn left in place | `L 90` | `M -150 150 <ms>` (find the ms for 90°) | `DONE` |
| Turn right in place | `R 90` | `M 150 -150 <ms>` | `DONE` |
| Stop now | `S` | `S` | `OK` |
| Alive check | `P` | `H` | (heartbeat; may not reply) |
| Read distance | `D` | **not in that firmware.** Add a `D` command if the ultrasonic sensor is wired | `D <cm>` |

Notes for the `M/S/H` firmware:
- Moves are capped at **2000 ms** per command. Use two commands for longer tests.
- Its watchdog stops the motors if **no line arrives for 500 ms**, and the bridge sends `H` every 200 ms. **In the Serial Monitor you can't type fast enough**, so a manual `M ... 1000` may stop early at 500 ms. Either test watchdog-sensitive moves with a tiny script that sends `H` every 200 ms, or expect the early stop.
- Turns are time-based. Calibrate `msPer90deg` (turn) and `msPerMeter` (forward), the names its `calibration.json` uses.
- There is **no obstacle stop** unless the ultrasonic sensor is added to the firmware. Skip test 5 in that case and tell the team.

## Short on time? Do these 6 first (~10 min)
| # | Do this | Expect | Record |
|---|---|---|---|
| 1 | Open the port from the laptop and send `P` | `OK` after a short boot delay | Port, baud, boot delay |
| 2 | On the floor, send `L 90` three times | Turns about 90° each time | Adjust ms-per-degree until it's close; record `MS_PER_DEG` |
| 3 | `F 1000 <normal speed>`, then measure | Moves forward in a straight-ish line | `CM_PER_SEC`, which way it veers |
| 4 | Drive toward a box | Stops before 20 cm, replies `BLOCKED <cm>` | Stopping distance |
| 5 | `F 3000 150`, then send `S` after 1 s | Stops immediately | Y/N |
| 6 | Mid-move, unplug USB or kill the program | Wheels stop within ~0.5 s | Y/N (this is the crash beat in the demo) |

Plus: **test the ghost.** Point the sensor at the actual sheet ghost with `D`. A cloth sheet may not be detected; if so, put a box behind it.

The sections below are the full version.

---

## 1. Serial basics (wheels off the ground)
- [ ] Open the serial port from the laptop (not only the Arduino IDE monitor). Note the **port name** and **baud**.
- [ ] **Boot delay:** opening the port resets the Uno. Measure how long until it answers `P` with `OK`.
  The bridge must wait this long (or wait for a `READY` line). Consider printing `READY` at the end of `setup()`.
- [ ] `P` → `OK`. Unknown command (`X`) → `ERR`, with no hang.
- [ ] Line ending: does it need `\n`, `\r\n` or either? Write it down.
- [ ] Spam: send 20 `P` commands in 1 s. Every one is answered and nothing is lost or garbled.

## 2. Motion (wheels off the ground, then on the floor)
- [ ] `F 500 150`: both wheels spin forward, then stop. Reply `DONE`.
- [ ] `B 500 150`: both wheels reverse.
- [ ] `L 90` / `R 90`: wheels spin in opposite directions. Correct direction for each?
- [ ] **Deadband:** the lowest speed at which the rover actually moves on the floor = `MIN_SPEED`.
- [ ] **Max safe speed:** the fastest speed you'd run near people = `MAX_SPEED`. It should be enforced in firmware.
- [ ] **Straightness:** `F 2000 <normal speed>`. Does it veer left or right, and by how many cm over 2 s? Trim the left/right PWM if needed.
- [ ] **Distance per ms:** `F 1000 <normal speed>`, then measure the cm travelled. Repeat 3×. → `CM_PER_SEC`.

## 3. Turn calibration (on the demo floor; this matters most)
- [ ] `L 90` three times. Measure the actual angle each time. Adjust the ms-per-degree until it's within ±10°. → `MS_PER_DEG`.
- [ ] Same for `R 90`. Left and right may differ.
- [ ] `L 360` once: how far off is it?

## 4. Ultrasonic distance (`D`)
- [ ] Measure at 10, 20, 50 and 100 cm against a flat box with a tape measure. Note the error.
- [ ] **Nothing in range:** what does it return (0? 400? timeout)? The bridge must treat it as "clear", not "blocked".
- [ ] **The ghost:** test against the actual ghost (a **cloth sheet absorbs ultrasound** and may not be detected!). If it reads badly, put a cardboard box behind or inside the ghost.
- [ ] At a 30–45° angle to a wall: does the reading jump or vanish?
- [ ] Minimum reliable distance (most sensors are blind under ~3 cm).

## 5. Obstacle stop (reflex)
- [ ] Drive at `normal speed` toward a box. It stops before 20 cm and replies `BLOCKED <cm>`.
- [ ] Repeat at `MAX_SPEED`. How far does it travel **after** detecting the obstacle? → `STOP_DISTANCE_CM`.
- [ ] While blocked, `B` (reverse) and `L`/`R` (turns) **still work**, so the rover can escape. Only forward is refused.
- [ ] A person walks in front of it while it's moving: it stops.

## 6. Watchdog (500 ms)
- [ ] Define the rule. Is the watchdog measured from the **last command**, or from the **end of the commanded move**?
  Recommended: a move of N ms is allowed to finish, and the watchdog starts after that. Write down which rule it uses.
- [ ] `F 3000 150`, then send nothing: the move runs for 3 s and stops (it doesn't stop at 500 ms, unless that's the rule).
- [ ] `P` sent **during** a move is answered `OK` and does not interrupt the move. (If the watchdog counts from the last command, `drive()` in Part B uses `P` as a keepalive.)
- [ ] **Unplug USB mid-move:** the wheels stop within ~0.5 s.
- [ ] **Kill the bridge program mid-move** (Ctrl-C): the wheels stop. *This is the crash beat in the demo.*

## 7. Emergency stop
- [ ] `F 3000 150`, then `S` after 1 s: it stops **immediately** (under 100 ms), and the reply arrives.
- [ ] Is `S` accepted while the Arduino is busy with a move? The firmware must check serial **during** moves, not only between them.

## 8. Power
- [ ] Motor battery voltage at rest and while moving. Note it.
- [ ] Does the **Uno reset** when the motors start or stall? (Watch for the `READY` banner reappearing.) If it does, the cause is power or ground: use a separate supply and a common ground.
- [ ] Run for 10 min of on-and-off driving. Does the speed drop as the battery drains? Is a spare battery or charger on hand?
- [ ] A physical kill switch on the motor battery is reachable from outside the rover.

## 9. Full-system smoke test
- [ ] With the Framework laptop **mounted on the rover**, run 10 mixed commands (`F`, `L`, `D`, `R`, `B`, `S`) from a script on the laptop. No resets, no lost replies, nothing tips over.

---

## Report back (paste into team chat)

| Item | Value |
|---|---|
| Serial port / baud / line ending | |
| Boot delay after opening port (ms) | |
| `MIN_SPEED` / `MAX_SPEED` (PWM) | |
| `CM_PER_SEC` at normal speed | |
| `MS_PER_DEG` left / right | |
| Veer over 2 s (cm, direction) | |
| Distance error at 20 / 50 / 100 cm | |
| "Nothing in range" reading | |
| Ghost detected? (sheet / box) | |
| `STOP_DISTANCE_CM` at max speed | |
| Watchdog rule (from last cmd / from end of move) | |
| E-stop works mid-move? (Y/N) | |
| USB unplug / bridge kill stops wheels? (Y/N) | |
| Uno resets under load? (Y/N) | |
| Battery voltage rest / moving | |
| Anything flaky | |

**Who uses these numbers:**
- The bridge: port, boot delay, line ending, watchdog rule.
- The actor: `CM_PER_SEC` and `MS_PER_DEG` for estimating position.
- The simulator: the same constants plus `STOP_DISTANCE_CM`.
- The demo: whether the ghost is detected.

---

# Part B: Rover agent on the 5-point map

**For:** the hardware owner (tests 10–13) and the rover-agent owner (the Python module and test 14).
**Needs:** the Part A numbers (`CM_PER_SEC`, `MS_PER_DEG` left/right, `MIN_SPEED`, `MAX_SPEED`, boot delay, line ending).

The rover drives on a **fixed map with five named points**. The rover agent (the "rover-bridge" box in [flow.md](flow.md),
running on the Framework laptop) never sends raw cm/deg moves. It calls one Python method, `drive(from_point, to_point)`,
and the method turns that into the calibrated serial commands from Part A.

## The map

```
            1
            |
     4 ---- 5 ---- 2          heading toward 1 = 0°, toward 2 = 90°, toward 3 = 180°, toward 4 = 270°
            |
            3
```

- 5 is the center. 1 is top (north), 2 right (east), 3 bottom (south), 4 left (west).
- Every outer point connects **only to 5**. There are four arms: 5–1, 5–2, 5–3, 5–4.
- Arm lengths `ARM_CM[1..4]` are **measured** on the floor (test 10). Nominal ~80 cm for a ~2×2 m arena. They may differ per arm.
- Pose = `(at, heading)`: `at` is one of 1–5 or `None` (unknown, e.g. after a block or e-stop); `heading` is 0 / 90 / 180 / 270.
- There are no encoders, so the pose is dead-reckoned. A human **re-homes** the rover by placing it at 5 facing 1 and calling `home()`.

## Files, setup, run

```
rover/__init__.py
rover/drive.py        Rover class, constants, DriveResult
rover/serial_link.py  SerialLink (pyserial) and FakeLink (no hardware)
rover/rover_agent.py  Agent + tools + CLI
```

- Python 3.11+. `pip install pyserial openai-agents`. `OPENAI_API_KEY` from the event credits.
- Config by env: `ROVER_PORT` (default: the port from the Part A table). `ROVER_FAKE=1` uses `FakeLink` instead of the serial port,
  so the rover-agent owner can build and test everything while the hardware owner still has the rover.
  `ROVER_FAKE_FAST=1` caps every fake move at 300 ms.
- Run: `python -m rover.rover_agent "go to 3"` (one message) or `python -m rover.rover_agent --repl` (type messages in a loop).

## `drive(from_point, to_point)`: the contract (`rover/drive.py`)

```python
from rover.drive import Rover

rover = Rover(port="/dev/tty.usbmodemXXXX")   # baud / line ending / boot delay from the Part A table
rover.home()                                  # rover is at 5 facing 1
res = rover.drive(5, 2)                       # one leg: turn right 90°, drive ARM_CM[2]
res = rover.drive(2, 4)                       # two legs, routed through 5: 2→5, 5→4
```

**Constants at the top of the module** (fill from the report tables):
`ARM_CM = {1: .., 2: .., 3: .., 4: ..}`, `CM_PER_SEC`, `MS_PER_DEG_L`, `MS_PER_DEG_R`, `NORMAL_SPEED`, `CLEAR_READING`
(the "nothing in range" value from Part A), `WATCHDOG_FROM_LAST_CMD` (True/False, from Part A test 6).
`HEADING_TO = {1: 0, 2: 90, 3: 180, 4: 270}` is the heading from 5 toward each outer point.

**`Rover(port=None, link=None, at=5, heading=0)`**
- Wraps the serial protocol from [initial-plan.md](initial-plan.md): `F/B/L/R/S/D/P`, replies `DONE | BLOCKED <cm> | ERR`.
  Accepts `DONE` with or without a trailing id (`DONE 7`); the id is ignored.
- `Rover(port=...)` opens a `SerialLink` (pyserial) and waits the measured boot delay (or for `READY`).
  `Rover(link=FakeLink())` is the no-hardware path. Both links have the same interface: `send(line) -> reply`.
- **`FakeLink`** (`rover/serial_link.py`): answers `OK` to `P`, `DONE` to `L/R/B` at once, `DONE` to `F <ms>` after sleeping `ms`
  (300 ms cap with `ROVER_FAKE_FAST=1`), `D 120` to `D`. `FakeLink(block_on={(5, 2): 18})` makes the forward move of that leg
  reply `BLOCKED 18`, so the blocked path (test 13) and the agent (test 14) can be run on any laptop.
- One command in flight at a time (a lock).
- **Watchdog.** If `WATCHDOG_FROM_LAST_CMD` is False, send the move once and wait. If True, while waiting for `DONE` on any
  move longer than 400 ms, send `P` every 200 ms as a keepalive (Part A test 6 checks that `P` mid-move is answered and harmless).
- **Timeouts and errors.** Read timeout per command = expected ms + 2000 (turns: `deg * MS_PER_DEG + 2000`; `P` and `D`: 1000 ms).
  Timeout → send `S`, `status="ERR"`, `error="serial_timeout"`. Reply `ERR` → `status="ERR"`, `error="firmware_err"`, no retry.
  **Everything that sets `at = None`:** `BLOCKED`, `ERR`, a timeout, `stop()`. After any of them, nothing moves until `home()`.

**`drive(from_point, to_point) -> DriveResult`**
1. **Validate.** Both in 1–5, `from_point != to_point`, and `from_point == rover.at`. Anything else returns
   `ok=False, error="bad_point"` or `error="state_mismatch"` without moving. The `from_point` parameter exists exactly for this
   check: if the caller's idea of where the rover is disagrees with the module's, nothing moves until someone calls `home()`.
2. **Route.** If either point is 5 the path is one leg `[(from, to)]`. Otherwise it is two legs `[(from, 5), (5, to)]`.
3. **Each leg a→b:**
   - Target heading = `HEADING_TO[b]` when leaving 5, or `(HEADING_TO[a] + 180) % 360` when heading back to 5.
   - `delta = target - heading`, normalised to (-180, 180]. Send `R <delta>` if positive, `L <-delta>` if negative, nothing if 0.
     Wait for `DONE`. Update `heading`.
   - Send `F <round(ARM_CM[arm] / CM_PER_SEC * 1000)> <NORMAL_SPEED>` where `arm` is whichever of a, b is not 5. Wait for `DONE` or `BLOCKED`.
   - `DONE` → `at = b`, continue to the next leg.
   - `BLOCKED <cm>` → `at = None`, stop here, return `ok=False` with `blocked_cm`, the leg `(a, b)` and the elapsed ms (so the caller can estimate how far along the arm it is).

   **Pose after arrival** (this makes every turn deterministic): at an outer point `a` the heading is `HEADING_TO[a]`;
   at 5 after coming from `a` it is `(HEADING_TO[a] + 180) % 360`; after `home()` it is 0.

   **Worked example:** `drive(2, 4)` starting at 2, heading 90 (just arrived from 5):

   | Leg | At / heading | Target heading | Turn sent | Drive sent | After |
   |---|---|---|---|---|---|
   | 2→5 | 2 / 90 | 270 | `R 180` | `F <ARM_CM[2]/CM_PER_SEC*1000> <NORMAL_SPEED>` | 5 / 270 |
   | 5→4 | 5 / 270 | 270 | none | `F <ARM_CM[4]/CM_PER_SEC*1000> <NORMAL_SPEED>` | 4 / 270 |

   The hardware owner can type these same commands by hand to pre-test a leg before the module exists.
4. **Result:** `{ok, at, heading, legs: [{frm, to, turned_deg, drove_cm, status: "DONE"|"BLOCKED"|"ERR", blocked_cm}], error}`.

**Other methods**
- `stop()` sends `S`, sets `at = None`. (Whoever stopped it has to re-home it.)
- `home(point=5, heading=0)` resets the pose after a human places the rover. No motion.
- `distance()` wraps `D` and returns cm (`CLEAR_READING` means clear, not blocked).
- `where()` returns `(at, heading)`.

## The rover agent (OpenAI Agents SDK, Python, `rover/rover_agent.py`)

- One `Agent` named `rover`. Tools, each a thin wrapper over the module above:
  - `go_to(point)` → `rover.drive(rover.at, point)` and returns the DriveResult as text.
  - `where_am_i()` → `rover.where()`.
  - `distance()`.
  - `stop()`.
  - `say(text)` → speaker.
  - `look()` → stub for now; the vision owner fills it (camera photo → OpenAI vision, see `rover.look` in [flow.md](flow.md)).
- **Instructions (system prompt):** it knows the map and that every path goes through 5; it moves **only** via `go_to`;
  if `at` is `None` it must not guess, it asks a human to re-home; it repeats every DriveResult verbatim in its reply;
  it never retries a `BLOCKED` leg on its own.
- **Entry points:** a CLI loop for testing (`python -m rover.rover_agent "go to 3"`), and `handle_message(text) -> str`
  that the Relay listener / Terse bridge will call. Wiring that up is owner C's job and is not part of this plan.
- **Guardrails:** an asyncio lock so two tool calls can never drive at once; `go_to` is refused while e-stopped;
  the speed cap stays in firmware (`MAX_SPEED`), the agent never sets speed.
- **Where it sits in the flow:** it *is* the rover-bridge box in [flow.md](flow.md). Mission steps become `{type: "goto", point: N}`
  instead of cm/deg. That is a one-line change for owners B (actor) and C (Relay/Mastra); flagging it here, not planning it.

## Tests (on the demo floor, after Part A is done)

### 10. Lay out the map
- [ ] Tape a cross at 5. Tape four arms toward 1, 2, 3, 4 and a cross at each end. Write the number next to each cross.
- [ ] Tape a "home" arrow at 5 pointing at 1. The rover is always re-homed on this arrow.
- [ ] Measure each arm center-to-center with a tape measure → `ARM_CM[1]`, `[2]`, `[3]`, `[4]`.
- [ ] Walk the arena once: nothing within 20 cm of any arm, or the ultrasonic reflex will stop the rover for no reason.

### 11. Single legs from the center
- [ ] `home(); drive(5, 1)`: measure overshoot (cm along the arm) and lateral error (cm sideways) at the tape cross. 3×.
- [ ] Same for `drive(5, 2)` (right 90°), `drive(5, 3)` (180°), `drive(5, 4)` (left 90°), re-homing each time.
- [ ] Return legs: `drive(1, 5)` after arriving at 1 (this is a 180° turn then the arm). Same for 2, 3, 4.
- [ ] Adjust `ARM_CM` (or `CM_PER_SEC`) and `MS_PER_DEG` until every leg lands within **±10 cm** and **±10°**. The 180° turn is the worst one. → `TURN_180_ERR_DEG`.

### 12. Routed moves
- [ ] `drive(1, 2)`, `drive(1, 3)`, `drive(4, 2)`: the result has **two legs**, `at` is the target, the rover is on the right cross.
- [ ] `drive(1, 2)` with `at == 5` returns `state_mismatch` and the wheels don't move.
- [ ] Full loop `5→1→5→2→5→3→5→4→5` without re-homing. Measure the final distance from the center cross → `LOOP_DRIFT_CM`.
  If it is over 15 cm, the demo re-homes at 5 between missions. Write that down.

### 13. Blocked mid-leg
- [ ] Put the box on arm 5→2. `drive(5, 2)` returns `ok=False`, `blocked_cm`, `at=None`.
- [ ] Then `drive(5, 4)` is refused with `state_mismatch` (no motion) until `home()` is called.
- [ ] `B 500 <speed>` still works while blocked, so a human or the agent can back the rover off.
- [ ] `stop()` during a leg: the wheels stop at once, `at=None`.
- [ ] `Rover(link=FakeLink(block_on={(5, 2): 18}))` reproduces the first two results on a laptop, no rover needed.

### 14. Agent smoke test (rover-agent owner)
- [ ] All of test 14 passes with `ROVER_FAKE=1` **before** the rover is available.
- [ ] CLI: "go to 3" → one `go_to(3)` call, reply quotes the DriveResult, rover is on 3.
- [ ] "go to 2 then 4" → `go_to(2)` then `go_to(4)`, in that order, never overlapping.
- [ ] "where are you" → answers from `where_am_i()`, no movement.
- [ ] "stop" typed during a move → `stop()` is called, then the next "go to" is refused until a human re-homes.
- [ ] Physical e-stop (`S` or the battery switch) mid-leg → the agent reports `at=None` and asks for a re-home, it does not retry.
- [ ] Two "go to" messages sent at once → the second waits for the first (the lock), the board/queue shows that order.
- [ ] Repeat the whole list on the real rover after test 12 passes.

---

## Report back, part B (add to the same chat post)

| Item | Value |
|---|---|
| `ARM_CM` 1 / 2 / 3 / 4 | |
| Overshoot per arm, cm (1 / 2 / 3 / 4) | |
| `TURN_180_ERR_DEG` | |
| `LOOP_DRIFT_CM` (full loop, no re-home) | |
| Re-home between missions needed? (Y/N) | |
| Blocked → `state_mismatch` → `home()` works? (Y/N) | |
| Watchdog keepalive needed? (`WATCHDOG_FROM_LAST_CMD`) | |
| Fake-mode agent test passes? (Y/N) | |
| Agent smoke test passes on the real rover? (Y/N) | |
| Anything flaky | |

**Who uses these numbers:**
- `rover/drive.py`: `ARM_CM`, plus the Part A `CM_PER_SEC` and `MS_PER_DEG`.
- The rover agent: whether a re-home is needed between missions (it then asks for one).
- The simulator: the same five points, `ARM_CM`, and `LOOP_DRIFT_CM` as its noise model.
- The actor (owner B) and Relay (owner C): mission steps are `{type: "goto", point: N}`.
