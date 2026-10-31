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
