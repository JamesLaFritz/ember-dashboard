// harness.test.mjs — regression net for the workbench harness itself.
//
// Every test here corresponds to a fault that was found in production and that
// produced behaviour indistinguishable from "the local model gave up". A
// benchmark result is a measurement of the harness until the harness is proven,
// so these assertions are the proof, and they run in seconds.
//
//   node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
  SHELL_PATH, SHELL_NAME, CMD_TIMEOUT_MS, MAX_HOPS, MAX_AUTO_CONTINUE,
  clipOutput, runCommand, AgentSession, systemFor, PRESETS, escapesWorkspace, environmentPrompt, TOOL_DEFS,
  SUMMARY_MAX_TOKENS, MIN_SUMMARY_CHARS, MAX_EMPTY_RETRIES, MAX_TOOL_CALLS_PER_TURN, capToolCalls,
  MAX_REASONING_OVERRUNS, REASONING_BUDGET, CONTEXT_SAFETY_MARGIN, MIN_OUTPUT_FLOOR,
} from '../lib/agent.js';
import { MAX_OUTPUT_TOKENS } from '../lib/lmstudio.js';

// POSIX one-liners need a POSIX shell. On the cmd.exe fallback the harness is
// already misconfigured — the shell test below is what catches that.
const posix = SHELL_NAME !== 'cmd';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-harness-'));

describe('shell resolution', () => {
  // Node's `shell: true` silently resolves to %ComSpec% on Windows regardless of
  // the launching terminal, so an agent emitting POSIX commands failed for
  // reasons unrelated to the task.
  test('resolves an explicit shell that exists', () => {
    assert.ok(fs.existsSync(SHELL_PATH), `shell not on disk: ${SHELL_PATH}`);
  });
  test('prefers Git Bash on Windows when installed', (t) => {
    if (process.platform !== 'win32') return t.skip('not Windows');
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (!fs.existsSync(gitBash)) return t.skip('Git Bash not installed');
    assert.equal(SHELL_NAME, 'git-bash', `fell back to ${SHELL_NAME} with Git Bash present`);
  });
});

describe('output clipping', () => {
  test('short output passes through untouched', () => {
    assert.equal(clipOutput('hello'), 'hello');
  });
  // A head-slice throws away exactly the build errors, which land at the end;
  // the model then reads warnings, "fixes" the wrong thing, and reports success.
  test('long output keeps the tail, where errors land', () => {
    const s = 'HEAD' + 'x'.repeat(60000) + 'ERROR: the thing that actually broke';
    const clipped = clipOutput(s);
    assert.ok(clipped.startsWith('HEAD'), 'lost the head');
    assert.ok(clipped.endsWith('ERROR: the thing that actually broke'), 'lost the tail');
    assert.ok(clipped.length < s.length, 'did not clip');
    assert.match(clipped, /dropped from the middle/);
  });
});

describe('runCommand', () => {
  test('reports exit code and captures stdout + stderr', async () => {
    if (!posix) return;
    const out = await runCommand('echo to-stdout; echo to-stderr >&2; exit 3', tmp);
    assert.match(out, /^exit 3/);
    assert.match(out, /to-stdout/);
    assert.match(out, /to-stderr/);
  });

  test('runs in the given workspace', async () => {
    if (!posix) return;
    fs.writeFileSync(path.join(tmp, 'marker.txt'), 'here');
    const out = await runCommand('ls', tmp);
    assert.match(out, /marker\.txt/);
  });

  // FAULT: default stdio leaves stdin an open pipe that never reaches EOF, so
  // anything reading stdin (npm init, an npx "Ok to proceed?", a git credential
  // prompt) blocked for the full command timeout and reported as a hang.
  // Measured before the fix: 8s+ and killed. After: ~24ms.
  test('does not hang on a command that reads stdin', async () => {
    if (!posix) return;
    const t0 = Date.now();
    const out = await runCommand('read -p "name? " x; echo got=$x', tmp, { timeoutMs: 8000 });
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `stdin read took ${ms}ms — stdin is not at EOF`);
    assert.match(out, /^exit 0/);
  });

  // FAULT: the executor resolved on 'close', which waits for every inherited
  // stdio pipe to drain. A grandchild that survives the kill (a dev server, a
  // watcher) holds those pipes open, so the tool call parked long past its own
  // timeout — forever, for a server. Measured: exit at 4.0s, close at 25.1s.
  test('a surviving grandchild does not delay resolution past the timeout', async () => {
    if (!posix) return;
    const t0 = Date.now();
    const out = await runCommand(
      `node -e "setTimeout(()=>process.exit(0), 20000); console.log('grandchild up')"`,
      tmp, { timeoutMs: 3000 });
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, `resolved after ${ms}ms — waiting on stdio, not on exit`);
    assert.match(out, /TIMED OUT/);
  });

  test('a timeout says so instead of reporting a bare failure', async () => {
    if (!posix) return;
    const out = await runCommand('sleep 30', tmp, { timeoutMs: 1500 });
    assert.match(out, /TIMED OUT after 1\.5s/);
    assert.doesNotMatch(out, /^exit null/, 'a timeout must not read as a plain failure');
  });

  // FAULT: the accumulator was unbounded and clipOutput only ran at the end, so
  // a runaway command could exhaust server memory before there was anything to
  // clip.
  test('caps the live output buffer instead of growing without limit', async () => {
    if (!posix) return;
    const out = await runCommand(
      `node -e "for (let i=0;i<200000;i++) console.log('line '+i+' padding padding padding')"`,
      tmp, { timeoutMs: 60000 });
    assert.ok(out.length < 40000, `returned ${out.length} chars — buffer is not capped`);
    assert.match(out, /dropped from the (head|middle)/);
  });

  test('a bad command is an error, not a crash', async () => {
    const out = await runCommand('definitely-not-a-real-binary-xyz', tmp, { timeoutMs: 5000 });
    assert.ok(/exit [1-9]/.test(out) || /ERROR/.test(out), `unexpected: ${out.slice(0, 200)}`);
  });
});

