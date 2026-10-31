# Ghost Shipments: demo run sheet

Submission deadline 16:00. Submit on Builderbase by 15:45 with the repo link, a 2-sentence pitch and the backup video.

## Before the demo (5 min)
1. On the demo laptop, three terminals from the repo root:
   - `cd actors && terse actor dev`
   - `npm run server`
   - `ROVER_NO_RELAY=1 ROVER_FAKE=1 bash scripts/run-rover.sh` (sim) or `ROVER_NO_RELAY=1 bash scripts/run-rover.sh` (real rover)
   - `npm run relay -w apps/rover` (the rover's Relay side runs as its own process: Relay retries would otherwise starve the executor)
2. Browser window 1: `http://localhost:8787/face` → click **Enable camera & audio**. Keep it visible (webcam + voice).
3. Big screen: `http://localhost:8787/dashboard`. Press **Reset demo**.
4. Phone on the same hotspot: `http://<laptop-ip>:8787/bay?bay=2` (the shipping label). Status should show READY.
5. Dry run once: `npm start -w apps/agents -- page B SHP-1042` and confirm the mission completes on the dashboard.

## Script (~2.5 min)
| Beat | Who / command | What the audience sees |
|---|---|---|
| **Hook** | Presenter | "It's 3 a.m. The system says SHP-1042 is in Bay B for the 6 a.m. truck, but no scanner confirmed it. Our shipping agent asks a rover." |
| **Page** | `npm start -w apps/agents -- page B SHP-1042` | `#warehouse` feed: shipping-agent pages @rover over **Agent Relay**. Rover replies "On my way". Dashboard: *possessed by shipping-agent* |
| **Drive** | — | Rover says "Boo-t sequence complete", map dot moves HOME → Bay B (**Terse** actor pushes each step) |
| **Look** | Teammate holds the phone label in front of the webcam | Camera tile shows the label; **OpenAI vision** reads SHP-1042 → "confirmed, bound for Reno" |
| **Ticket** | — | shipping-agent posts "Ticket EXC-xxxx created" (**Supabase**), photo appears in the result card |
| **Ghost** | Tap **Remove package** on the phone, page again | Vision sees an empty shelf → "Ghost shipment! Bay B is empty." |
| **Conflict** | `npm run conflict` | P1 and P2 page at once; inventory-agent's direct drive is **REJECTED: rover is possessed by shipping-agent** (red in the feed) |
| **Crash** | `pkill -f apps/rover/src/index.ts` mid-mission | Wheels stop (watchdog). 2 s later: "Resuming mission, step N of 5", mission finishes |
| **Close** | Presenter | "Any agent can page a body. One Terse actor owns the queue, so orders never conflict and missions survive crashes." |

Optional: **Emergency stop** button on the dashboard (Esc), then **Resume**. In sim mode, `touch apps/rover/.block` makes the next drive stop for an obstacle, then press **Re-home**.

## If something fails
- Relay slow/503 (their service was overloaded today): say so; fire the mission directly: `npx tsx apps/rover/src/../../../scripts/page-direct.ts` is not needed, use `curl -X POST localhost:8787/api/reset` then re-page, or narrate from the backup video.
- Vision inconclusive: hold the phone closer and steadier, ~30 cm from the webcam, label filling the frame.
- Rover pose unknown after a block: press **Re-home** on the dashboard.
- Anything else: play the backup video, keep the dashboard up.

Say plainly if the drive is simulated: "the wheels are simulated today; the firmware is in the repo."
