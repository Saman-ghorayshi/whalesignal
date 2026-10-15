// tests/news.test.js — RSS parsing, symbol tagging, sentiment, importance.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseRss, tagSymbols, scoreSentiment, scoreImportance } from "../src/news.js";

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test</title>
<item><title><![CDATA[Bitcoin ETF inflows hit record]]></title>
<link>https://ex.com/a</link>
<pubDate>Thu, 15 Oct 2026 10:00:00 GMT</pubDate>
<description>Big day for <b>BTC</b>.</description></item>
<item><title>Weather today</title><link>https://ex.com/b</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title>
<entry><title>Ethereum upgrade approved</title>
<link href="https://ex.com/c"/>
<published>2026-10-15T09:00:00Z</published>
<summary>ETH news</summary></entry>
</feed>`;

test("parseRss: RSS2 items with CDATA", () => {
  const items = parseRss(RSS2);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Bitcoin ETF inflows hit record", "CDATA unwrapped");
  assert.equal(items[0].url, "https://ex.com/a");
  assert.ok(items[0].publishedAt > 0, "pubDate parsed");
  assert.equal(items[1].publishedAt, null, "missing date → null");
});

test("parseRss: Atom entries", () => {
  const items = parseRss(ATOM);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Ethereum upgrade approved");
  assert.equal(items[0].url, "https://ex.com/c");
});

test("parseRss: garbage → empty", () => {
  assert.deepEqual(parseRss(""), []);
  assert.deepEqual(parseRss(null), []);
  assert.deepEqual(parseRss("<html>not rss</html>"), []);
});

test("tagSymbols: keyword mapping", () => {
  assert.deepEqual(tagSymbols("Bitcoin rallies as BTC ETF grows"), ["BTC"]);
  assert.deepEqual(tagSymbols("Ethereum and vitalik discuss ether"), ["ETH"]);
  const both = tagSymbols("BTC and ETH move together");
  assert.ok(both.includes("BTC") && both.includes("ETH"));
  assert.deepEqual(tagSymbols("sunny weather, no crypto"), []);
  // word boundaries: "eth" inside "tether" must not tag ETH
  assert.deepEqual(tagSymbols("Tether mints 1B USDT"), ["USDT"]);
});

test("scoreSentiment: direction", () => {
  assert.ok(scoreSentiment("Bitcoin ETF approval drives massive inflows, record high") > 0.2, "bullish");
  assert.ok(scoreSentiment("Exchange hack triggers panic, lawsuits and mass liquidations") < -0.2, "bearish");
  const neutral = scoreSentiment("Bitcoin trades sideways on Tuesday");
  assert.ok(Math.abs(neutral) < 0.2, "neutral-ish");
  const s = scoreSentiment("rally ".repeat(50));
  assert.ok(s <= 1 && s >= -1, "clamped");
});

test("scoreImportance: recency decay + breaking bonus", () => {
  const now = Date.now();
  const fresh = scoreImportance({ sourceWeight: 1, publishedAt: now - 3600000, symbols: ["BTC"], title: "Bitcoin ETF approved" });
  const stale = scoreImportance({ sourceWeight: 1, publishedAt: now - 48 * 3600000, symbols: ["BTC"], title: "Bitcoin ETF approved" });
  assert.ok(fresh > stale, "fresher ranks higher");
  const breaking = scoreImportance({ sourceWeight: 0.6, publishedAt: now, symbols: [], title: "Exchange hack confirmed" });
  const plain = scoreImportance({ sourceWeight: 0.6, publishedAt: now, symbols: [], title: "Market update" });
  assert.ok(breaking > plain, "breaking keywords boost importance");
  assert.ok(fresh <= 1, "capped at 1");
});
