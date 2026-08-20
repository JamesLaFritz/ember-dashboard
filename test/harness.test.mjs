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
  clipOutput, runCommand, AgentSession, systemFor, PRESETS,
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
    assert.equal(MAX_OUTPUT_TOKENS, 16384, 'output ceiling changed — run records cite this');
    assert.equal(MAX_HOPS, 120, 'hop ceiling changed');
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

describe('run report', () => {
  test('emits the model key verbatim and flags a harness bail', async () => {
    const s = session(stubLM([{ content: 'chunk ', finishReason: 'length' }]));
    s.model = 'gemma-4-12b-agentic-fable5-composer2.5-v2-3.5x-tau2@q6_k';
    await s.send('go');
    const md = s.report();
    // The transcription bug this replaces: two run records carried the same key
    // with the @quant suffix dropped, which would have run one model twice.
    assert.match(md, /gemma-4-12b-agentic-fable5-composer2\.5-v2-3\.5x-tau2@q6_k/);
    assert.match(md, /Auto-continues used/);
    assert.match(md, /output ceiling/);
    assert.match(md, /Max output tokens \/ response \| 16,384/);
    assert.match(md, /re-run\*\* verification after repairing/);
  });
});

process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
