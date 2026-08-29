// tools/cf-harness.js
// Local Cloudflare Workers test harness — runs your REAL worker handlers
// (default.scheduled / default.queue / default.fetch) against in-memory fakes
// of every binding (D1/KV/Queue) and a mockable fetch(). No workerd subprocess,
// no wrangler, no persist dir, no experimental API. Pure stdlib.
//
// Usage from another tool:
//   import { Harness, MockD1, MockKV, MockQueue, MockFetch } from "./cf-harness.js"
//
// This file deliberately has NO knowledge of whalesignal. Per-project fixtures
// (fixture.js) wire up the bindings + fetch router + scenarios. This is the
// reusable piece — copy it to any worker project.
//
// MockD1 is a real in-memory SQLite via node:sqlite, driven by a
// minimal .prepare()/.bind()/.all()/.first()/.run() shim that mirrors the D1
// subset your workers actually use. If you need more of the D1 API surface
// (batch, raw, dump) extend the stub — but only when a worker actually calls it.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

// ─── MockD1: real SQLite via node:sqlite, with D1's chained-prepared-statement surface ─

export class MockD1 {
  /** @param {string|undefined} path  in-memory by default; pass a path for persistence */
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = MEMORY;");
    this.db.exec("PRAGMA foreign_keys = ON;");
  }

  /** Load and run a .sql schema file. Strips `--` line comments, then runs
   *  each statement separated by ';'. */
  execFile(schemaPath) {
    const raw = readFileSync(schemaPath, "utf8");
    // strip line comments (`-- to end of line`); keep just SQL.
    const stripped = raw
      .split("\n")
      .map((line) => line.replace(/\s*--.*$/, ""))
      .join("\n");
    // split on ; followed by newline (the statement terminator).
    for (const stmt of stripped.split(/;\s*\n/)) {
      const s = stmt.trim();
      if (!s) continue;
      this.db.exec(s + ";");
    }
    return this;
  }

  // D1-shaped prepared statement. Supports chained .bind(...) and the three
  // terminators: .all(), .first(), .run(). Mirrors the real D1 result shape
  // (meta.changes, meta.last_row_id) so workers that read those keep working.
  prepare(sql) {
    return new _Stmt(this.db, sql);
  }
  /** D1 batch: statements run sequentially in one roundtrip. Returns the
   *  per-statement run() results in order, mirroring real D1. */
  async batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }
}

class _Stmt {
  constructor(dbObj, sql) {
    this.db = dbObj;
    this.sql = sql;
    this.binds = [];
  }
  bind(...args) {
    // D1 accepts the same NUMBER of bind params as placeholders; we just stash.
    this.binds = args;
    return this; // chainable
  }
  all() {
    // prepare fresh each call — node:sqlite StatementSync is single-use-ish
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.binds);
    return { results: rows };
  }
  first() {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.binds);
    return row ?? null;
  }
  run() {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.binds);
    // D1 shape: { success, meta: { changes, last_row_id } }
    return {
      success: true,
      meta: { changes: info.changes ?? 0, last_row_id: info.lastInsertRowid ?? 0 },
    };
  }
}

// ─── MockKV: plain Map, async like the real one ─────────────────────────────

export class MockKV {
  constructor(initial = {}) {
    this.store = new Map(Object.entries(initial));
  }
  async get(key) {
    const v = this.store.get(key);
    return v ?? null; // real KV returns null for missing; string for stored strings
  }
  async put(key, value) {
    this.store.set(key, String(value));
  }
  async list(opts = {}) {
    const all = [...this.store.entries()].sort();
    return { keys: all.map(([name]) => ({ name })) };
  }
}

// ─── MockQueue: collects sent messages + delivers them on demand ─────────────
// real Workers Queues are async, at-least-once, and rate-limited.
// We model the SUBSET needed to drive tests: send()/buffer/ack()/retry().
// Don't model delaySeconds, message retention, or rate-limit shaping —
// add when a worker actually uses those.

