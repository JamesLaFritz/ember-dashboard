// lmstudio.js — thin client for the local LM Studio server.
// Uses the v1 native API for model management and the OpenAI-compatible
// /v1/chat/completions for inference (streaming + tools), per the docs
// mirrored in the vault at Raw/documentation/LM Studio/.
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
    return (data.models ?? []).map(m => ({
      key: m.key, name: m.display_name ?? m.key, type: m.type,
      loaded: (m.loaded_instances?.length ?? 0) > 0 || m.state === 'loaded',
      contextLength: m.loaded_instances?.[0]?.context_length ?? m.max_context_length ?? null,
      maxContextLength: m.max_context_length ?? null,
      quant: m.quantization?.name ?? null,
      sizeGB: m.size_bytes ? +(m.size_bytes / 1e9).toFixed(1) : null,
      arch: m.architecture ?? null,
      publisher: m.publisher ?? null,
    }));
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
  async complete({ model, system, user, maxTokens = 4096, temperature = 0.4 }) {
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
    if (!content && msg.reasoning_content) {
      // Thinking consumed the budget: salvage the tail rather than say nothing.
      const tail = msg.reasoning_content.trim().split(/\n+/).filter(Boolean).pop() ?? '';
      content = tail.slice(0, 400);
    }
    return content;
  }

  // Streaming chat with optional tool definitions (agent workbench duty).
  // onDelta(textChunk), returns { content, toolCalls } when the turn ends.
  async chatStream({ model, messages, tools, temperature = 0.3, onDelta }) {
    const res = await fetch(this.base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, temperature, stream: true, stream_options: { include_usage: true } }),
    });
    if (!res.ok) throw new Error(`LM Studio chat → ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let content = '';
    let usage = null;   // final-chunk usage (real token counts) when the server sends it
    let statsTps = null; // LM Studio's own tokens_per_second when present
    const toolCalls = []; // accumulate indexed tool_call deltas
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
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
        const delta = evt.choices?.[0]?.delta ?? {};
        // reasoning_content deltas are deliberately not surfaced or stored —
        // the workbench shows conclusions, not chain-of-thought.
        if (delta.content) { content += delta.content; onDelta?.(delta.content); }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          toolCalls[i] ??= { id: tc.id ?? `call_${i}`, name: '', args: '' };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
        }
      }
    }
    // Prefer the server's real numbers; ~4 chars/token only as the fallback.
    const approxTokens = usage?.completion_tokens
      ?? Math.max(1, Math.round((content.length + toolCalls.reduce((n, t) => n + (t?.args?.length ?? 0), 0)) / 4));
    return {
      content, toolCalls: toolCalls.filter(Boolean), approxTokens,
      promptTokens: usage?.prompt_tokens ?? null, // null when the server omits usage
      serverTps: statsTps,
    };
  }
}
