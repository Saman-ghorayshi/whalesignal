// tests/bot.test.js
// Tests the pure alert formatter (formatAlert) + GitHub dispatch logic.
// No Telegram, no D1, no real GitHub API — fetch is mocked for dispatch tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAlert, buildAlertJSON, fireGitHubDispatch, latestRows, renderLatestReply, renderLatestJSON, fetchHandler, queueHandler, historyRows, historyCount, renderHistoryJSON, renderWalletJSON, isValidGhRepo } from "../src/bot.js";
import { tgSendMessage } from "../src/worker-utils.js";

// ─── test scaffolding for handler-level tests ─────────────────────────
// Flexible D1 stub: routes = [[predicate(stmt, binds) => bool, {all, first, run}], ...]
function stubDB(routes) {
  return {
    prepare(stmt) {
      const self = {
        _stmt: stmt,
        _bind: [],
        bind(...args) { self._bind = args; return self; },
        async all() {
          const r = routes.find(([pred]) => pred(self._stmt, self._bind));
          return r && r[1].all ? r[1].all(self._stmt, self._bind) : { results: [] };
        },
        async first() {
          const r = routes.find(([pred]) => pred(self._stmt, self._bind));
          return r && r[1].first ? r[1].first(self._stmt, self._bind) : null;
        },
        async run() {
          const r = routes.find(([pred]) => pred(self._stmt, self._bind));
          return r && r[1].run ? r[1].run(self._stmt, self._bind) : { meta: { changes: 0 } };
        },
      };
      return self;
    },
  };
}

function stubKV(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => { map.set(k, v); },
    _map: map,
  };
}

// Mock global fetch; capture calls; route telegram vs others.
function mockFetch(captured) {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    captured.push({ url: String(url), method: opts?.method, headers: opts?.headers || {}, body });
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true, result: {} }) };
  };
  return () => { globalThis.fetch = orig; };
}

// ctx stub that runs waitUntil promises so tests can await them.
function stubCtx() {
  const pending = [];
  return {
    ctx: { waitUntil(p) { pending.push(Promise.resolve(p)); } },
    drain: () => Promise.all(pending),
    sent: () => pending,
  };
}

function tgUpdate(text, chatId = 111, chatType = "private") {
  return {
    message: {
      chat: { id: chatId, type: chatType },
      from: { username: "tester" },
      text,
    },
  };
}