export class MockQueue {
  constructor(name = "mock-queue") {
    this.name = name;
    this.sent = [];      // every send(), in order
    this.pending = [];  // not yet acked
  }
  async send(body, opts) {
    // body is a string in CF Queues (you JSON.stringify before send); mirror that.
    const msg = new _Msg(this, body, opts);
    this.sent.push(msg);
    this.pending.push(msg);
  }
  // drain pending into the consumer's batch handler. Returns whatever the
  // handler returned. ack()/retry() mutate msg state — see _Msg.
  async deliver(handler) {
    const pending = this.pending;
    this.pending = [];
    // attach live ack/retry closures to each pending message
    for (const m of pending) m._live = { ack: () => { m._state = "ack"; }, retry: () => { m._state = "retry"; } };
    // Cloudflare Queues batch shape: { messages: [{ body, ack(), retry() }] }
    // Pass the _Msg instances directly — keep their prototype methods live.
    const batch = { messages: pending.map((m) => ({ body: m.body, ack: m.ack.bind(m), retry: m.retry.bind(m) })) };
    return await handler(batch);
  }
}

class _Msg {
  constructor(q, body, opts) {
    this.body = body;
    this.opts = opts;
    this._state = null; // "ack" | "retry" | null
    this._live = null;  // set during delivery
  }
  // in-batch ack/retry proxies deliver onto the live handler closures
  ack()  { if (this._live) this._live.ack();  else throw new Error("ack outside delivery"); }
  retry(){ if (this._live) this._live.retry();else throw new Error("retry outside delivery"); }
}

// ─── MockFetch: route incoming fetch() calls to handler functions ────────────
// Routes are matched by URL prefix. First match wins. Handler gets (url, init)
// and returns either a plain JS object (auto-wrapped as { ok:true, json:()=>... })
// or a { status, json: ..., text: ... } for full control.

export class MockFetch {
  constructor(routes = []) {
    this.routes = routes;     // [{match: string|RegExp, handler: fn}, ...]
    this.calls = [];          // log every call, for assertions
    this.unhandled = "throw"; // "throw" | "passthrough"
  }
  handler() {
    return async (input, init = {}) => {
      const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      const u = url.toString();
      this.calls.push({ url: u, init });

      for (const r of this.routes) {
        const hit = r.match instanceof RegExp ? r.match.test(u) : u.startsWith(r.match);
        if (hit) {
          const out = await r.handler(url, init, this);
          if (out instanceof Response) return out;
          // build a Response
          const status = out.status ?? 200;
          const body = out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? "");
          return new Response(body, {
            status,
            headers: { "content-type": out.json !== undefined ? "application/json" : "text/plain" },
          });
        }
      }
      if (this.unhandled === "passthrough") return fetch(input, init);
      throw new Error(`MockFetch: unhandled URL: ${u}`);
    };
  }
}

// ─── Harness: wires env + installs fetch stub, runs your handlers ───────────
//
// One Harness = one worker invocation context. Build the env yourself (so you
// can use whatever binding names the worker needs) and pass it in; the harness
// gives you affordances to install the fetch stub globally for the duration of
// a run (restored after).

export class Harness {
  /**
   * @param {object} env   bindings: D1 as MockD1, KV as MockKV, queues as MockQueue, etc.
   * @param {MockFetch} fetchMock
   */
  constructor(env, fetchMock) {
    this.env = env;
    this.fetchMock = fetchMock;
    this._origFetch = globalThis.fetch;
  }
  // Run a worker's default.scheduled handler
  async scheduled(workerDefault, scheduledTime = Date.now(), cron = "* * * * *") {
    this._installFetch();
    try {
      const event = { scheduledTime, cron, noTimeout() {} };
      // Cloudflare scheduled: handler(event, env, ctx). ctx is mostly for waitUntil; we accept.
      return await workerDefault.scheduled(event, this.env, { waitUntil: (p) => p, passThroughOnException: () => {} });
    } finally { this._restoreFetch(); }
  }
  // Run a worker's default.queue handler. Pass a MockQueue whose pending msgs
  // should be delivered into it.
  async queue(workerDefault, mq) {
    this._installFetch();
    try {
      return await mq.deliver((batch) => workerDefault.queue(batch, this.env));
    } finally { this._restoreFetch(); }
  }
  // Run a worker's default.fetch handler. Pass either a Request or (url, init).
  async fetch(workerDefault, url, init = {}) {
    this._installFetch();
    try {
      const req = url instanceof Request ? url : new Request(url, init);
      return await workerDefault.fetch(req, this.env, { waitUntil: (p) => p, passThroughOnException: () => {} });
    } finally { this._restoreFetch(); }
  }
  _installFetch() { globalThis.fetch = this.fetchMock.handler(); }
  _restoreFetch() { globalThis.fetch = this._origFetch; }
}
