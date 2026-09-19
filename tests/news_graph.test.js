// tests/news_graph.test.js — clustering headlines into themes and detecting
// narratives: the "a bunch mean sth" layer. One headline is noise; several
// independent outlets on the same theme, same direction, short window = a
// narrative the LLM prompt, the landing page, and /news all surface.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  THEMES, themeFor, sentimentFor, magnitudeFor,
  buildNewsGraph, narrativesForPrompt, narrativeBump,
} from "../src/news_graph.js";

const H = 3_600_000;

function row(title, { when, llm_sentiment = null, llm_event = null, llm_theme = null, llm_magnitude = null, sentiment = null } = {}) {
  return { title, first_seen: when, llm_sentiment, llm_event, llm_theme, llm_magnitude, sentiment };
}

test("themeFor: LLM theme wins, then event, then lexicon fallback for unscored rows", () => {
  assert.equal(themeFor(row("x", { llm_theme: "etf" })), "etf");
  assert.equal(themeFor(row("x", { llm_event: "hack" })), "hack");
  assert.equal(themeFor(row("SEC sues exchange over staking", {})), "regulation", "lexicon fallback");
  assert.equal(themeFor(row("Whale moves 5000 BTC dormant wallet wakes", {})), "whales");
  assert.equal(themeFor(row("Totally unrelated sports result", {})), null);
  assert.ok(THEMES.length >= 9);
});

test("sentimentFor/magnitudeFor: LLM values override lexicon; magnitude clamps to 1-3", () => {
  assert.equal(sentimentFor(row("x", { llm_sentiment: -1, sentiment: 1 })), -1);
  assert.equal(sentimentFor(row("x", { sentiment: 1 })), 1);
  assert.equal(sentimentFor(row("x", {})), 0);
  assert.equal(magnitudeFor(row("x", { llm_magnitude: 3 })), 3);
  assert.equal(magnitudeFor(row("x", { llm_magnitude: 9 })), 1, "out-of-range falls back to 1");
  assert.equal(magnitudeFor(row("x", {})), 1);
});

test("buildNewsGraph: 3+ same-direction headlines on one theme in 24h become a narrative", () => {
  const now = Date.now();
  const rows = [
    row("SEC approves first spot ETF upgrade", { when: now - 1 * H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 3 }),
    row("Bitcoin ETF sees largest daily inflow", { when: now - 3 * H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 2 }),
    row("Second issuer cuts ETF fees to zero", { when: now - 6 * H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 2 }),
    // noise: other themes, older window
    row("Exchange outage resolved", { when: now - 10 * H, llm_sentiment: 0, llm_event: "exchange" }),
    row("DeFi protocol hacked last night", { when: now - 40 * H, llm_sentiment: -1, llm_event: "hack" }),
  ];
  const g = buildNewsGraph(rows, now);
  assert.equal(g.narratives.length, 1, JSON.stringify(g.narratives));
  const n = g.narratives[0];
  assert.equal(n.theme, "etf");
  assert.equal(n.direction, "bullish");
  assert.equal(n.count, 3);
  assert.equal(n.net, 7, "magnitude-weighted: 3+2+2");
  assert.ok(n.strength >= 1 && n.strength <= 3);
  // 72h theme rollup includes the hack theme too
  const hack = g.themes.find((t) => t.theme === "hack");
  assert.ok(hack && hack.count === 1 && hack.net === -1, "72h rollup keeps out-of-narrative themes");
});

test("buildNewsGraph: a single headline never becomes a narrative", () => {
  const now = Date.now();
  const g = buildNewsGraph([
    row("ETF approved", { when: now - H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 3 }),
    row("Another ETF approved", { when: now - 2 * H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 3 }),
  ], now);
  assert.equal(g.narratives.length, 0, "count < 3 → no narrative");
  assert.equal(g.themes[0].theme, "etf");
});

test("buildNewsGraph: mixed-direction clusters with net below the bar stay narratives-off", () => {
  const now = Date.now();
  const g = buildNewsGraph([
    row("ETF inflows surge", { when: now - H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 2 }),
    row("ETF outflows recorded", { when: now - 2 * H, llm_sentiment: -1, llm_event: "etf", llm_magnitude: 2 }),
    row("Third ETF story", { when: now - 3 * H, llm_sentiment: -1, llm_event: "etf", llm_magnitude: 1 }),
  ], now);
  // count 3 ✓ but net24 = 2-2-1 = -1 → |net| < 2 → no narrative
  assert.equal(g.narratives.length, 0);
});

test("buildNewsGraph: lexicon-only unscored rows still cluster (fallback path)", () => {
  const now = Date.now();
  const g = buildNewsGraph([
    row("Exchange reports record whale deposits", { when: now - 2 * H, sentiment: 1 }),
    row("Whale accumulation hits monthly high", { when: now - 4 * H, sentiment: 1 }),
    row("Dormant whale wallet reactivates with 10k BTC", { when: now - 6 * H, sentiment: 1 }),
  ], now);
  assert.equal(g.narratives.length, 1);
  assert.equal(g.narratives[0].theme, "whales");
  assert.equal(g.narratives[0].direction, "bullish");
});

test("narrativesForPrompt: compact block with the most recent headline", () => {
  const now = Date.now();
  const g = buildNewsGraph([
    row("SEC approves ETF", { when: now - H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 3 }),
    row("ETF inflows surge", { when: now - 2 * H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 2 }),
    row("Third ETF story", { when: now - 3 * H, llm_sentiment: 1, llm_event: "etf", llm_magnitude: 2 }),
  ], now);
  const p = narrativesForPrompt(g);
  assert.ok(p.startsWith("- ETF flows:"), p);
  assert.ok(p.includes("Most recent:"), p);
  // no narratives → honest noise warning
  assert.ok(narrativesForPrompt({ narratives: [] }).includes("treat them as noise"));
});

test("narrativeBump: bounded ±0.06, sign follows direction, zero without narratives", () => {
  const now = Date.now();
  const mk = (sent) => buildNewsGraph([
    row("T1", { when: now - H, llm_sentiment: sent, llm_event: "etf", llm_magnitude: 3 }),
    row("T2", { when: now - 2 * H, llm_sentiment: sent, llm_event: "etf", llm_magnitude: 3 }),
    row("T3", { when: now - 3 * H, llm_sentiment: sent, llm_event: "etf", llm_magnitude: 3 }),
    row("T4", { when: now - 4 * H, llm_sentiment: sent, llm_event: "etf", llm_magnitude: 3 }),
  ], now);
  assert.equal(narrativeBump(mk(1)), 0.06);
  assert.equal(narrativeBump(mk(-1)), -0.06);
  assert.equal(narrativeBump({ narratives: [] }), 0);
});
