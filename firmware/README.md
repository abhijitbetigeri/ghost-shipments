# Rover firmware (Arduino Uno + L298N + HC-SR04)

Sketch: `firmware/rover/rover.ino`. Protocol contract: DECISIONS.md, "Firmware serial protocol".

## Wiring checklist
- [ ] Motor battery + → L298N **12V**, battery − → L298N **GND**.
- [ ] **Arduino GND joined to L298N GND** (common ground, or nothing works).
- [ ] **ENA and ENB jumpers removed** from the L298N (otherwise PWM speed control is ignored).
- [ ] Left motor on L298N OUT1/OUT2 (channel A), right motor on OUT3/OUT4 (channel B).
- [ ] HC-SR04 VCC → Uno 5V, GND → Uno GND.
- [ ] Uno powered from the laptop USB (separate from the motor battery).

| Signal | Uno pin | Goes to |
|---|---|---|
| ENA (left PWM) | D5 | L298N ENA |
| ENB (right PWM) | D6 | L298N ENB |
| IN1 | D7 | L298N IN1 |
| IN2 | D8 | L298N IN2 |
| IN3 | D9 | L298N IN3 |
| IN4 | D10 | L298N IN4 |
| TRIG | D2 | HC-SR04 Trig |
| ECHO | D3 | HC-SR04 Echo |

## Upload
**Arduino IDE:** open `firmware/rover/rover.ino`, Tools → Board → Arduino Uno, Tools → Port → the Uno, click Upload.
Serial Monitor: **115200 baud**, line ending **Newline** (or Both NL & CR). You should see `READY`.

**arduino-cli** (from the repo root):
```
arduino-cli core install arduino:avr
arduino-cli compile --fqbn arduino:avr:uno firmware/rover
arduino-cli upload -p <port> --fqbn arduino:avr:uno firmware/rover
```
(`arduino-cli board list` shows the port, e.g. `/dev/cu.usbmodem*` or `/dev/ttyACM0`.)

## Protocol behaviour (details beyond the DECISIONS.md table)
- Opening the port resets the Uno; wait for the `READY` line before sending.
- Accepts `\n` or `\r\n`. Blank lines are ignored. Commands are case-insensitive. Lines over 39 chars → `ERR`.
- Moves are non-blocking; serial is read during moves.
  - `P` mid-move → `OK` immediately; the move keeps going. So `OK` can arrive **before** the move's `DONE`:
    the host should match a move to the next `DONE` / `BLOCKED <cm>` / `WATCHDOG` line.
  - `S` mid-move → the move ends and prints `DONE`, then `S` prints `OK`.
  - A new move (`F/B/L/R/M`) mid-move → the current move prints `DONE`, then the new move starts.
  - Bad arguments → `ERR`, and a running move continues.
- `F` when an obstacle is already under `STOP_CM` → `BLOCKED <cm>` immediately, no motion. `B`, `L`, `R`, `M` are never blocked.
- `M` has no obstacle check (raw drive for calibration and nudges).
- **Watchdog rule: measured from the last received line**, only while a move is active. If 500 ms pass with no line,
  the motors stop and the move replies `WATCHDOG` instead of `DONE`. Consequence: typing `F 1000 150` by hand in
  the Serial Monitor stops after ~500 ms. For manual bench tests either use a script that sends `P` every 200 ms,
  or temporarily set `WATCHDOG_MS = 0` (disables it; **never run the demo like that**).
- Caps: every move ≤ 3000 ms; every motor output ≤ `MAX_SPEED` (after trim). Negative speed on `F`/`B` is treated as its absolute value.
- `D` returns `999` when there is no echo (or > 400 cm). Treat 999 as "clear".
- Stop uses the L298N fast-stop (brake); set `USE_BRAKE = false` to coast instead.

## Constants to calibrate (top of `rover.ino`)
| Constant | Default | How |
|---|---|---|
| `INVERT_LEFT` / `INVERT_RIGHT` | false | `F 500 150` with wheels up: flip whichever wheel spins backwards (or swap its motor wires). If `L` turns right, the left/right motors are swapped: swap the wires. |
| `MS_PER_DEG_L` / `MS_PER_DEG_R` | 6.0 | `L 90` ×3 on the demo floor, measure angle; new = old × 90 / measured. Same for `R`. |
| `TURN_SPEED` | 160 | Lowest speed that turns reliably on the floor (re-calibrate MS_PER_DEG if changed). |
| `LEFT_TRIM` / `RIGHT_TRIM` | 1.0 | `F 2000 <speed>`; if it veers right, the left side is faster: lower `LEFT_TRIM` (e.g. 0.95). |
| `MAX_SPEED` | 200 | Fastest safe PWM near people. |
| `STOP_CM` | 20 | Raise if the rover coasts past 20 cm after `BLOCKED` at speed. |
| `USE_BRAKE` | true | Coast vs brake on stop. |
| `WATCHDOG_MS` | 500 | Keep 500 for the demo. |

Note: turns are only accurate up to `3000 / MS_PER_DEG` degrees (500° at 6.0) because of the move cap.