describe('system prompt', () => {
  // FAULT: an instruction the model cannot see is not a rule. The verification
  // rule and the dependency rule both have to reach the actual prompt.
  test('coding-agent carries the verification rule', () => {
    assert.match(PRESETS['coding-agent'].role, /Verify your own work before reporting it done/);
    assert.match(PRESETS['coding-agent'].role, /Never report completion on code you have not executed/);
  });
  test('the workbench AGENTS.md reaches the composed prompt', () => {
    const repo = path.resolve(import.meta.dirname, '..');
    const sys = systemFor('coding-agent', repo, null);
    assert.match(sys, /AGENTS\.md/, 'AGENTS.md was not composed in');
    assert.match(sys, /Do not edit `package\.json`/, 'the dependency rule did not reach the prompt');
  });
});

describe('generation and hop bounds', () => {
  // Config drift is silent and invalidates cross-model comparison. Pin the
  // values a benchmark writeup cites.
  test('bounds are set to the values the benchmark assumes', () => {
    assert.equal(MAX_OUTPUT_TOKENS, 32768, 'output ceiling changed — run records cite this');
    assert.equal(MAX_HOPS, 250, 'hop ceiling changed');
    assert.equal(CMD_TIMEOUT_MS, 600000, 'command timeout changed');
    assert.equal(MAX_AUTO_CONTINUE, 3, 'auto-continue budget changed');
  });
});

// A stub LM: replays a scripted list of chatStream results.
function stubLM(script) {
  let i = 0;
  return {
    async chatStream() {
      const step = script[Math.min(i++, script.length - 1)];
      return {
        content: step.content ?? '', reasoning: '', toolCalls: step.toolCalls ?? [],
        approxTokens: 10, promptTokens: 100, serverTps: 20,
        finishReason: step.finishReason ?? 'stop',
      };
    },
    async models() { return []; },
  };
}

function session(lm) {
  const s = new AgentSession({
    id: 'test', lm, mcp: null, model: 'stub', workspace: tmp,
    preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null,
  });
  s.autoCompact = false; // no context window to fetch from a stub
  return s;
}

describe('auto-continue on the output ceiling', () => {
  // Codex and Claude Code both self-continue across a truncation. Requiring the
  // operator to type "continue" made the local continue-count measure a protocol
  // the other harnesses never participate in.
  test('resumes automatically and stitches the segments together', async () => {
    const s = session(stubLM([
      { content: 'part one ', finishReason: 'length' },
      { content: 'part two ', finishReason: 'length' },
      { content: 'part three', finishReason: 'stop' },
    ]));
    const out = await s.send('write something long');
    assert.equal(out, 'part one part two part three');
    assert.equal(s.history.filter(h => h.kind === 'autocontinue').length, 2);
    assert.equal(s.history.filter(h => h.kind === 'bail').length, 0);
  });

  test('is bounded — a model that never stops still terminates', async () => {
    const s = session(stubLM([{ content: 'chunk ', finishReason: 'length' }]));
    const out = await s.send('never stop');
    assert.equal(s.history.filter(h => h.kind === 'autocontinue').length, MAX_AUTO_CONTINUE);
    const bail = s.history.find(h => h.kind === 'bail');
    assert.ok(bail, 'no bail recorded');
    assert.equal(bail.reason, 'output_ceiling');
    assert.match(out, /truncated at the .* output ceiling/);
  });

  // A bail is a HARNESS limit. A run scored later must be able to tell it apart
  // from the model stopping on its own.
  test('records truncated segments distinguishably', async () => {
    const s = session(stubLM([
      { content: 'cut ', finishReason: 'length' },
      { content: 'done', finishReason: 'stop' },
    ]));
    await s.send('go');
    const assistants = s.history.filter(h => h.kind === 'assistant');
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0].truncated, true);
    assert.equal(assistants[1].truncated, undefined);
  });
});

describe('identity layer', () => {
  // Identity is part of the prompt, so it belongs to the comparison rather than
  // to the machine: one server has to be able to run a benchmark session with it
  // off and an exploratory session with it on.
  test('is per session, not per process', () => {
    const repo = path.resolve(import.meta.dirname, '..');
    const withId = systemFor('coding-agent', repo, null, true);
    const without = systemFor('coding-agent', repo, null, false);
    assert.ok(withId.length > without.length, 'identity added nothing');
    assert.match(withId, /Who you work for/);
    assert.doesNotMatch(without, /Who you work for/);
    // Everything that is NOT identity has to survive the switch.
    assert.match(without, /Verify your own work before reporting it done/);
    assert.match(without, /Do not edit `package\.json`/);
  });

  test('a session composes its system message from its own setting', () => {
    const on = new AgentSession({ id: 'a', lm: stubLM([]), model: 'm', workspace: tmp, preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: true });
    const off = new AgentSession({ id: 'b', lm: stubLM([]), model: 'm', workspace: tmp, preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: false });
    assert.match(on.messages[0].content, /Who you work for/);
    assert.doesNotMatch(off.messages[0].content, /Who you work for/);
    assert.equal(off.toJSON().identityOn, false);
    assert.equal(AgentSession.fromJSON(off.toJSON(), { lm: stubLM([]) }).identity, false, 'setting did not survive a restart');
  });

  test('the report flags identity-on and does not flag identity-off', async () => {
    const on = new AgentSession({ id: 'a', lm: stubLM([]), model: 'm', workspace: tmp, preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: true });
    const off = new AgentSession({ id: 'b', lm: stubLM([]), model: 'm', workspace: tmp, preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: false });
    assert.match(await on.report(), /Parity warning/);
    assert.doesNotMatch(await off.report(), /Parity warning/);
    assert.match(await off.report(), /correct for a comparison run/);
  });
});

