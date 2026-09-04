// Runs ONE scenario in a child process (spawned by run.js with GBA_DB_PATH set
// to a throwaway DB copy). Imports the REAL agent system prompt, tool schemas,
// and tool implementations from server/ — this is what proves the phone agent's
// decision layer: same prompt, same tools, text instead of audio.
//
// Human-readable transcript goes to stderr; the last stdout line is a JSON
// result object consumed by run.js.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [scenarioFile, ...flags] = process.argv.slice(2);
const validateOnly = flags.includes('--validate') || process.env.HARNESS_DRY_RUN === '1';

const scenario = (await import(pathToFileURL(path.resolve(scenarioFile)).href)).default;

// Importing the db module opens the copy at GBA_DB_PATH (see server/src/db/index.js).
const { default: db } = await import('../server/src/db/index.js');
const { buildSystemPrompt, TOOL_SCHEMAS } = await import('../server/src/realtime/agent.js');
const { executeTool, summarizeAction } = await import('../server/src/realtime/tools.js');
const calls = await import('../server/src/services/callService.js');
const { todayEt, addDays, etDayOfWeek } = await import('../server/src/lib/time.js');

// --- result plumbing ------------------------------------------------------------

const assertions = [];
const check = (name, pass, detail = null) => {
  assertions.push({ name, pass: !!pass, detail: pass ? null : detail });
  return assertions[assertions.length - 1];
};

function finish({ pass, error = null, extra = {} }) {
  const allPass = assertions.every((a) => a.pass) && !error;
  const result = {
    name: scenario.name,
    description: scenario.description,
    pass: pass && allPass,
    assertions,
    error,
    ...extra,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.pass ? 0 : 1);
}

// --- structural validation -------------------------------------------------------

const structuralErrors = [];
if (!scenario.name || typeof scenario.name !== 'string') structuralErrors.push('missing string "name"');
if (!scenario.description || typeof scenario.description !== 'string') structuralErrors.push('missing string "description"');
if (!Array.isArray(scenario.callerTurns) || scenario.callerTurns.length === 0) structuralErrors.push('"callerTurns" must be a non-empty array');
else if (scenario.callerTurns.some((t) => typeof t !== 'string' || !t.trim())) structuralErrors.push('"callerTurns" must contain only non-empty strings');
if (typeof scenario.assert !== 'function') structuralErrors.push('missing async "assert(ctx)" function');
if (scenario.setup && typeof scenario.setup !== 'function') structuralErrors.push('"setup" must be a function if present');

if (structuralErrors.length) {
  finish({ pass: false, error: `invalid scenario file: ${structuralErrors.join('; ')}` });
}

// --- scenario setup (seeds data on the THROWAWAY copy) ----------------------------

let data = {};
try {
  data = (await scenario.setup?.({ db, addDays, todayEt, etDayOfWeek })) ?? {};
} catch (err) {
  finish({ pass: false, error: `setup() failed: ${err.message}` });
}

// --- dry-run: validate referenced data, no LLM -------------------------------------

if (validateOnly) {
  check('scenario file structure (name, description, callerTurns, assert)', true);
  try {
    const problems = (await scenario.validate?.({ db, data, check })) ?? [];
    if (problems.length === 0) check('referenced customers/jobs found in DB', true);
    else check('referenced customers/jobs found in DB', false, problems.join('; '));
  } catch (err) {
    check('referenced customers/jobs found in DB', false, err.message);
  }
  finish({ pass: true });
}

// --- LLM backends -------------------------------------------------------------------

// Realtime tool schema ({type:'function', name, description, parameters})
// → chat-completions tool schema ({type:'function', function: {...}}).
const CHAT_TOOLS = TOOL_SCHEMAS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

const MODEL = process.env.HARNESS_MODEL ?? 'gpt-4o-mini';

async function llmReal(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, tools: CHAT_TOOLS, tool_choice: 'auto' }),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return {
    content: msg?.content ?? '',
    toolCalls: (msg?.tool_calls ?? []).map((tc) => ({ name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') })),
    raw: msg,
  };
}

let llm = llmReal;
if (process.env.HARNESS_FAKE_LLM) {
  const { makeFakeLlm } = await import('./fakeLlm.js');
  llm = makeFakeLlm(scenario.name, { todayEt, addDays, etDayOfWeek });
}

// --- synthetic call row (tools expect ctx.callId for handoffs/audit) ----------------

const call = calls.createCall({ call_sid: `harness_${scenario.name}`, from_number: '+13055550199', status: 'in-progress' });
const toolCtx = { callId: call.id };

// --- conversation loop ----------------------------------------------------------------

const toolCalls = [];
const conversation = [];
const messages = [{ role: 'system', content: buildSystemPrompt() }];

const say = (who, text) => process.stderr.write(`  ${who}: ${text}\n`);
const TURN_CAP = 12;

let runError = null;
try {
  for (const turn of scenario.callerTurns) {
    messages.push({ role: 'user', content: turn });
    conversation.push({ role: 'caller', text: turn });
    say('caller', turn);

    let hops = 0;
    while (hops++ < TURN_CAP) {
      const reply = await llm(messages);

      if (reply.toolCalls.length > 0) {
        // echo the assistant message (with tool calls) back into the transcript
        messages.push(reply.raw ?? { role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls.map((tc, i) => ({ id: `fake_${i}`, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) });
        for (const [i, tc] of reply.toolCalls.entries()) {
          let result = await executeTool(tc.name, tc.args, toolCtx);
          if (process.env.HARNESS_FAKE_LLM && (tc.name === 'get_weather' || tc.name === 'web_search') && result?.error) {
            // offline resilience for the stubbed end-to-end run: canned fixture
            // stands in for the keyless web tools (real mode always hits the APIs)
            const { webFixture } = await import('./fakeLlm.js');
            result = { ...webFixture(tc.name, tc.args), stubbed: true };
          }
          toolCalls.push({ name: tc.name, args: tc.args, result });
          calls.addAgentAction(call.id, tc.name, tc.args, result); // audit trail, like the bridge
          say('tool', `${summarizeAction(tc.name, tc.args, result)}`);
          messages.push({
            role: 'tool',
            tool_call_id: reply.raw ? reply.raw.tool_calls[i].id : `fake_${i}`,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      messages.push({ role: 'assistant', content: reply.content });
      conversation.push({ role: 'agent', text: reply.content });
      say('agent', reply.content);
      break;
    }
    if (hops > TURN_CAP) throw new Error(`turn cap (${TURN_CAP}) exceeded — model kept calling tools`);
  }
} catch (err) {
  runError = err.message;
}

calls.finalizeCall(call.id, { status: runError ? 'error' : 'completed' });

// --- assertions -----------------------------------------------------------------------

const finalReply = [...conversation].reverse().find((m) => m.role === 'agent')?.text ?? '';
const ctx = {
  db,
  callId: call.id,
  toolCalls,
  conversation,
  finalReply,
  data,
  check,
  toolCalled: (name) => toolCalls.some((t) => t.name === name && !t.result?.error),
  toolResults: (name) => toolCalls.filter((t) => t.name === name).map((t) => t.result),
  lastTool: (name) => [...toolCalls].reverse().find((t) => t.name === name),
};

try {
  await scenario.assert(ctx);
} catch (err) {
  check('assert() completed without throwing', false, err.message);
}

finish({ pass: !runError, error: runError });
