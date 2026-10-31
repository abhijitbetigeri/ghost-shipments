// Loads the repo-root .env (then a local one) before anything reads process.env.
import { config } from "dotenv"
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(here, "../../../.env"), quiet: true } as never)
config({ quiet: true } as never)
