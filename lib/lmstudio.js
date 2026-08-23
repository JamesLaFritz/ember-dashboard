// lmstudio.js — thin client for the local LM Studio server.
// Uses the v1 native API for model management and the OpenAI-compatible
// /v1/chat/completions for inference (streaming + tools), per the docs
// mirrored in the vault at Raw/documentation/LM Studio/.
import { num } from './config.js';

// Generation bounds. Omitting max_tokens leaves LM Studio unbounded, so a
// prompt that asks for "as long as possible" is answered literally: a measured
// run was still streaming at 500s and 88,650 chars with no end in sight, and
// the turn produced nothing usable. A ceiling turns that into a clean, visible
// truncation. Generous on purpose — one fully-written source file can be long.
export const MAX_OUTPUT_TOKENS = num('EMBER_MAX_TOKENS', 'maxOutputTokens', 16384);

// Streaming means tokens arrive continuously; a long silence is a stall, not
// thinking. Abort rather than hang forever with no error and no output.
export const STREAM_IDLE_MS = num('EMBER_STREAM_IDLE_MS', 'streamIdleMs', 120000);

// …except while a tool call is being generated, when the premise above is false.
// Measured 2026-08-20: LM Studio emitted the opening tool_call packet (name set,
// `arguments: ""`) and then sent NOTHING for the next 120s while its own logs
// showed the model decoding continuously at 46–49 tok/s, n_decoded climbing
// 5,162 → 11,261. The argument JSON is evidently accumulated server-side and
// released at the end, so a large write_file payload is silent for as long as it
// takes to generate — roughly 22,000 characters per 120s on that model.
// The idle watchdog fired on a perfectly healthy generation and threw away
// ~6,100 tokens of a file the model had already written.
// So: once a tool call opens, switch to a budget sized for a whole payload.
export const TOOL_IDLE_MS = num('EMBER_TOOL_IDLE_MS', 'toolIdleMs', 600000);

export class LMStudio {
  constructor(baseUrl) { this.base = baseUrl.replace(/\/$/, ''); }

