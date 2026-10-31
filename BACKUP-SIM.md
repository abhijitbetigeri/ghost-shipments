# Backup demo without the rover hardware

Everything runs for real (Terse actors, Agent Relay, Mastra agents, OpenAI vision, Supabase tickets, the dashboard, the ghost face and
voice) except the wheels: `ROVER_FAKE=1` replaces the Arduino serial link with a simulated one that takes the same commands and
replies with the same timing. The dashboard map shows the rover's position moving between HOME and the bays.

Say it plainly to judges: "the drive is simulated today; the firmware is in the repo". Don't present it as the real rover.

## Run (any laptop with a webcam; same machine for all three)
```
cp .env.example .env            # fill in OPENAI_API_KEY, SUPABASE_*, RELAY_WORKSPACE_KEY
(cd actors && terse actor dev)  # terminal 1
npm run server                  # terminal 2
ROVER_NO_RELAY=1 ROVER_FAKE=1 bash scripts/run-rover.sh   # terminal 3 (restart loop, needed for the crash beat)
npm run relay -w apps/rover     # terminal 4: the rover's Relay side, kept out of the executor process
```
Open `http://localhost:8787/face` in a browser window, click **Enable camera & audio**, and keep it visible (it's the webcam and the voice).
Open `/dashboard` on the big screen. Open `/bay?bay=2` on a phone.

## Vision is real
Hold the phone with the `/bay?bay=2` label in front of the laptop webcam during the ALIGN/INSPECT steps (after the "drive" ends,
~4 s into the mission). Tap **Remove package** on the phone for the ghost-shipment verdict. If nobody holds a label, the verdict is
"ghost" or "inconclusive", which is still a valid demo.

## Demo beats in sim mode
| Beat | How |
|---|---|
| Page the rover | from Relay: shipping-agent `npm start -w apps/agents -- page B SHP-1042`, or `curl` the actor directly |
| Obstacle stop | `touch apps/rover/.block` before/during DRIVE → the next forward move replies `BLOCKED 18`, pose becomes unknown, the rover asks to be re-homed → press **Re-home** on the dashboard |
| Conflict | `npm run conflict` (P1 + P2 at once, then the REJECTED direct command) |
| Crash | kill terminal 3's child (`pkill -f apps/rover/src/index.ts`); `run-rover.sh` restarts it in 2 s; it says "Resuming mission, step N of 5" |
| E-stop | the big button on the dashboard (or Esc); **Resume** afterwards |

`ROVER_FAKE_FAST=1` makes every move take ≤300 ms (for tests, not for the demo).

## Switching to the real rover
Unset `ROVER_FAKE`, plug in the Arduino, same commands. Nothing else changes.