function tgRequest(token, update) {
  return new Request(`https://whalesignal-bot.example.workers.dev/tg/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(update),
  });
}

const STATS_ROW = {
  total_whales: 10, total_volume: 50_000_000,
  count_24h: 3, count_7d: 8, largest_transfer: 12_000_000,
  bullish: 4, bearish: 3, neutral: 3,
  accuracy_total: 6, accuracy_correct: 4,
};

function statsDB() {
  return stubDB([
    [(s) => s.includes("AS total_whales"), { all: async () => ({ results: [STATS_ROW] }) }],
    [(s) => s.includes("GROUP BY symbol"), { all: async () => ({ results: [] }) }],
    [(s) => s.includes("hour_bucket"), { all: async () => ({ results: [] }) }],
  ]);
}

// ─── BT1: /stats DM through fetchHandler (the old code 502'd here) ─────

test("DM /stats works: reuses GET-route helpers, plain text, real accuracy rate", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  const { ctx, drain } = stubCtx();
  const env = { BOT_TOKEN: "tok", DB: statsDB(), KV: stubKV() };
  try {
    const resp = await fetchHandler(tgRequest("tok", tgUpdate("/stats")), env, ctx);
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).handled, "stats");
    await drain();
    assert.equal(captured.length, 1, "one Telegram send");
    const body = captured[0].body;
    assert.ok(!("parse_mode" in body), "no parse_mode key (plain text, BT3)");
    assert.match(body.text, /WhaleSignal Intelligence Stats/);
    assert.match(body.text, /Signal Accuracy: 67%/); // 4/6, via accuracy.rate not rate_pct
    assert.ok(!body.text.includes("*"), "no Markdown asterisks in plain-text reply");
    assert.ok(!body.text.includes("undefined"), "no undefined fields");
  } finally { restore(); }
});

test("DM /stats with no accuracy data omits the accuracy line", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  const { ctx, drain } = stubCtx();
  const db = stubDB([
    [(s) => s.includes("AS total_whales"),
      { all: async () => ({ results: [{ ...STATS_ROW, accuracy_total: 0, accuracy_correct: 0 }] }) }],
    [(s) => s.includes("GROUP BY symbol"), { all: async () => ({ results: [] }) }],
    [(s) => s.includes("hour_bucket"), { all: async () => ({ results: [] }) }],
  ]);
  const env = { BOT_TOKEN: "tok", DB: db, KV: stubKV() };
  try {
    const resp = await fetchHandler(tgRequest("tok", tgUpdate("/stats")), env, ctx);
    assert.equal(resp.status, 200);
    await drain();
    assert.ok(!captured[0].body.text.includes("Accuracy"), "no accuracy line when unevaluated");
  } finally { restore(); }
});

// ─── BT3: parse_mode omission on tgSendMessage ─────────────────────────

test("tgSendMessage omits parse_mode by default (plain text)", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  try {
    await tgSendMessage("tok", "123", "hello *world* _x_");
    const body = captured[0].body;
    assert.ok(!("parse_mode" in body), "parse_mode key must be absent");
    assert.equal(body.text, "hello *world* _x_", "text sent verbatim");
  } finally { restore(); }
});

test("tgSendMessage includes parse_mode only when explicitly requested", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  try {
    await tgSendMessage("tok", "123", "hi", { parse_mode: "Markdown" });
    assert.equal(captured[0].body.parse_mode, "Markdown");
  } finally { restore(); }
});

// ─── BT2: queue idempotency — atomic delivered-claim ───────────────────

const QUEUE_WHALE = {
  id: 7, chain: "eth", tx_hash: "0xabc", from_address: "0xfrom",
  to_address: "0xto", amount: 100, symbol: "ETH", usd_value: 300_000,
  tx_type: "exchange_inflow", block_number: 1, detected_at: 1_700_000_000_000,
  analysis_status: "done", headline: "h", interpretation: "i",
  signal: "neutral", confidence: 0.5, related_factor: null,
};

function queueTestEnv(claimChanges) {
  // claimChanges: array of meta.changes values returned per INSERT call
  let n = 0;
  return {
    BOT_TOKEN: "tok",
    PUBLIC_CHANNEL: "@chan",
    DB: stubDB([
      [(s) => s.startsWith("INSERT OR IGNORE INTO delivered"),
        { run: async () => ({ meta: { changes: claimChanges[Math.min(n++, claimChanges.length - 1)] } }) }],
      [(s) => s.includes("FROM whales w LEFT JOIN analysis"),
        { first: async () => ({ ...QUEUE_WHALE }) }],
      [(s) => s.includes("COUNT(*) AS cnt"), { first: async () => ({ cnt: 0 }) }],
    ]),
    KV: stubKV(),
  };
}

function fakeBatch(whaleId) {
  const acked = [], retried = [];
  return {
    messages: [{
      body: { kind: "public_alert", whale_id: whaleId },
      ack: () => acked.push(1),
      retry: () => retried.push(1),
    }],
    acked, retried,
  };
}

test("queue: first delivery claims and posts, retry is skipped (no double-post)", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  try {
    // first invocation wins the claim (changes=1)
    const env1 = queueTestEnv([1]);
    const b1 = fakeBatch(7);
    await queueHandler(b1, env1);
    assert.equal(b1.acked.length, 1);
    assert.equal(captured.length, 1, "one Telegram post");
    assert.equal(captured[0].url, "https://api.telegram.org/bottok/sendMessage");
    assert.ok(!("parse_mode" in captured[0].body), "channel send has no parse_mode (BT3)");

    // redelivery loses the claim (changes=0) → skipped, still acked
    const env2 = queueTestEnv([0]);
    const b2 = fakeBatch(7);
    await queueHandler(b2, env2);
    assert.equal(b2.acked.length, 1);
    assert.equal(captured.length, 1, "no second Telegram post on retry");
  } finally { restore(); }
});

test("queue: public_alert without whale_id is acked, not retried forever", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  const env = queueTestEnv([1]);
  try {
    const batch = { messages: [{ body: { kind: "public_alert" }, ack() { this.a = 1; }, retry() { this.r = 1; } }] };
    await queueHandler(batch, env);
    assert.equal(batch.messages[0].a, 1, "acked");
    assert.equal(batch.messages[0].r, undefined, "not retried");
    assert.equal(captured.length, 0, "nothing sent");
  } finally { restore(); }
});

// ─── BT6: fireGitHubDispatch User-Agent + repo validation ──────────────

test("fireGitHubDispatch sends User-Agent header (GitHub 403s without it)", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  try {
    await fireGitHubDispatch({ GH_PAT: "ghp_x", GH_REPO: "saman-ghorayshi/whalesignal" }, { id: 1 });
    assert.equal(captured[0].headers["User-Agent"], "whalesignal-bot/1.0");
  } finally { restore(); }
});

test("fireGitHubDispatch skips malformed GH_REPO instead of 404ing silently", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  try {
    await fireGitHubDispatch({ GH_PAT: "ghp_x", GH_REPO: "not-a-repo" }, { id: 1 });
    assert.equal(captured.length, 0, "no fetch on malformed repo");
  } finally { restore(); }
});

test("isValidGhRepo validates owner/repo shape", () => {
  assert.equal(isValidGhRepo("saman-ghorayshi/whalesignal"), true);
  assert.equal(isValidGhRepo("a/b"), true);
  assert.equal(isValidGhRepo("not-a-repo"), false);
  assert.equal(isValidGhRepo("a/b/c"), false);
  assert.equal(isValidGhRepo(""), false);
  assert.equal(isValidGhRepo(null), false);
  assert.equal(isValidGhRepo("a b/c"), false);
});

// ─── S1: webhook secret_token verification ────────────────────────────

test("webhook without X-Telegram-Bot-Api-Secret-Token is rejected when WEBHOOK_SECRET set", async () => {
  const env = { BOT_TOKEN: "tok", WEBHOOK_SECRET: "shhh", DB: statsDB(), KV: stubKV() };
  const resp = await fetchHandler(tgRequest("tok", tgUpdate("/ping")), env, {});
  assert.equal(resp.status, 404);
});

test("webhook with wrong secret_token is rejected", async () => {
  const env = { BOT_TOKEN: "tok", WEBHOOK_SECRET: "shhh", DB: statsDB(), KV: stubKV() };
  const req = tgRequest("tok", tgUpdate("/ping"));
  req.headers.set("X-Telegram-Bot-Api-Secret-Token", "wrong");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 404);
});

test("webhook with correct secret_token passes through", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  const { ctx, drain } = stubCtx();
  const env = { BOT_TOKEN: "tok", WEBHOOK_SECRET: "shhh", DB: statsDB(), KV: stubKV() };
  try {
    const req = tgRequest("tok", tgUpdate("/ping"));
    req.headers.set("X-Telegram-Bot-Api-Secret-Token", "shhh");
    const resp = await fetchHandler(req, env, ctx);
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).handled, "ping");
    await drain();
    assert.equal(captured.length, 1);
  } finally { restore(); }
});

test("webhook secret check is skipped when WEBHOOK_SECRET unset (back-compat)", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  const { ctx, drain } = stubCtx();
  const env = { BOT_TOKEN: "tok", DB: statsDB(), KV: stubKV() };
  try {
    const resp = await fetchHandler(tgRequest("tok", tgUpdate("/ping")), env, ctx);
    assert.equal(resp.status, 200);
    await drain();
    assert.equal(captured.length, 1);
  } finally { restore(); }
});

// ─── BT10: webhook rate limiting ──────────────────────────────────────

test("webhook rate-limits a chat after 10 commands/min (429)", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  const { ctx, drain } = stubCtx();
  const env = { BOT_TOKEN: "tok", DB: statsDB(), KV: stubKV() };
  try {
    let okCount = 0, limited = 0;
    for (let i = 0; i < 12; i++) {
      const resp = await fetchHandler(tgRequest("tok", tgUpdate("/ping")), env, ctx);
      if (resp.status === 429) limited++;
      else { okCount++; }
    }
    assert.equal(okCount, 10);
    assert.equal(limited, 2);
    await drain();
  } finally { restore(); }
});

test("rate limit is per-chat: another chat is unaffected", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  const { ctx } = stubCtx();
  const env = { BOT_TOKEN: "tok", DB: statsDB(), KV: stubKV() };
  try {
    for (let i = 0; i < 10; i++) {
      await fetchHandler(tgRequest("tok", tgUpdate("/ping", 111)), env, ctx);
    }
    const resp = await fetchHandler(tgRequest("tok", tgUpdate("/ping", 222)), env, ctx);
    assert.equal(resp.status, 200);
  } finally { restore(); }
});

// ─── S3: /test-ai gating ──────────────────────────────────────────────

test("GET /test-ai is 404 without the key when ADMIN_TOKEN is set", async () => {
  const env = { ADMIN_TOKEN: "adm1n", DB: statsDB(), KV: stubKV() };
  const req = new Request("https://whalesignal-bot.example.workers.dev/test-ai");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 404);
});

test("GET /test-ai rejects a wrong key", async () => {
  const env = { ADMIN_TOKEN: "adm1n", DB: statsDB(), KV: stubKV() };
  const req = new Request("https://whalesignal-bot.example.workers.dev/test-ai?key=nope");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 404);
});

test("GET /test-ai passes the gate with the right key", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  const env = { ADMIN_TOKEN: "adm1n", DB: statsDB(), KV: stubKV() };
  try {
    const req = new Request("https://whalesignal-bot.example.workers.dev/test-ai?key=adm1n");
    const resp = await fetchHandler(req, env, {});
    // gate passed → proxies to the analyst URL (mocked fetch returns ok)
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).ok, true);
  } finally { restore(); }
});

test("GET /test-ai stays dark when no secret is configured (fail closed)", async () => {
  const env = { DB: statsDB(), KV: stubKV() };
  const req = new Request("https://whalesignal-bot.example.workers.dev/test-ai?key=anything");
  const resp = await fetchHandler(req, env, {});
  assert.equal(resp.status, 404);
});

// ─── BT7: /history total is a real COUNT(*) ────────────────────────────

test("GET /history total comes from COUNT(*), not the page size", async () => {
  const row = { id: 1, chain: "eth", tx_hash: "0x", from_address: "a", to_address: "b", amount: 1, symbol: "ETH", usd_value: 1, tx_type: "wallet_to_wallet", block_number: 1, detected_at: 1, interesting_score: 60, headline: null, interpretation: null, signal: null, confidence: null, related_factor: null };
  const db = stubDB([
    [(s) => s.includes("SELECT COUNT(*) AS cnt"), { first: async () => ({ cnt: 42 }) }],
    [(s) => s.includes("SELECT w.id, w.chain"), { all: async () => ({ results: [row, row] }) }],
  ]);
  const env = { DB: db, KV: stubKV() };
  const req = new Request("https://whalesignal-bot.example.workers.dev/history?limit=2");
  const resp = await fetchHandler(req, env, {});
  const body = await resp.json();
  assert.equal(body.total, 42, "total is the COUNT(*), not rows.length (2)");
  assert.equal(body.alerts.length, 2);
});

test("historyCount shares the filter WHERE clause with historyRows", async () => {
  let seenStmts = [];
  const db = stubDB([
    [(s, binds) => { seenStmts.push([s, binds]); return s.includes("SELECT COUNT(*) AS cnt"); },
      { first: async () => ({ cnt: 5 }) }],
  ]);
  const total = await historyCount({ DB: db }, { chain: "ETH", min_usd: 1000 });
  assert.equal(total, 5);
  const [stmt, binds] = seenStmts[0];
  assert.ok(stmt.includes("w.chain = ?"), "chain filter present");
  assert.ok(stmt.includes("w.usd_value >="), "min_usd filter present");
  assert.deepEqual(binds, ["eth", 1000], "binds normalized like historyRows");
});

// ─── BT8: /wallet direction is case-insensitive ────────────────────────

test("renderWalletJSON computes direction case-insensitively", () => {
  const profile = { address: "0xABCDEF1234567890", chain: "eth", label: null, type: "whale", reputation: null, tx_count: 2, total_volume: 100, first_seen: 1, last_seen: 2 };
  const txs = [
    { id: 1, chain: "eth", tx_hash: "0x1", from_address: "0xabcdef1234567890", to_address: "0x9999", amount: 1, symbol: "ETH", usd_value: 3000, tx_type: "wallet_to_wallet", detected_at: 1, interesting_score: 0, signal: null, headline: null, confidence: null },
    { id: 2, chain: "eth", tx_hash: "0x2", from_address: "0x8888", to_address: "0xABCDEF1234567890", amount: 1, symbol: "ETH", usd_value: 3000, tx_type: "wallet_to_wallet", detected_at: 2, interesting_score: 0, signal: null, headline: null, confidence: null },
  ];
  const out = renderWalletJSON(profile, txs);
  assert.equal(out.recent_txs[0].direction, "out");
  assert.equal(out.recent_txs[0].counterpart, "0x9999");
  assert.equal(out.recent_txs[1].direction, "in");
  assert.equal(out.recent_txs[1].counterpart, "0x8888");
});

// ─── BT4: channel alert never exceeds Telegram's limit ─────────────────
// Defense in depth: formatAlert caps each LLM field (sanitizeAIText) and
// postPublicAlert runs the whole message through truncateTelegram. The
// invariant the channel needs: no send is ever > 4096 chars.
test("channel alert with huge LLM output stays under the Telegram limit", async () => {
  const captured = [];
  const restore = mockFetch(captured);
  try {
    const big = { ...QUEUE_WHALE, interpretation: "z".repeat(9000), headline: "h".repeat(9000) };
    const env = {
      BOT_TOKEN: "tok",
      PUBLIC_CHANNEL: "@chan",
      DB: stubDB([
        [(s) => s.startsWith("INSERT OR IGNORE INTO delivered"), { run: async () => ({ meta: { changes: 1 } }) }],
        [(s) => s.includes("FROM whales w LEFT JOIN analysis"), { first: async () => big }],
        [(s) => s.includes("COUNT(*) AS cnt"), { first: async () => ({ cnt: 0 }) }],
      ]),
      KV: stubKV(),
    };
    const batch = fakeBatch(7);
    await queueHandler(batch, env);
    const text = captured[0].body.text;
    assert.ok(text.length < 4096, `alert under limit, got ${text.length}`);
    assert.ok(!text.includes("z".repeat(2001)), "runaway LLM text was capped at 2000 chars");
  } finally { restore(); }
});

const WHALE = {
  chain: "eth",
  tx_hash: "0xabc123def4567890abcdef",
  from_address: "0x0001aaaaaaaaaaaaaaaaaaaaaaaaaa0001",
  to_address: "0x28c6c06298d514de13c02684fa65b7c0c1f723e4",
  amount: 250,
  symbol: "WBTC",
  usd_value: 16_750_000,
  tx_type: "exchange_inflow",
  block_number: 20_000_000,
  detected_at: 1_700_000_000_000,
};

const ANALYSIS = {
  headline: "Whale moved 250 WBTC to Binance",
  interpretation: "Looks like sell prep. BTC already down 2.3% today.",
  signal: "bearish",
  confidence: 0.71,
  related_factor: "Exchange inflow during market fear",
};

const MARKET = {
  btc: { price: 67_000, change_24h: -2.3 },
  eth: { price: 3_200, change_24h: -1.8 },
  fear_greed: 28,
  fear_greed_label: "Fear",
};

test("formatAlert renders the canonical phase-1 alert block", () => {
  const out = formatAlert(WHALE, ANALYSIS, MARKET);
  // Header
  assert.match(out, /🐋 WHALE ALERT — ETH/);
  assert.match(out, /\$16\.75M → exchange \(likely sell\)/);
  // body
  assert.match(out, /250 WBTC \(\$16\.75M\)/);
  assert.match(out, /📍 eth → 0x28c6\.\.\.23e4/i);
  assert.match(out, /🧱 Block 20000000/);
  // AI section
  assert.match(out, /🧠 AI Analysis:/);
  assert.match(out, /Whale moved 250 WBTC to Binance/);
  assert.match(out, /Looks like sell prep/);
  // footer
  assert.match(out, /📊 Market: BTC \$67,000 \(-2.3%\) \| F&G 28 \(Fear\) \| ETH \$3,200/);
  assert.match(out, /🔴 BEARISH/);
  assert.match(out, /confidence 0.71/);
  assert.match(out, /📎 Exchange inflow during market fear/);
  // explorer
  assert.match(out, /etherscan\.io\/tx\/0xabc123def4567890abcdef/);
});

test("formatAlert uses mempool.space URL for BTC (blockchain.com/tx 404s)", () => {
  const btcWhale = { ...WHALE, chain: "btc", symbol: "BTC" };
  const out = formatAlert(btcWhale, ANALYSIS, MARKET);
  assert.match(out, /mempool\.space\/tx\/0xabc123def4567890abcdef/);
  assert.match(out, /🐋 WHALE ALERT — BTC/);
});

test("formatAlert sanitizes LLM text: strips control chars, caps length", () => {
  const evil = {
    ...ANALYSIS,
    headline: "Whale did a thing\x00\x01 with controls",
    interpretation: "x".repeat(5000),
  };
  const out = formatAlert(WHALE, evil, MARKET);
  assert.ok(!out.includes("\x00"), "control chars stripped");
  assert.ok(!out.includes("\x01"), "control chars stripped");
  assert.match(out, /Whale did a thing/);
  // interpretation capped at 2000 code points + ellipsis
  const interpLine = out.split("\n").find((l) => l.startsWith("xxx"));
  assert.ok(interpLine.length <= 2001 + 20, `capped, got ${interpLine.length}`);
  assert.match(interpLine, /…$/);
});

test("formatAlert points the money-flow graph at the real org", () => {
  const out = formatAlert(WHALE, ANALYSIS, MARKET);
  assert.match(out, /saman-ghorayshi\.github\.io\/whalesignal\/wallet\.html/);
  assert.ok(!out.includes("samsha.github.io"), "no stale org links");
});

test("formatAlert handles missing analysis gracefully", () => {
  const out = formatAlert(WHALE, null, MARKET);
  assert.match(out, /🧠 AI Analysis: \(pending\)/);
  assert.match(out, /⚪ NEUTRAL/);
  assert.match(out, /confidence —/);
});

test("formatAlert handles missing market fields gracefully", () => {
  const out = formatAlert(WHALE, ANALYSIS, null);
  assert.match(out, /📊 Market: BTC — \(—\) \| F&G — \| ETH —/);
});

test("formatAlert maps all four tx_types to a label", () => {
  for (const t of ["exchange_inflow", "exchange_outflow", "exchange_internal", "wallet_to_wallet", "unknown"]) {
    const out = formatAlert({ ...WHALE, tx_type: t }, ANALYSIS, MARKET);
    assert.ok(/→ exchange \(likely sell\)|← exchange \(likely withdraw\)|↔ exchange-to-exchange|↔ wallet to wallet|wallet move/.test(out), `type ${t}`);
  }
});

// ─── buildAlertJSON (R2 export contract) ──────────────────────────────

test("buildAlertJSON produces the NDJSON contract shape for trading_loop.py", () => {
  const out = buildAlertJSON({ ...WHALE, id: 42, ...ANALYSIS }, MARKET);
  assert.ok(out, "should return an object");
  // required fields the plan says the Python loop keys on
  assert.equal(out.id, 42);
  assert.equal(typeof out.whale, "string");
  assert.equal(out.chain, "ETH");
  assert.equal(typeof out.signal, "string");
  assert.equal(typeof out.usd_value, "number");
  assert.equal(typeof out.detected_at, "number");
  // market nested object
  assert.equal(typeof out.market.btc_price, "number");
  assert.equal(typeof out.market.eth_price, "number");
  assert.equal(typeof out.market.fear_greed, "number");
  // analyst fields carried for the LLM prompt
  assert.equal(typeof out.analyst_interpretation, "string");
  assert.equal(typeof out.headline, "string");
  assert.equal(out.confidence, 0.71);
});

test("buildAlertJSON returns null when required fields are missing", () => {
  assert.equal(buildAlertJSON(null, MARKET), null);
  assert.equal(buildAlertJSON({}, MARKET), null);
  assert.equal(buildAlertJSON({ from_address: "0x1" }, MARKET), null); // no chain/usd
});

test("buildAlertJSON handles missing market (nulls, not crash)", () => {
  const out = buildAlertJSON({ ...WHALE, ...ANALYSIS }, null);
  assert.ok(out);
  assert.equal(out.market.btc_price, null);
  assert.equal(out.market.eth_price, null);
  assert.equal(out.market.fear_greed, null);
});

// ─── fireGitHubDispatch (repository_dispatch to trigger GH Actions) ───

// Helper: create a mock env with GH_PAT and GH_REPO
const mockEnv = (pat = "ghp_test123", repo = "saman-ghorayshi/whalesignal") => ({
  GH_PAT: pat,
  GH_REPO: repo,
});

const mockAlert = { id: 42, whale: "0xAAA111", chain: "ETH", signal: "bullish" };

test("fireGitHubDispatch sends POST to GitHub API with correct body", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts?.method, headers: opts?.headers, body: JSON.parse(opts?.body) });
    return { ok: true, status: 204, statusText: "No Content" };
  };
  try {
    await fireGitHubDispatch(mockEnv(), mockAlert);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.github.com/repos/saman-ghorayshi/whalesignal/dispatches");
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].headers.Authorization, /Bearer ghp_test123/);
    assert.equal(calls[0].body.event_type, "new_alert");
    assert.equal(calls[0].body.client_payload.alert_id, 42);
    assert.equal(calls[0].body.client_payload.whale, "0xAAA111");
    assert.equal(calls[0].body.client_payload.chain, "ETH");
    assert.equal(calls[0].body.client_payload.signal, "bullish");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fireGitHubDispatch is a no-op when GH_PAT or GH_REPO not set", async () => {
  const origFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true }; };
  try {
    // Missing GH_PAT
    await fireGitHubDispatch({ GH_REPO: "saman-ghorayshi/whalesignal" }, mockAlert);
    assert.equal(called, false, "should not call fetch when GH_PAT is missing");

    // Missing GH_REPO
    called = false;
    await fireGitHubDispatch({ GH_PAT: "ghp_test" }, mockAlert);
    assert.equal(called, false, "should not call fetch when GH_REPO is missing");

    // Both missing
    called = false;
    await fireGitHubDispatch({}, mockAlert);
    assert.equal(called, false, "should not call fetch when both are missing");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fireGitHubDispatch handles non-ok response without throwing", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });
  try {
    // Should not throw — it's fire-and-forget
    await fireGitHubDispatch(mockEnv(), mockAlert);
    // If we get here without an exception, the test passes
    assert.ok(true, "fireGitHubDispatch handled 401 without throwing");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fireGitHubDispatch handles network error without throwing", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
  try {
    await fireGitHubDispatch(mockEnv(), mockAlert);
    assert.ok(true, "fireGitHubDispatch handled network error without throwing");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("fireGitHubDispatch handles null alertJSON fields safely", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ body: JSON.parse(opts?.body) });
    return { ok: true, status: 204 };
  };
  try {
    await fireGitHubDispatch(mockEnv(), null);
    // when alertJSON is null, all payload fields should be null
    assert.equal(calls[0].body.client_payload.alert_id, null);
    assert.equal(calls[0].body.client_payload.whale, null);
  } finally {
    globalThis.fetch = origFetch;
  }
});
