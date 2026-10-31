# @app/agents: shipping-agent, inventory-agent (Mastra + Agent Relay)

## Env (repo-root `.env`, loaded automatically)
| Var | Needed for |
|---|---|
| `RELAY_WORKSPACE_KEY` | all Relay traffic. If unset, the first run creates a workspace and prints `RELAY_WORKSPACE_KEY=...`: paste it into `.env` so every process shares it. Agent tokens are cached in `.relay-tokens.json` (gitignored). |
| `OPENAI_API_KEY`, `TEXT_MODEL` (default `gpt-5.5`) | Mastra page parser and ticket summaries. Without them, a regex parser and `inspection.summary` are used. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | ticket inserts (run `supabase/migrations/001_init.sql` first) |
| `TERSE_ACTOR_URL` | Rover actor (`command`, `logEvent` mirror) via `actors/generated/index.js` |
| `RELAY_POLL_MS` (2500), `RELAY_DEBUG=1` | Relay polling fallback interval / websocket debug logs |
| `CONFLICT_DELAY_MS` (4000) | wait before inventory-agent tries to drive in `conflict` |

## Run (from repo root or `apps/agents`)
- `npm start -w apps/agents`: shipping-agent online; files a ticket when `rover` replies `REPORT {json}` in one of its threads.
- `npm start -w apps/agents -- page B SHP-1042`: page the rover once (P1, truck departs 06:00), then keep listening.
- `npm run inventory -w apps/agents -- page C SHP-2001`: P2 cycle-count page.
- `npm run conflict`: P1 and P2 pages at the same instant, then inventory-agent calls `Rover.command("inventory-agent","drive")` and prints the result (REJECTED once the rover has accepted the P1 mission).
- `npm run smoke -w apps/agents`: real Relay round trip (two agents, post + threaded reply).
- `npm run parse-smoke -w apps/agents`: `parsePage` examples.

## Rover's report format
Reply in the page's thread with one line: `REPORT {"missionId":"M-0001","shipmentId":"SHP-1042","bay":2,"verdict":"ghost","inspection":{...},"photoUrl":"..."}`.
shipping-agent replies `Ticket EXC-1234 created: <verdict>. <summary>`.

## Library
`import { parsePage } from "@app/agents/parse"` returns `{ bay, shipmentId, question, priority }` (LLM 8 s timeout, regex fallback).

## Relay notes
The hosted relay often returns 503 `database_overloaded` and the websocket fails to open, so `relay.ts` retries retryable errors
(10 s timeout per attempt) and polls `#warehouse` plus recent threads over REST every `RELAY_POLL_MS`. Messages can arrive 2 to 3 s late.
