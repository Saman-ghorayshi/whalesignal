// tests/admin.test.js
// Control-plane worker: auth + pause parsing + health assembly. All pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthorized, parsePauseBody, buildHealth } from "../src/admin.js";

const req = (token) => ({ headers: new Map([["x-admin-token", token]]),
  headersGet(token2) { return this.headers.get(token2); } });
// tiny shim: our isAuthorized uses request.headers.get — emulate Headers
function fakeReq(token) {
  return { headers: { get: (k) => (k === "x-admin-token" ? token : null) } };
}

test("isAuthorized: matching token passes, wrong/missing/unconfigured fail", () => {
  assert.equal(isAuthorized(fakeReq("secret-token-1"), "secret-token-1"), true);
  assert.equal(isAuthorized(fakeReq("wrong"), "secret-token-1"), false);
  assert.equal(isAuthorized(fakeReq(""), "secret-token-1"), false);
  // no ADMIN_TOKEN configured = locked out entirely (fail closed)
  assert.equal(isAuthorized(fakeReq("anything"), undefined), false);
});

test("parsePauseBody: valid scopes and coercion; rejects garbage", () => {
  assert.deepEqual(parsePauseBody({ scope: "all", paused: true }), { scope: "all", paused: true });
  assert.deepEqual(parsePauseBody({ scope: "btc", paused: false }), { scope: "btc", paused: false });
  assert.deepEqual(parsePauseBody({ scope: "ETH", paused: "yes" }), { scope: "eth", paused: true });
  assert.equal(parsePauseBody({ scope: "sol", paused: true }), null);
  assert.equal(parsePauseBody({}), null);
  assert.equal(parsePauseBody(null), null);
});

test("buildHealth: shapes vitals with ages and pause flags", () => {
  const now = Date.now();
  const h = buildHealth({
    states: [{ chain: "eth", last_block: 1000, last_scan: now - 30_000, errors: 0 },
             { chain: "btc", last_block: 500, last_scan: now - 3600_000, errors: 2 }],
    counts: { whales: { total: 10, last_24h: 3, volume: 1_000_000 }, analysis: { done: 7, failed: 3 } },
    kvMarket: { updated_at: now - 120_000 },
    kvNews: null,
    hasGemini: false,
    paused: { global: true },
  });
  assert.equal(h.chains.eth.seconds_since_scan, 30);
  assert.equal(h.chains.btc.paused, true);
  assert.equal(h.chains.eth.errors, 0);
  assert.equal(h.caches.market_age_s, 120);
  assert.equal(h.caches.news_age_s, null);
  assert.equal(h.ai.gemini_key, false);
  assert.equal(h.whales.total, 10);
});
