#!/usr/bin/env node
// eval/run_news_eval.mjs — the eval discipline from jev/06-agent-handoff §3/§9:
// run the scorer over the labeled dataset, measure agreement per dimension
// + confidence-bucket calibration, and print the threshold recommendation.
// Runs OFFLINE against the deterministic mock by default; run with a real
// key (TYPESAFE_API_KEY=... node eval/run_news_eval.mjs) to evaluate the
// live model before shipping thresholds.
import { readFileSync } from "node:fs";
import { jevScoreHeadlines } from "../src/jev_news.js";

// offline runner: no env KV — inject a stub with config defaults
const envStub = {
  KV: {
    async get() { return null; },
    async put() {},
  },
  ...(process.env.TYPESAFE_API_KEY ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY } : { JEV_MOCK: "1" }),
};

const rows = readFileSync("eval/news_labeled.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

// batch all rows through one scorer call (the real scorer caps at 20/call —
// this dataset is 30, so score in two batches exactly like production)
const results = [];
for (let i = 0; i < rows.length; i += 20) {
  const batch = rows.slice(i, i + 20);
  const r = await jevScoreHeadlines(envStub, batch.map((r2) => r2.title));
  if (r.unavailable) { console.log("Jev unavailable — set TYPESAFE_API_KEY or JEV_MOCK=1"); process.exit(1); }
  for (const it of r.items) results.push({ idx: i + it.i, ...it });
  if (r.injection > 0.5) console.log(`⚠ injection Noul fired on batch @${i}: ${r.injection}`);
}

// agreement per dimension
let sOK = 0, sTot = 0, eOK = 0, eTot = 0, mClose = 0, mTot = 0;
const byConf = [[0, 0.7, []], [0.7, 0.8, []], [0.8, 1.01, []]];
for (let i = 0; i < rows.length; i++) {
  const got = results.find((r) => r.idx === i);
  if (!got) continue;
  const exp = rows[i].expected;
  sTot++; if (got.s === exp.s) sOK++;
  eTot++; if (got.e === exp.e) eOK++;
  mTot++; if (Math.abs(got.m - exp.m) <= 1) mClose++;
  for (const b of byConf) if (got.confidence >= b[0] && got.confidence < b[1]) b[2].push(got.s === exp.s ? 1 : 0);
}

console.log(`dataset: ${rows.length} labeled headlines, ${results.length} scored above threshold`);
console.log(`sentiment agreement: ${sOK}/${sTot} = ${Math.round((sOK / sTot) * 100)}%`);
console.log(`event agreement:     ${eOK}/${eTot} = ${Math.round((eOK / eTot) * 100)}%`);
console.log(`magnitude within ±1: ${mClose}/${mTot} = ${Math.round((mClose / mTot) * 100)}%`);
console.log("confidence calibration (bucket: agreement):");
for (const [lo, hi, bucket] of byConf) {
  if (bucket.length) {
    const acc = bucket.reduce((s, x) => s + x, 0) / bucket.length;
    console.log(`  ${lo.toFixed(1)}–${hi.toFixed(1)}: n=${bucket.length} acc=${Math.round(acc * 100)}%`);
  }
}
console.log("\nthreshold recommendation: keep min_sentiment_confidence where the");
console.log("accuracy-by-bucket table is monotonic; route lower buckets to the lexicon.");
