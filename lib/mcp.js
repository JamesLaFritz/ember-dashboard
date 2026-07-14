// mcp.js — minimal MCP client for the agent workbench. Reads the exact same
// server definitions Claude Code uses (~/.claude.json "mcpServers"), spawns
// stdio servers lazily on first use, and keeps them alive for the process.
// Transports: stdio (newline-delimited JSON-RPC) and basic streamable HTTP.
// Hosted claude.ai connectors (Gmail, Slack, …) are NOT reachable this way —
// they live behind the user's Anthropic account, not in this config.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const PROTOCOL = '2024-11-05';

export class MCPManager {
  constructor({ configFile } = {}) {
    this.configFile = configFile ?? path.join(os.homedir(), '.claude.json');
    this.conns = new Map();     // name -> live connection
    this.lastError = new Map(); // name -> last connect/call failure (for the UI)
  }

  // Re-read on every call: cheap, and edits to Claude's config flow straight in.
  defs() {
    try { return JSON.parse(fs.readFileSync(this.configFile, 'utf8')).mcpServers ?? {}; }
    catch { return {}; }
  }
  names() { return Object.keys(this.defs()); }

  status() {
    return this.names().map(name => {
      const c = this.conns.get(name);
      return { name, connected: !!c, tools: c?.tools?.length ?? null, error: this.lastError.get(name) ?? null };
    });
  }

  async tools(name) { return (await this.#connect(name)).tools; }

  async call(name, tool, args, timeoutMs = 60000) {
    const c = await this.#connect(name);
    const res = await this.#request(c, 'tools/call', { name: tool, arguments: args ?? {} }, timeoutMs);
    const parts = (res?.content ?? []).map(p => p.type === 'text' ? p.text : `[${p.type} content]`).join('\n');
    const text = parts || JSON.stringify(res);
    const out = res?.isError ? `ERROR from ${name}: ${text}` : text;
    return out.length > 20000 ? out.slice(0, 20000) + `\n…truncated (${out.length} chars total)` : out;
  }

  disconnect(name) {
    const c = this.conns.get(name);
    this.conns.delete(name);
    if (c?.proc) { try { c.proc.kill(); } catch { /* already gone */ } }
  }

  async #connect(name) {
    const existing = this.conns.get(name);
    if (existing) return existing;
    const def = this.defs()[name];
    if (!def) throw new Error(`unknown MCP server: ${name}`);

    let conn;
    if (def.url || def.type === 'http') {
      conn = { http: true, url: def.url, headers: def.headers ?? {}, sessionId: null, nextId: 1 };
    } else {
      // shell:true so Windows resolves npx.cmd and friends.
      const proc = spawn(def.command, def.args ?? [], {
        env: { ...process.env, ...(def.env ?? {}) }, shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      conn = { proc, buf: '', pending: new Map(), nextId: 1 };
      proc.stdout.on('data', (chunk) => this.#onData(conn, chunk));
      proc.stderr.on('data', () => { /* server logs; not part of the protocol */ });
      proc.on('exit', () => {
        this.conns.delete(name);
        for (const p of conn.pending.values()) p.reject(new Error(`MCP server ${name} exited`));
        conn.pending.clear();
      });
      proc.on('error', (err) => {
        this.conns.delete(name);
        for (const p of conn.pending.values()) p.reject(err);
        conn.pending.clear();
      });
    }
    this.conns.set(name, conn);
    try {
      // Init timeout is generous: a cold `npx` may download the package first.
      const init = await this.#request(conn, 'initialize', {
        protocolVersion: PROTOCOL, capabilities: {},
        clientInfo: { name: 'ember-workbench', version: '0.1.0' },
      }, 90000);
      conn.serverInfo = init?.serverInfo;
      await this.#notify(conn, 'notifications/initialized', {});
      conn.tools = (await this.#request(conn, 'tools/list', {}, 30000)).tools ?? [];
      this.lastError.delete(name);
      return conn;
    } catch (err) {
      this.lastError.set(name, String(err.message ?? err).slice(0, 200));
      this.disconnect(name);
      throw err;
    }
  }

  // ---- stdio transport: one JSON-RPC message per line ----
  #onData(conn, chunk) {
    conn.buf += chunk.toString('utf8');
    let nl;
    while ((nl = conn.buf.indexOf('\n')) >= 0) {
      const line = conn.buf.slice(0, nl).trim();
      conn.buf = conn.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const p = conn.pending.get(msg.id);
        if (p) {
          conn.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      } else if (msg.id != null && msg.method) {
        // Server-initiated request (roots/list, sampling…) — decline politely.
        const reply = msg.method === 'roots/list'
          ? { jsonrpc: '2.0', id: msg.id, result: { roots: [] } }
          : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by ember-workbench' } };
        conn.proc.stdin.write(JSON.stringify(reply) + '\n');
      } // else: notification from the server — ignored
    }
  }

  #request(conn, method, params, timeoutMs) {
    if (conn.http) return this.#httpRequest(conn, method, params, timeoutMs);
    return new Promise((resolve, reject) => {
      const id = conn.nextId++;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      conn.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      conn.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async #notify(conn, method, params) {
    if (conn.http) {
      await this.#httpPost(conn, { jsonrpc: '2.0', method, params }, 15000).catch(() => {});
      return;
    }
    conn.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  // ---- streamable HTTP transport (single POST per request; SSE-aware) ----
  async #httpRequest(conn, method, params, timeoutMs) {
    const id = conn.nextId++;
    const res = await this.#httpPost(conn, { jsonrpc: '2.0', id, method, params }, timeoutMs);
    if (method === 'initialize') conn.sessionId = res.headers.get('mcp-session-id') ?? conn.sessionId;
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    let msg = null;
    if (type.includes('text/event-stream')) {
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { const m = JSON.parse(line.slice(5).trim()); if (m.id === id) { msg = m; break; } } catch { /* keep scanning */ }
      }
    } else if (body.trim()) {
      msg = JSON.parse(body);
    }
    if (!msg) throw new Error(`empty MCP response (${res.status})`);
    if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
    return msg.result;
  }
  async #httpPost(conn, payload, timeoutMs) {
    const res = await fetch(conn.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
        ...(conn.sessionId ? { 'Mcp-Session-Id': conn.sessionId } : {}), ...conn.headers,
      },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok && res.status !== 202) throw new Error(`MCP HTTP ${res.status}`);
    return res;
  }
}
