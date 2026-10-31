# Hardware person: do this now (on the Framework laptop, ~30 min)

Goal: by the time the software is wired up, the rover drives the 5-point map from a command line. Post results in the team chat as you go.

## 1. Wire (5 min)
Per `firmware/README.md`: ENA D5, ENB D6 (PWM jumpers removed), IN1 D7, IN2 D8, IN3 D9, IN4 D10, ultrasonic TRIG D2, ECHO D3 (+5V, GND).
Motor battery → L298N 12V + GND. **Arduino GND joined to L298N GND.** Keep the motor battery switch within reach.

## 2. Flash (5 min)
Arduino IDE → open `firmware/rover/rover.ino` → board Arduino Uno → upload. Open Serial Monitor at **115200**, line ending **Newline**.
You should see `READY`. Type `P` → `OK`. Type `D` → `D <cm>`. Close the Serial Monitor afterwards (only one program can hold the port).

## 3. Set up the console (5 min)
```
git pull
npm install                      # repo root
npm run console -w apps/rover    # auto-detects the Arduino port; SERIAL_PORT=/dev/... overrides
```
This console sends the keepalive the firmware expects, so moves run their full length (the Serial Monitor stops them at 500 ms).

## 4. Wheels off the ground (3 min)
```
F 500 150      both wheels forward, then DONE. If backwards: flip INVERT_LEFT/INVERT_RIGHT in the .ino and re-flash
L 90           wheels opposite directions; it should be a LEFT turn when on the floor
S              during a move → stops at once
```

## 5. On the floor (10 min). Write the numbers down
| Test | Command | Measure | Adjust |
|---|---|---|---|
| Straight | `F 1000 150` ×3 | cm travelled → `CM_PER_SEC` (default 30); sideways drift | `LEFT_TRIM`/`RIGHT_TRIM` in .ino |
| Turn left | `L 90` ×3 | degrees turned | `MS_PER_DEG_L` in .ino (default 6.0; bigger = more turn) |
| Turn right | `R 90` ×3 | degrees turned | `MS_PER_DEG_R` |
| 180 | `L 180` | degrees | the worst case, get it within ±15° |
| Obstacle | drive toward a wall/person with `F 3000 150` | stops before 20 cm, reply `BLOCKED <cm>` | `STOP_CM` |
| Watchdog | `F 3000 150` then Ctrl-C the console mid-move | wheels stop within ~0.5 s | (that's the crash beat) |

Re-flash after changing constants. Then put the numbers in `apps/rover/calibration.json`:
```json
{ "cmPerSec": 30, "normalSpeed": 150, "msPerDegL": 6, "msPerDegR": 6, "armCm": { "1": 80, "2": 80, "3": 80, "4": 80 } }
```
(`msPerDeg` here must match the .ino; it's only used for timeouts on the laptop side.)

## 6. The map (5 min)
Tape an "x" at HOME and a small mark 80 cm away in each direction (Bay A ahead, B right, C behind, D left). Then in the console:
```
home             rover placed on HOME facing Bay A
drive 5 2        turn right 90, drive 80 cm → should land on Bay B
drive 2 5        turn 180, drive back → HOME
drive 5 4        left 90, 80 cm → Bay D
drive 4 5
```
If it lands within ~10 cm, we're good. If arm 2 is consistently short, change `armCm["2"]` etc.

## 7. Report back in chat
Port name, `CM_PER_SEC`, `MS_PER_DEG_L/R`, whether `BLOCKED` works, whether the watchdog stops the wheels, landing error for `drive 5 2`.

## Then: set the laptop up as the rover (while others finish code)
- Install Bun: `curl -fsSL https://bun.sh/install | bash`, then `bunx terse-cli@latest install`.
- Copy `.env.example` to `.env` (ask for the keys).
- Mount the laptop on the rover, screen facing forward, and check the webcam sees the floor ahead at ~40 cm.
- Phone hotspot on; note the laptop's LAN IP (`ipconfig getifaddr en0` on macOS / `hostname -I` on Linux).
