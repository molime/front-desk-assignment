# Eval harness

Proves the voice agent's decision-making layer without a phone call: scripted
caller turns go through an LLM using the **same system prompt and the same 19
tool schemas** as the phone agent, and every tool call runs against the **real
tool implementations**. Each scenario gets a fresh throwaway copy of
`server/data/gulfbreeze.db` (`harness/tmp/`, via `GBA_DB_PATH` + one child
process per scenario); the source DB is hash-verified untouched after every run.

## Run

- `npm run harness` — all 10 scenarios (needs `OPENAI_API_KEY`; model via `HARNESS_MODEL`, default `gpt-4o-mini`)
- `npm run harness -- --scenario s3-emergency-booking` — one scenario
- `npm run harness -- --dry-run` — validate scenario files + DB fixtures only, no API key needed
- `HARNESS_FAKE_LLM=1 npm run harness` — deterministic fake LLM; full loop, no key

## Add a scenario

1. Create `harness/scenarios/sN-thing.js` exporting `{ name, description, callerTurns, validate?, setup?, assert }`.
2. `callerTurns` are static strings, robust to model variation; `setup({db})` may seed the throwaway copy and returns `ctx.data`.
3. `assert(ctx)` uses `ctx.check(label, condition, detail)` — keep assertions structural (tool called? DB row? reply mentions the date/number the tool returned?), never exact-string.
4. Add a matching script in `harness/fakeLlm.js` so `--dry-run` and fake mode cover it.
5. Verify: `node harness/run.js --dry-run` then `HARNESS_FAKE_LLM=1 node harness/run.js`.