  async #json(path, init) {
    const res = await fetch(this.base + path, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    if (!res.ok) throw new Error(`LM Studio ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }

  async models() {
    const data = await this.#json('/api/v1/models');
    return (data.models ?? []).map(m => {
      // Loaded context lives under loaded_instances[0].config, not directly on
      // the instance — reading the shallow path always missed and fell back to
      // max_context_length, so the HUD showed the model's max as if it were loaded.
      const loadedCtx = m.loaded_instances?.[0]?.config?.context_length ?? null;
      return {
      key: m.key, name: m.display_name ?? m.key, type: m.type,
      loaded: (m.loaded_instances?.length ?? 0) > 0 || m.state === 'loaded',
      // Two different numbers, kept apart on purpose. `loadedContextLength` is
      // null unless the model is actually loaded; `contextLength` falls back to
      // the advertised max so compaction has something to work with. Anything
      // that RECORDS a number — a benchmark run report — must use the former,
      // because a 262,144 max reported as a loaded window is exactly the
      // misdiagnosis this project has already made once.
      loadedContextLength: loadedCtx,
      contextLength: loadedCtx ?? m.max_context_length ?? null,
      maxContextLength: m.max_context_length ?? null,
      quant: m.quantization?.name ?? null,
      sizeGB: m.size_bytes ? +(m.size_bytes / 1e9).toFixed(1) : null,
      arch: m.architecture ?? null,
      publisher: m.publisher ?? null,
      };
    });
  }

  load(model)   { return this.#json('/api/v1/models/load',   { method: 'POST', body: JSON.stringify({ model }) }); }
  // Unload wants instance_id, not model — the id defaults to the model key.
  unload(model) { return this.#json('/api/v1/models/unload', { method: 'POST', body: JSON.stringify({ instance_id: model }) }); }

  async available() {
    try { await this.models(); return true; } catch { return false; }
  }

  // One-shot completion (router / summarizer duty). Non-streaming on purpose.
  // Reasoning models (Qwen3.x etc.) burn tokens in reasoning_content before
  // emitting content — budget generously and never return an empty answer.
  // `salvage` decides what an empty answer becomes. The HUD router must never
  // show the user nothing, so it takes the tail of the reasoning stream. A
  // compaction summary must do the opposite: a fragment of unfinished thinking
  // is far worse than a failure, because it gets written over the context it
  // was supposed to preserve. Callers that can handle '' should pass false.
  async complete({ model, system, user, maxTokens = 4096, temperature = 0.4, salvage = true }) {
    const data = await this.#json('/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    });
    const msg = data.choices?.[0]?.message ?? {};
    let content = (msg.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!content && !salvage) return '';
    if (!content && msg.reasoning_content) {
      // Thinking consumed the budget: salvage the tail rather than say nothing.
      const tail = msg.reasoning_content.trim().split(/\n+/).filter(Boolean).pop() ?? '';
      content = tail.slice(0, 400);
    }
    return content;
  }

  // Streaming chat with optional tool definitions (agent workbench duty).
  // onDelta(textChunk) / onReasoning(textChunk); returns { content, reasoning,
  // toolCalls } when the turn ends.
  async chatStream({ model, messages, tools, temperature = 0.3, onDelta, onReasoning,
                     idleMs = STREAM_IDLE_MS, toolIdleMs = TOOL_IDLE_MS }) {
    // Reset on every chunk: bounds the gap BETWEEN tokens, not the total run,
    // so a legitimately long generation is never cut off for being long.
    const ac = new AbortController();
    let budget = idleMs;          // raised to toolIdleMs once a tool call opens
    let inTool = false;
    let idle = setTimeout(() => ac.abort(), budget);
    const kick = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(), budget); };

    // The watchdog is already armed here, so an abort can land before the
    // response headers do — a server that accepts the connection and never
    // replies. Left unhandled that surfaces as a bare "AbortError: This
    // operation was aborted", which says nothing about what failed.
    let res;
    try {
      res = await fetch(this.base + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, temperature, stream: true, max_tokens: MAX_OUTPUT_TOKENS, stream_options: { include_usage: true } }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(idle);
      if (ac.signal.aborted) {
        throw new Error(`LM Studio accepted the connection but sent no response header within ${idleMs / 1000}s. `
          + `The server is up but not answering — it is usually still loading the model, or wedged. Check the LM Studio window, or raise EMBER_STREAM_IDLE_MS.`);
      }
      throw err;
    }
    if (!res.ok) {
      // LM Studio returns either a JSON error (with a useful message) or a
      // generic HTML 500 page. Pull the meaningful part; skip the HTML noise.
      const raw = (await res.text()).trim();
      const isHtml = /^<!doctype html|^<html/i.test(raw);
      let detail = raw.slice(0, 200);
      try { const j = JSON.parse(raw); detail = j.error?.message ?? j.error ?? detail; } catch { /* not JSON */ }
      // A 5xx on a local chat is almost always resources, not a bad request —
      // give the actionable hint instead of dumping an HTML error page.
      if (res.status >= 500) {
        throw new Error(
          `LM Studio ${res.status} on chat. On a local model this usually means the request outgrew the model's LOADED context window, or the KV cache ran out of VRAM. Fixes: lower the model's context length in LM Studio, enable Q8 KV-cache quantization, or reload the model.`
          + (isHtml ? '' : ` (${detail})`)
        );
      }
      throw new Error(`LM Studio chat → ${res.status}: ${detail}`);
    }

    let content = '';
    let reasoning = ''; // reasoning_content deltas (models whose thinking LM Studio parses out)
    let usage = null;   // final-chunk usage (real token counts) when the server sends it
    let statsTps = null; // LM Studio's own tokens_per_second when present
    const toolCalls = []; // accumulate indexed tool_call deltas
    let finishReason = null;
    const decoder = new TextDecoder();
    let buf = '';
    try {
    for await (const chunk of res.body) {
      kick();
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.usage) usage = evt.usage;
        if (evt.stats?.tokens_per_second) statsTps = evt.stats.tokens_per_second;
        if (evt.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
        const delta = evt.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) { reasoning += delta.reasoning_content; onReasoning?.(delta.reasoning_content); }
        if (delta.content) { content += delta.content; onDelta?.(delta.content); }
        // The opening tool_call packet is the last thing heard until the whole
        // argument payload is ready, so it is exactly the signal to stop
        // measuring silence as a stall and start measuring it as work.
        if (delta.tool_calls?.length && !inTool) { inTool = true; budget = toolIdleMs; kick(); }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          toolCalls[i] ??= { id: tc.id ?? `call_${i}`, name: '', args: '' };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
        }
      }
    }
    } catch (err) {
      if (ac.signal.aborted) {
        const partial = toolCalls.reduce((n, t) => n + (t?.args?.length ?? 0), 0);
        throw new Error(inTool
          ? `LM Studio sent nothing for ${toolIdleMs / 1000}s while building a ${toolCalls.map(t => t?.name).filter(Boolean).join(', ') || 'tool'} call. `
            + `Argument payloads are released only when complete, so silence here is normal and this budget is sized for a whole file — `
            + `exceeding it means the payload is enormous or the server is wedged. `
            + `Received ${content.length + reasoning.length} chars of text and ${partial} chars of arguments first. Raise EMBER_TOOL_IDLE_MS if the file is legitimately that big.`
          : `LM Studio sent nothing for ${idleMs / 1000}s — treating the stream as stalled. `
            + `Received ${content.length + reasoning.length} chars before the stall. `
            + `A model offloaded to CPU can be this slow; check VRAM headroom, or raise EMBER_STREAM_IDLE_MS.`);
      }
      throw err;
    } finally {
      clearTimeout(idle);
    }
    // Prefer the server's real numbers; ~4 chars/token only as the fallback.
    const approxTokens = usage?.completion_tokens
      ?? Math.max(1, Math.round((content.length + toolCalls.reduce((n, t) => n + (t?.args?.length ?? 0), 0)) / 4));
    return {
      content, reasoning, toolCalls: toolCalls.filter(Boolean), approxTokens,
      promptTokens: usage?.prompt_tokens ?? null, // null when the server omits usage
      // LM Studio's Reasoning Budget is a load-time setting the API does not
      // report back — the loaded config exposes only reasoning_budget_message.
      // It cannot be read, but it CAN be cross-checked: this is what the model
      // actually spent thinking, so a declared budget that is not in force
      // shows up as an observed value above it.
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
      serverTps: statsTps, finishReason,
    };
  }
}