describe('context length reporting', () => {
  // The advertised max and the loaded window are different numbers, and
  // reporting the max as the loaded window is a misdiagnosis this project has
  // already made once. A run record must never print a plausible wrong number.
  const lmWith = (model) => ({ async chatStream() { throw new Error('unused'); }, async models() { return [model]; } });

  test('refuses to print the advertised max as the loaded window', async () => {
    const s = session(lmWith({ key: 'stub', loadedContextLength: null, contextLength: 262144, maxContextLength: 262144 }));
    const md = await s.report();
    assert.match(md, /not loaded now/);
    assert.doesNotMatch(md, /\*\*262,144\*\*/, 'printed the advertised max as the run window');
    assert.match(md, /advertised max is 262,144/, 'should still say what the number it rejected was');
  });

  test('prints a genuinely loaded window', async () => {
    const s = session(lmWith({ key: 'stub', loadedContextLength: 32768, contextLength: 32768, maxContextLength: 262144 }));
    const md = await s.report();
    assert.match(md, /\*\*32,768\*\* _\(read now/);
    assert.match(md, /24,576 tokens/, 'compaction threshold not derived from the window');
  });

  test('prefers the value recorded during the run over a later read', async () => {
    const s = session(lmWith({ key: 'stub', loadedContextLength: 8192, contextLength: 8192, maxContextLength: 262144 }));
    s.contextWindow = 32768;   // what the run actually used
    const md = await s.report();
    assert.match(md, /\*\*32,768\*\* _\(recorded during the run\)_/);
  });
});

describe('model id resolution', () => {
  // LM Studio exposes two strings for one loaded model and accepts either for
  // inference: the model `key` (quant suffix included) and the loaded instance
  // `id` (without it) - the string `lms ps` prints, so the one a human copies.
  // Matching only `key` left the window null on an otherwise perfect run, which
  // disables auto-compaction and the generation cap SILENTLY.
  const catalogue = [{
    key: 'qwen3.6-35b-a3b-mtp@q3_k_m',
    instanceIds: ['qwen3.6-35b-a3b-mtp'],
    loadedContextLength: 128512, contextLength: 128512, maxContextLength: 262144,
  }];
  const sessionFor = (model) => new AgentSession({
    id: 'r', lm: { async chatStream() { throw new Error('unused'); }, async models() { return catalogue; } },
    mcp: null, model, workspace: tmp, preset: 'coding-agent', mode: 'plan',
    broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: false });

  test('resolves by model key', async () => {
    const md = await sessionFor('qwen3.6-35b-a3b-mtp@q3_k_m').report();
    assert.match(md, /\*\*128,512\*\*/, 'the model key did not resolve to the loaded window');
  });

  test('resolves by loaded instance id', async () => {
    const md = await sessionFor('qwen3.6-35b-a3b-mtp').report();
    assert.match(md, /\*\*128,512\*\*/, 'the loaded instance id did not resolve to the loaded window');
  });

  test('the resolved window still drives the compaction threshold', async () => {
    const md = await sessionFor('qwen3.6-35b-a3b-mtp').report();
    assert.match(md, /93,696/, 'threshold not derived from the window reached via the instance id');
  });

  test('an unresolvable model reports unknown rather than a plausible number', async () => {
    const md = await sessionFor('no-such-model').report();
    assert.doesNotMatch(md, /\*\*128,512\*\*/, 'invented a window for a model it could not find');
  });
});

describe('compaction', () => {
  // FAULT (found 2026-08-21 in session 982e1cb3): compact() referenced
  // `userIdxs`, a local that the #cutPoint() refactor had removed. It folded
  // the messages, then threw ReferenceError before recording anything — and
  // #maybeCompact swallowed the throw into a broadcast. Result: an 8.9-hour run
  // whose context WAS compacted reported "Compactions: 0", and the whole
  // model-vs-summary attribution mechanism was dead.
  const lm = () => ({
    async complete() { return 'HANDOFF NOTE. '.repeat(40); },   // must clear MIN_SUMMARY_CHARS
    async chatStream() { throw new Error('unused'); },
    async models() { return [{ key: 'm', loadedContextLength: 4096, contextLength: 4096, maxContextLength: 4096 }]; },
  });
  const hoppy = (n) => {
    const s = new AgentSession({ id: 'c', lm: lm(), model: 'm', workspace: tmp, preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: false });
    for (let i = 0; i < n; i++) {
      s.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      s.messages.push({ role: 'tool', tool_call_id: 'c' + i, content: 'x'.repeat(200) });
    }
    s.lastPromptTokens = 3000;
    return s;
  };

  test('folding on hop boundaries does not throw', async () => {
    const s = hoppy(12);
    assert.equal(await s.compact('auto'), true, 'compaction did not run');
  });

  // FAULT (found 2026-08-21 in session e5c348f8, visible only because Fix 12
  // made compaction record itself): the summariser ran at max_tokens 2048 on a
  // reasoning model, spent 2047 of them on reasoning_content, and emitted ZERO
  // content. complete()'s salvage path then returned the tail of the unfinished
  // thought, so 94,296 tokens of session were replaced by 83 characters that
  // began mid-list at "7.". Measured: 8192 finishes cleanly on the same input.
  test('a summariser that returns nothing aborts the fold instead of completing it', async () => {
    const s = hoppy(12);
    const before = s.messages.length;
    s.lm.complete = async () => '';                 // what an exhausted budget yields
    assert.equal(await s.compact('auto'), false, 'compaction should refuse');
    assert.equal(s.messages.length, before, 'context was folded anyway — the damage this prevents');
    const failed = s.history.filter(h => h.kind === 'compact_failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].text, /ABORTED/);
    assert.equal(s.history.filter(h => h.kind === 'compacted').length, 0);
  });

  test('a fragment of unfinished reasoning is refused too', async () => {
    const s = hoppy(12);
    const before = s.messages.length;
    s.lm.complete = async () => '7. Next steps: 1) read full config.js, MathKit.js, shared APIs; 2) normalize config';
    assert.equal(await s.compact('auto'), false, 'an 83-char note must not stand in for 94k tokens');
    assert.equal(s.messages.length, before);
  });

  test('the summariser budget is sized for a reasoning model', () => {
    assert.equal(SUMMARY_MAX_TOKENS, 8192, 'budget changed — 2048 produced empty summaries');
    assert.ok(MIN_SUMMARY_CHARS > 158, 'floor must reject the observed failures (83 and 158 chars)');
  });

  test('a fold that swallows no user turns still records itself', async () => {
    const s = hoppy(12);
    await s.compact('auto');
    const rec = s.history.filter(h => h.kind === 'compacted');
    assert.equal(rec.length, 1, 'the fold happened but was never recorded');
    assert.equal(rec[0].folded, 0, 'a hop-boundary fold swallows zero user turns');
    assert.match(rec[0].summary, /^HANDOFF NOTE\./, 'handoff note not kept verbatim');
    assert.ok(rec[0].before > 0 && rec[0].after > 0);
  });

  test('user turns are counted when the cut swallows them', async () => {
    const s = hoppy(2);
    for (let i = 0; i < 5; i++) {
      s.messages.push({ role: 'user', content: 'turn ' + i });
      s.messages.push({ role: 'assistant', content: 'ok' });
    }
    await s.compact('auto');
    const rec = s.history.find(h => h.kind === 'compacted');
    assert.ok(rec.folded > 0, `expected folded user turns, got ${rec.folded}`);
  });

  // The throw was invisible because it only reached a broadcast, which nothing
  // reads after the fact.
  test('an auto-compaction failure lands in the transcript, not just a broadcast', async () => {
    const s = hoppy(12);
    s.lastPromptTokens = 4000;          // over 0.75 x 4096, so #maybeCompact fires
    s.compact = async () => { throw new Error('boom'); };
    s.autoCompact = true;
    await s.send('go').catch(() => {});
    const failed = s.history.filter(h => h.kind === 'compact_failed');
    assert.equal(failed.length, 1, 'a failed auto-compaction left no record');
    assert.match(failed[0].text, /boom/);
  });
});

describe('settings resolution', () => {
  // These used to be environment-only, read at module load, with server.bat
  // setting no environment at all — so every value a benchmark record cites
  // lived somewhere nobody could see or version.
  test('harness settings come from config.json', async () => {
    const { num, flag, str, origin } = await import('../lib/config.js');
    assert.equal(origin('EMBER_MAX_HOPS', 'maxHops'), 'config.json', 'maxHops is not being read from config.json');
    assert.equal(num('EMBER_MAX_HOPS', 'maxHops', 1), MAX_HOPS);
    assert.equal(num('NOPE_NOT_SET', 'alsoNotSet', 42), 42, 'default did not survive');
    assert.equal(origin('NOPE_NOT_SET', 'alsoNotSet'), 'default');
    // the wording each knob already documented has to keep working
    assert.equal(flag('NOPE', 'nope', true), true);
    assert.equal(str('NOPE', 'nope', 'fallback'), 'fallback');
  });

  test('an environment variable overrides config.json', async () => {
    const { num, origin } = await import('../lib/config.js');
    process.env.EMBER_TEST_KNOB = '7';
    try {
      assert.equal(num('EMBER_TEST_KNOB', 'maxHops', 1), 7, 'env did not win');
      assert.equal(origin('EMBER_TEST_KNOB', 'maxHops'), 'env');
    } finally { delete process.env.EMBER_TEST_KNOB; }
  });

  test('config.json ships the harness block so it is discoverable', () => {
    const repo = path.resolve(import.meta.dirname, '..');
    for (const f of ['config.json', 'config.example.json']) {
      const cfg = JSON.parse(fs.readFileSync(path.join(repo, f), 'utf8'));
      assert.ok(cfg.harness, `${f} has no harness block`);
      assert.equal(cfg.harness.maxHops, 250, `${f} hop ceiling drifted`);
    }
  });
});

describe('the model is told its environment', () => {
  // FAULT: Fix 2 settled WHICH shell runs and never told the model. A run
  // emitted `dir`, `2>nul`, `findstr` and `type` into Git Bash and left two
  // stray files named `nul` on disk, one outside the workspace. Frontier
  // harnesses state the shell outright rather than letting it be inferred.
  test('the system prompt names the platform, shell and workspace', () => {
    const env = environmentPrompt('C:/Data/AI/Projects/Test');
    assert.match(env, /## Environment/);
    assert.match(env, /Platform/);
    assert.match(env, /C:\/Data\/AI\/Projects\/Test/);
    assert.match(env, new RegExp(SHELL_NAME));
    assert.match(env, /Working directory does not persist/);
  });

  test('systemFor composes the environment block in', () => {
    const sys = systemFor('coding-agent', 'C:/Data/AI/Projects/Test', null, false);
    assert.match(sys, /## Environment/);
    assert.match(sys, /Verify your own work/, 'the role instructions were displaced');
  });

  test('the run_command description names the shell and the cwd reset', () => {
    const d = TOOL_DEFS.find(t => t.name === 'run_command').description;
    assert.match(d, new RegExp(SHELL_NAME, 'i'));
    assert.match(d, /does NOT persist/);
    if (SHELL_NAME === 'git-bash') assert.match(d, /2>nul/, 'the exact trap that bit a run is not called out');
  });
});

describe('workspace escape detection', () => {
  const ws = process.platform === 'win32' ? 'C:\Data\AI\Projects\Test' : '/data/test';
  test('flags the escapes actually observed', () => {
    assert.equal(escapesWorkspace('cd .. && npm run build', ws), '..');
    assert.equal(escapesWorkspace('ls && cd .. && npm install', ws), '..');
    assert.ok(escapesWorkspace('cd', ws), 'bare cd goes home');
    assert.ok(escapesWorkspace('cd ~', ws), 'cd ~ goes home');
  });
  test('leaves legitimate in-workspace work alone', () => {
    assert.equal(escapesWorkspace('cd games/space-invaders && npm run build', ws), null);
    assert.equal(escapesWorkspace('npm run build', ws), null);
    assert.equal(escapesWorkspace('cd . && ls', ws), null);
    assert.equal(escapesWorkspace('cd sub/../other && ls', ws), null, 'a path that returns inside is fine');
  });
  test('does not guess at computed paths', () => {
    assert.equal(escapesWorkspace('cd $SOMEWHERE && ls', ws), null, 'cannot resolve it, so must not claim it escaped');
  });
  test('a real escape reaches the model in the command output', async () => {
    if (!posix) return;
    const out = await runCommand('cd .. && pwd', tmp, { timeoutMs: 10000 });
    assert.match(out, /WARNING: this command left the workspace/);
    assert.match(out, /out of scope/);
  });
  test('an ordinary command carries no warning', async () => {
    if (!posix) return;
    const out = await runCommand('pwd', tmp, { timeoutMs: 10000 });
    assert.doesNotMatch(out, /WARNING/);
  });
});

describe('empty turns', () => {
  // FAULT (session 32d6ceae): the model emitted its tool call INSIDE
  // reasoning_content — `</tool_call>` appears there verbatim — so LM Studio
  // parsed no tool call and returned no content. The harness read "no tool
  // calls" as "finished", ended the turn, and reported success with an empty
  // reply. The run stopped at turn 89 one sentence after "I found two
  // integration mismatches ... I'll fix both now", having never built anything.
  test('an empty turn is retried, not reported as finished', async () => {
    const s = session(stubLM([
      { content: '', finishReason: 'stop' },
      { content: 'fixed both mismatches', finishReason: 'stop' },
    ]));
    const out = await s.send('go');
    assert.equal(out, 'fixed both mismatches', 'the run ended on the empty turn');
    assert.equal(s.history.filter(h => h.kind === 'empty_turn').length, 1);
    assert.equal(s.history.filter(h => h.kind === 'bail').length, 0);
  });

  test('a stray tool call in reasoning is named in the nudge', async () => {
    const lm = stubLM([{ content: '', finishReason: 'stop' }, { content: 'done', finishReason: 'stop' }]);
    const base = lm.chatStream;
    let first = true;
    lm.chatStream = async (a) => {
      const r = await base(a);
      if (first) { first = false; r.reasoning = "I fix both now.\n</parameter>\n</function>\n</tool_call>"; }
      return r;
    };
    const s = session(lm);
    await s.send('go');
    const rec = s.history.find(h => h.kind === 'empty_turn');
    assert.equal(rec.strayCall, true, 'the tool-call-in-reasoning signature was missed');
    const nudge = s.messages.filter(m => m.role === 'user').pop();
    assert.match(nudge.content, /inside your reasoning/);
  });

  test('endless empty turns still terminate, as a bail', async () => {
    const s = session(stubLM([{ content: '', finishReason: 'stop' }]));
    const out = await s.send('go');
    assert.equal(s.history.filter(h => h.kind === 'empty_turn').length, MAX_EMPTY_RETRIES);
    const bail = s.history.find(h => h.kind === 'bail');
    assert.ok(bail, 'no bail recorded');
    assert.equal(bail.reason, 'empty_turn');
    assert.match(out, /neither output nor a tool call/);
  });

  test('a normal empty-content turn WITH tool calls is untouched', async () => {
    const s = session(stubLM([
      { content: '', toolCalls: [{ id: 'a', name: 'list_dir', args: '{"path":"."}' }], finishReason: 'stop' },
      { content: 'listed', finishReason: 'stop' },
    ]));
    const out = await s.send('go');
    assert.equal(out, 'listed');
    assert.equal(s.history.filter(h => h.kind === 'empty_turn').length, 0, 'a tool-calling turn is not empty');
  });
});

describe('runaway tool calls', () => {
  // FAULT (session 32d6ceae): the model emitted the SAME read_file 383 times in
  // one assistant turn. The loop ran every one, appending 383 results of ~24KB
  // -> a 9MB context. Role counts ended at tool:388 / assistant:6.
  test('identical calls in one turn collapse to one', () => {
    const calls = Array.from({ length: 383 }, (_, i) => ({ id: 'c' + i, name: 'read_file', args: '{"path":"GameController.js"}' }));
    const { kept, duplicates, overCap } = capToolCalls(calls);
    assert.equal(kept.length, 1, 'a repeated call is still one question');
    assert.equal(duplicates, 382);
    assert.equal(overCap, 0);
  });

  test('distinct calls are capped, not deduped away', () => {
    const calls = Array.from({ length: 100 }, (_, i) => ({ id: 'c' + i, name: 'read_file', args: `{"path":"f${i}.js"}` }));
    const { kept, duplicates, overCap } = capToolCalls(calls);
    assert.equal(kept.length, MAX_TOOL_CALLS_PER_TURN);
    assert.equal(duplicates, 0);
    assert.equal(overCap, 100 - MAX_TOOL_CALLS_PER_TURN);
  });

  test('an ordinary turn is untouched', () => {
    const calls = [{ id: 'a', name: 'read_file', args: '{"path":"a.js"}' }, { id: 'b', name: 'list_dir', args: '{"path":"."}' }];
    const { kept, duplicates, overCap } = capToolCalls(calls);
    assert.equal(kept.length, 2);
    assert.equal(duplicates + overCap, 0);
  });

  test('the model is told what was dropped, and only kept calls get results', async () => {
    const dupes = Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i, name: 'list_dir', args: '{"path":"."}' }));
    const s = session(stubLM([
      { content: '', toolCalls: dupes, finishReason: 'stop' },
      { content: 'ok', finishReason: 'stop' },
    ]));
    await s.send('go');
    const assistant = s.messages.find(m => m.tool_calls);
    const results = s.messages.filter(m => m.role === 'tool');
    assert.equal(assistant.tool_calls.length, 1, 'dropped calls must not stay in the assistant message');
    assert.equal(results.length, 1, 'every tool_call needs exactly one result');
    assert.match(results[0].content, /HARNESS: you emitted 40 tool calls/);
    assert.equal(s.history.filter(h => h.kind === 'tools_capped').length, 1);
  });
});

describe('cutPoint falls back on size', () => {
  // The same run again: 388 tool results under 6 hops meant
  // `hopIdxs.length <= keepRecentHops`, so cutPoint returned 0 and compaction
  // declined to run while the context sat at 9MB against a 124,928 window.
  // Realistic shape once the per-turn cap exists: many groups, each small.
  // 388 results under ONE assistant is no longer reachable — capToolCalls stops
  // it at 32 — so the size fallback is tested against what can actually occur.
  const fat = (groups, perGroup, chars) => {
    const s = new AgentSession({ id: 'f', lm: { async complete() { return 'NOTE. '.repeat(80); }, async chatStream() { throw new Error('x'); }, async models() { return []; } },
      model: 'm', workspace: tmp, preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: false });
    s.contextWindow = 124928;
    for (let g = 0; g < groups; g++) {
      s.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'g' + g, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      for (let i = 0; i < perGroup; i++) s.messages.push({ role: 'tool', tool_call_id: 'g' + g, content: 'x'.repeat(chars) });
    }
    return s;
  };

  test('a huge context under few hops still folds', async () => {
    const s = fat(20, 20, 24456);        // 400 tool results, 9.8MB — the real run's volume
    const before = s.messages.length;
    s.lastPromptTokens = 2203081;
    assert.equal(await s.compact('auto'), true, 'compaction declined on a 9MB context');
    assert.ok(s.messages.length < before / 2, `kept ${s.messages.length} of ${before}`);
    const bytes = JSON.stringify(s.messages).length;
    assert.ok(bytes < 124928 * 4, `kept ${bytes} chars, still over the window`);
  });

  test('a small conversation is left alone', async () => {
    const s = fat(1, 4, 200);
    assert.equal(await s.compact('auto'), false, 'folded a conversation that fits');
  });

  test('a fold never orphans a tool result', async () => {
    const s = fat(20, 20, 24456);
    s.lastPromptTokens = 2203081;
    await s.compact('auto');
    const first = s.messages.findIndex(m => m.role === 'tool');
    if (first > 0) {
      const owner = s.messages.slice(0, first).reverse().find(m => m.role === 'assistant');
      assert.ok(owner?.tool_calls?.length, 'a tool result survived without its assistant');
    }
  });
});

describe('oversized tool groups', () => {
  // A tool_calls group is indivisible - splitting it orphans a result from the
  // assistant that requested it - so a fold that cuts correctly can still leave
  // the context over the window when ONE group is bigger than the budget.
  // capToolCalls bounds the COUNT (32); read_file bounds each result (40,000
  // chars); nothing bounded the product, and 32 x 40,000 = 1,280,000 chars is
  // ~2.6x a 124,928-token window in a group nothing can split.
  const oneGroup = (n, chars) => {
    const s = new AgentSession({ id: 'w', lm: { async complete() { return 'NOTE. '.repeat(80); }, async chatStream() { throw new Error('x'); }, async models() { return []; } },
      model: 'm', workspace: tmp, preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: false });
    s.contextWindow = 124928;
    s.messages.push({ role: 'user', content: 'go' });
    const calls = Array.from({ length: n }, (_, i) => ({ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/File${i}.cs` }) } }));
    s.messages.push({ role: 'assistant', content: null, tool_calls: calls });
    for (const c of calls) s.messages.push({ role: 'tool', tool_call_id: c.id, content: 'x'.repeat(chars) });
    s.lastPromptTokens = Math.round(JSON.stringify(s.messages).length / 4);
    return s;
  };

  test('the legal worst case still fits the window after a fold', async () => {
    const s = oneGroup(MAX_TOOL_CALLS_PER_TURN, 40000);   // the cap x read_file's ceiling
    await s.compact('auto');
    const bytes = JSON.stringify(s.messages).length;
    assert.ok(bytes <= s.contextWindow * 4, `kept ${bytes} chars against a ${s.contextWindow * 4} budget`);
  });

  test('eviction drops content but never the message', async () => {
    const s = oneGroup(MAX_TOOL_CALLS_PER_TURN, 40000);
    const results = s.messages.filter(m => m.role === 'tool').length;
    await s.compact('auto');
    assert.equal(s.messages.filter(m => m.role === 'tool').length, results, 'a tool result was removed rather than emptied');
    const first = s.messages.findIndex(m => m.role === 'tool');
    const owner = s.messages.slice(0, first).reverse().find(m => m.role === 'assistant');
    assert.ok(owner?.tool_calls?.length, 'a tool result survived without its assistant');
  });

  test('the stub says where the content went', async () => {
    const s = oneGroup(MAX_TOOL_CALLS_PER_TURN, 40000);
    await s.compact('auto');
    const ev = s.messages.find(m => m.role === 'tool' && String(m.content).startsWith('[evicted'));
    assert.ok(ev, 'nothing was evicted on a context 2.6x the window');
    assert.match(ev.content, /read_file\(src\/File\d+\.cs\)/, 'the stub does not name the source');
  });

  test('the newest results survive intact', async () => {
    const s = oneGroup(MAX_TOOL_CALLS_PER_TURN, 40000);
    await s.compact('auto');
    const tools = s.messages.filter(m => m.role === 'tool');
    const last = tools[tools.length - 1];
    assert.equal(last.content.length, 40000, 'eviction reached the most recent result');
  });

  test('a group that already fits is left alone', async () => {
    const s = oneGroup(4, 2000);
    s.lastPromptTokens = 2203081;                  // force the fold to run
    await s.compact('auto');
    const ev = s.messages.filter(m => m.role === 'tool' && String(m.content).startsWith('[evicted'));
    assert.equal(ev.length, 0, 'evicted content from a conversation that already fit');
  });
});

describe('reasoning overrun', () => {
  // FAULT (session ba96be9b): five turns hit the output ceiling with content=0.
  // The whole 16,384-token budget went to reasoning_content, so auto-continue's
  // "resume where you left off" had nothing to resume and simply bought another
  // full budget of thinking — 4 rounds, ~26 minutes, 65k tokens, no output.
  // finish_reason 'length' covers two different failures and they need opposite
  // responses.
  const lm = (steps) => {
    const base = stubLM(steps);
    const inner = base.chatStream;
    let i = 0;
    base.chatStream = async (a) => {
      const r = await inner(a);
      r.reasoning = 'x'.repeat(500);   // it was thinking, not looping
      i++;
      return r;
    };
    return base;
  };

  test('a ceiling hit with no content is not treated as resumable', async () => {
    const s = session(lm([
      { content: '', finishReason: 'length' },
      { content: 'wrote the file', finishReason: 'stop' },
    ]));
    const out = await s.send('go');
    assert.equal(out, 'wrote the file');
    assert.equal(s.history.filter(h => h.kind === 'reasoning_overrun').length, 1);
    assert.equal(s.history.filter(h => h.kind === 'autocontinue').length, 0, 'auto-continue must not claim this one');
    const nudge = s.messages.filter(m => m.role === 'user').pop();
    assert.match(nudge.content, /Stop analysing and act/);
  });

  test('a ceiling hit WITH content still auto-continues', async () => {
    const s = session(stubLM([
      { content: 'half a file', finishReason: 'length' },
      { content: ' and the rest', finishReason: 'stop' },
    ]));
    const out = await s.send('go');
    assert.equal(out, 'half a file and the rest', 'genuine truncation must still resume');
    assert.equal(s.history.filter(h => h.kind === 'autocontinue').length, 1);
    assert.equal(s.history.filter(h => h.kind === 'reasoning_overrun').length, 0);
  });

  test('endless reasoning bails fast, and says why', async () => {
    const s = session(lm([{ content: '', finishReason: 'length' }]));
    const out = await s.send('go');
    // every occurrence is recorded, including the one that bails — the run record
    // should say how often it happened, not how often we retried
    assert.equal(s.history.filter(h => h.kind === 'reasoning_overrun').length, MAX_REASONING_OVERRUNS + 1);
    const bail = s.history.find(h => h.kind === 'bail');
    assert.equal(bail.reason, 'reasoning_overrun');
    assert.match(out, /budget on reasoning/);
    assert.match(out, /Raise maxOutputTokens/);
  });

  test('it bails far sooner than auto-continue would have', () => {
    // 4 rounds of a full budget is what the real run burned before stopping.
    assert.ok(MAX_REASONING_OVERRUNS < MAX_AUTO_CONTINUE,
      'a budget that produces nothing should be abandoned sooner than one that produces output');
  });
});

describe('reasoning budget', () => {
  // LM Studio's Reasoning Budget is a per-model LOAD-time setting and the API
  // does not report it — the loaded config exposes only
  // `reasoning_budget_message`. So it is declared in config.json, and the only
  // available check is whether the model ever spent more than the declaration.
  // Measured on qwen3.8-27b-mtp at 8192: reasoning clamped to 8190 and it
  // answered cleanly, on a prompt that had produced 2000 reasoning tokens and
  // zero content three times running.
  const withSeen = (seen) => {
    const s = session(stubLM([{ content: 'ok', finishReason: 'stop' }]));
    s.maxReasoningTokens = seen;
    return s;
  };

  test('a declaration consistent with what was observed reads as consistent', async () => {
    if (!REASONING_BUDGET) return;
    const md = await withSeen(REASONING_BUDGET - 2).report();
    assert.match(md, /consistent/);
    assert.doesNotMatch(md, /NOT in force/);
  });

  test('observing more than the declaration proves the budget is not in force', async () => {
    if (!REASONING_BUDGET) return;
    const md = await withSeen(REASONING_BUDGET + 1000).report();
    assert.match(md, /NOT in force/);
    assert.match(md, /load-time setting/);
  });

  test('a declaration with nothing observed is called unverified, not confirmed', async () => {
    if (!REASONING_BUDGET) return;
    const md = await withSeen(0).report();
    assert.match(md, /unverified/);
  });

  test('the high-water mark survives a restart', () => {
    const s = withSeen(8190);
    assert.equal(AgentSession.fromJSON(s.toJSON(), { lm: stubLM([]) }).maxReasoningTokens, 8190);
  });

  test('reasoning_tokens is carried off the stream', async () => {
    const s = session(stubLM([{ content: 'ok', finishReason: 'stop' }]));
    s.lm.chatStream = async () => ({ content: 'ok', reasoning: '', toolCalls: [], approxTokens: 5,
      promptTokens: 10, serverTps: 1, finishReason: 'stop', reasoningTokens: 4321 });
    await s.send('go');
    assert.equal(s.maxReasoningTokens, 4321, 'the harness never saw the reasoning cost');
  });
});

describe('config persistence', () => {
  // FAULT: server.js read config.json once at startup and saveConfig() wrote
  // that whole in-memory object back. Adding a workspace therefore reverted the
  // file to its startup snapshot — silently undoing every harness setting edited
  // while the server ran. Three keys (maxToolCallsPerTurn, maxReasoningOverruns,
  // reasoningBudget) vanished this way, and nothing reported it.
  test('saveConfig merges over the file instead of overwriting it', async () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'server.js'), 'utf8');
    const fn = src.slice(src.indexOf('const saveConfig'), src.indexOf('const app = express()'));
    assert.match(fn, /readFileSync\(configPath/, 'saveConfig must re-read the file before writing');
    assert.match(fn, /SERVER_OWNED/, 'it must write only the keys the server owns');
    assert.doesNotMatch(fn, /JSON\.stringify\(config,/, 'writing the whole in-memory config is the bug');
  });

  test('the server owns only workspaces and skills', async () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'server.js'), 'utf8');
    const m = src.match(/const SERVER_OWNED = \[([^\]]+)\]/);
    assert.ok(m, 'SERVER_OWNED not found');
    const owned = m[1].split(',').map(x => x.trim().replace(/['"]/g, '')).filter(Boolean);
    assert.deepEqual(owned.sort(), ['skills', 'workspaces'],
      'anything else the server persists would clobber a hand-edited harness setting');
  });

  test('every harness setting the code reads is present in config.example.json', () => {
    const repo = path.resolve(import.meta.dirname, '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'config.example.json'), 'utf8'));
    const src = fs.readFileSync(path.join(repo, 'lib', 'agent.js'), 'utf8')
      + fs.readFileSync(path.join(repo, 'lib', 'lmstudio.js'), 'utf8')
      + fs.readFileSync(path.join(repo, 'lib', 'identity.js'), 'utf8');
    const keys = [...src.matchAll(/(?:num|str|flag)\(\s*[`'"][A-Z_]+[`'"]\s*,\s*'([a-zA-Z]+)'/g)].map(m => m[1]);
    const missing = [...new Set(keys)].filter(k => !(k in cfg.harness));
    assert.deepEqual(missing, [], `harness keys read by the code but absent from the shipped config: ${missing}`);
  });
});

describe('context budgeting', () => {
  // A context window holds prompt AND completion — every generated token is
  // appended to the same sequence. So the compaction threshold has to leave room
  // for a whole response, and a fixed ratio cannot know the output ceiling:
  // 0.75 x 124,928 + 32,768 = 126,464, overflowing a 124,928 window by 1,536.
  const mk = () => new AgentSession({ id: 'b', lm: { async complete() { return 'x'; }, async chatStream() { throw new Error('x'); }, async models() { return []; } },
    model: 'm', workspace: tmp, preset: 'coding-agent', mode: 'plan', broadcast: () => {}, onDirty: () => {}, stateDir: null, identity: false });

  test('a turn starting at the threshold can still fit a full response', () => {
    const s = mk();
    for (const win of [32768, 65536, 100000, 124928, 200000, 262144]) {
      const t = s.compactThreshold(win);
      if (win - MAX_OUTPUT_TOKENS - CONTEXT_SAFETY_MARGIN <= 0) continue;   // flagged as misconfigured instead
      assert.ok(t + MAX_OUTPUT_TOKENS <= win,
        `window ${win}: threshold ${t} + ceiling ${MAX_OUTPUT_TOKENS} = ${t + MAX_OUTPUT_TOKENS}, over the window`);
    }
  });

  test('the real configuration no longer overflows', () => {
    const t = mk().compactThreshold(124928);
    assert.equal(t, 124928 - MAX_OUTPUT_TOKENS - CONTEXT_SAFETY_MARGIN);
    assert.ok(t < Math.round(124928 * 0.75), 'the derived threshold must be tighter than the old fixed ratio here');
  });

  test('the ratio still binds when it is the tighter of the two', () => {
    // A large window has plenty of output headroom, so 0.75 is the constraint.
    assert.equal(mk().compactThreshold(262144), Math.round(262144 * 0.75));
  });

  test('a window too small for the ceiling is reported, not silently clamped', async () => {
    const s = mk();
    s.contextWindow = MAX_OUTPUT_TOKENS;      // no room for prompt + response at all
    const md = await s.report();
    assert.match(md, /misconfigured/);
    assert.match(md, /Lower maxOutputTokens/);
  });

  // The portable rule from the research: G <= min(M, C - I - S). Sending a
  // constant ceiling implements only the M term.
  test('the generation cap follows min(M, C - I - S)', () => {
    const s = mk();
    const C = 128500, S = CONTEXT_SAFETY_MARGIN, M = MAX_OUTPUT_TOKENS;
    for (const I of [1000, 50000, 90000, 100000, 120000]) {
      s.lastPromptTokens = I;
      const expected = Math.max(MIN_OUTPUT_FLOOR, Math.min(M, C - I - S));
      assert.equal(s.outputCapFor(C), expected, `input ${I}`);
    }
  });

  test('a request never asks for more than the window can hold', () => {
    const s = mk();
    const C = 128500;
    for (const I of [1000, 60000, 96000, 126000]) {
      s.lastPromptTokens = I;
      const cap = s.outputCapFor(C);
      if (cap === MIN_OUTPUT_FLOOR) continue;     // floor case is reported, not silently sent
      assert.ok(I + cap <= C, `input ${I} + cap ${cap} = ${I + cap} exceeds ${C}`);
    }
  });

  test('a nearly full context reports the floor rather than dribbling', async () => {
    const s = mk();
    s.contextWindow = 128500;
    s.lastPromptTokens = 128000;
    assert.equal(s.outputCapFor(128500), MIN_OUTPUT_FLOOR);
    const md = await s.report();
    assert.match(md, /floor reached/);
    assert.match(md, /too full to work in/);
  });

  test('the effective content budget is reported, not left to be inferred', async () => {
    const s = mk();
    s.contextWindow = 124928;
    const md = await s.report();
    const row = md.split('\n').find(l => l.includes('Effective content budget'));
    assert.ok(row, 'no effective content budget row');
    if (REASONING_BUDGET) {
      assert.match(row, new RegExp((MAX_OUTPUT_TOKENS - REASONING_BUDGET).toLocaleString().replace(',', ',')));
      assert.match(row, /reasoning budget/);
    } else {
      assert.match(row, /no reasoning budget/);
    }
  });
});

describe('run report', () => {
  test('emits the model key verbatim and flags a harness bail', async () => {
    const s = session(stubLM([{ content: 'chunk ', finishReason: 'length' }]));
    s.model = 'gemma-4-12b-agentic-fable5-composer2.5-v2-3.5x-tau2@q6_k';
    await s.send('go');
    const md = await s.report();
    // The transcription bug this replaces: two run records carried the same key
    // with the @quant suffix dropped, which would have run one model twice.
    assert.match(md, /gemma-4-12b-agentic-fable5-composer2\.5-v2-3\.5x-tau2@q6_k/);
    assert.match(md, /Auto-continues used/);
    assert.match(md, /output ceiling/);
    assert.match(md, /Max output tokens \/ response \| 32,768/);
    assert.match(md, /re-run\*\* verification after repairing/);
  });
});

process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
