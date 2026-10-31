# @app/server: Ghost Shipments web server

Express + ws on port **8787** (listens on `0.0.0.0`, prints the LAN URLs on start). Serves three static pages
from `public/` (plain HTML + vanilla JS, no build) and proxies the Terse actors for browsers.

## Run

```sh
npm install                 # from the repo root (workspaces)
# actors must be running for live data: see actors/README.md (terse actor dev, then terse actor generate)
npm run server              # = npm start -w apps/server  (tsx src/index.ts)
```

The server loads the generated Terse client lazily from `actors/generated/index.js` (override with
`ACTORS_CLIENT_PATH`). If the client or the actor server is missing, the server still starts, every actor
endpoint returns `503 {error, message}`, and the pages still render (the dashboard shows sample data
under a "DEMO DATA — actor server not running" banner).

## Pages (replace `<ip>` with the rover laptop's LAN IP printed on start)

| Device | URL | Notes |
|---|---|---|
| Rover laptop browser (fullscreen) | `http://<ip>:8787/face` | Click **Enable camera & audio** once (unlocks webcam + speech). Ghost eyes, mouth animates while speaking. Pushes a camera frame every 2 s. On the laptop itself `http://localhost:8787/face` works too (getUserMedia needs localhost or https). |
| Phone propped in the bay box | `http://<ip>:8787/bay?bay=2` | Big shipping label. **Remove package** → bay status `missing` → empty-shelf view. Long-press the top-right corner (1.2 s) to put it back (`staged`). |
| Big screen | `http://<ip>:8787/dashboard` | Camera, floor map, bays, mission queue, event feed, latest result, mode pill, Reset / Resume / **EMERGENCY STOP** (Esc key also e-stops). |

## API

| Method | Path | Does |
|---|---|---|
| POST | `/api/capture` | asks /face for a webcam frame → `{jpegBase64}`; 503 if /face not connected, 504 after 5 s |
| POST | `/api/say` `{text}` | /face speaks it; returns immediately `{ok, delivered}` |
| GET | `/api/last-frame` | latest jpeg (`image/jpeg`, `X-Frame-Time` header), 204 if none |
| GET | `/api/face-status` | `{connected, lastFrameAt}` |
| GET | `/api/ws-url?actor=Rover\|Warehouse` | `{websocketUrl}` from `prepareWebsocket` (ids `rover-1`, `wh-1`) |
| GET | `/api/state` | `{rover: RoverState, warehouse: WarehouseState}` |
| POST | `/api/estop`, `/api/resume` | `Rover.estop/resume("dashboard")` |
| POST | `/api/bay/:n` `{status}` | `Warehouse.setBay(n, {status})` (`staged`/`missing`/`hold`) |
| POST | `/api/reset` | `Rover.reset()` + `Warehouse.reset()` |

Every actor call has a timeout (`ACTOR_CALL_TIMEOUT_MS`, default 4000).

## Freestyle (stretch, not required)

The pages are static files. If the actors are deployed with `terse deploy`, the pages plus this small
server could run on a Freestyle VM at a `*.style.dev` URL, so the dashboard is reachable off the venue
Wi-Fi. `/face` must stay on the rover laptop, because it owns the webcam and speaker.
