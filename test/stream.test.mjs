// stream.test.mjs — the streaming watchdog, against a real SSE server.
//
// FAULT (2026-08-20): LM Studio emitted the opening tool_call packet and then
// nothing for 120s while its own logs showed the model decoding continuously at
// 46-49 tok/s (n_decoded 5,162 -> 11,261). Argument payloads are released only
// when complete, so a large write_file is silent for as long as it takes to
// generate. The idle watchdog killed a healthy generation and discarded ~6,100
// tokens of an already-written file — the eleventh harness fault that looked
// exactly like the model giving up.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LMStudio, STREAM_IDLE_MS, TOOL_IDLE_MS } from '../lib/lmstudio.js';

// Scripted SSE: each step is [delayMsBeforeSending, deltaObject].
let script = [];
let headerDelay = 0;   // stall before replying at all, to test the pre-header path
let server, base;

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

before(async () => {
  server = createServer(async (req, res) => {
    if (headerDelay) await new Promise(r => setTimeout(r, headerDelay));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();   // otherwise fetch() stays pending and every test measures the wrong phase
    for (const [delay, payload] of script) {
      await new Promise(r => setTimeout(r, delay));
      if (res.writableEnded) return;
      res.write(sse(payload));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const run = (opts = {}) => new LMStudio(base).chatStream({
  model: 'stub', messages: [{ role: 'user', content: 'go' }], tools: [], ...opts,
});

describe('stream watchdog', () => {
  test('a genuinely silent stream still aborts', async () => {
    headerDelay = 0;
    script = [[400, chunk({ content: 'hi' })]];   // 400ms of nothing after headers
    await assert.rejects(
      run({ idleMs: 150, toolIdleMs: 5000 }),
      /sent nothing for 0\.15s — treating the stream as stalled/,
    );
  });

  // Found by the test above before headers were flushed: aborting while fetch()
  // is still pending escapes the stream error path entirely and surfaces as a
  // bare "AbortError: This operation was aborted".
  test('a server that never sends headers says so', async () => {
    headerDelay = 400;
    script = [];
    await assert.rejects(
      run({ idleMs: 150, toolIdleMs: 5000 }),
      (err) => {
        assert.match(err.message, /sent no response header within 0\.15s/);
        assert.doesNotMatch(err.message, /AbortError/);
        return true;
      },
    );
    headerDelay = 0;
  });

  // The regression. Reproduces the shape of the real log exactly: text streams,
  // the tool call opens with empty arguments, then a long silence, then the
  // payload arrives in one go.
  test('silence AFTER a tool call opens is work, not a stall', async () => {
    script = [
      [0, chunk({ reasoning_content: 'planning the file…' })],
      [0, chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '' } }] })],
      [600, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"plan.md","content":"…"}' } }] })],
      [0, chunk({}, 'tool_calls')],
    ];
    // 200ms idle budget would have killed this at the 600ms gap — as it did in
    // production at 120s. The tool budget has to take over the moment the call opens.
    const out = await run({ idleMs: 200, toolIdleMs: 5000 });
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'write_file');
    assert.equal(JSON.parse(out.toolCalls[0].args).path, 'plan.md');
    assert.equal(out.finishReason, 'tool_calls');
  });

  test('an over-budget tool call reports what it was building, not "stalled"', async () => {
    script = [
      [0, chunk({ tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'write_file', arguments: '' } }] })],
      [900, chunk({}, 'tool_calls')],
    ];
    await assert.rejects(
      run({ idleMs: 5000, toolIdleMs: 200 }),
      (err) => {
        assert.match(err.message, /while building a write_file call/);
        assert.match(err.message, /silence here is normal/);
        assert.doesNotMatch(err.message, /treating the stream as stalled/);
        return true;
      },
    );
  });

  test('defaults leave room for a whole file', () => {
    // 120s at the measured ~46 tok/s is only ~22,000 chars of payload — a normal
    // game source file. The tool budget must be several times that.
    assert.equal(STREAM_IDLE_MS, 120000);
    assert.equal(TOOL_IDLE_MS, 600000);
    assert.ok(TOOL_IDLE_MS >= 5 * STREAM_IDLE_MS, 'tool budget is not meaningfully larger');
  });
});
