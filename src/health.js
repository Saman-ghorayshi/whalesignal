/**
 * health.js — Worker #8: the watchdog.
 *
 * Every 5 minutes: pings all 7 workers, checks D1 + KV, verifies the
 * scanner is actually producing (not just responding). 3 consecutive
 * failures → Telegram alert. Recovery → "all clear" message.
 *
 * A real team has paging. This is ours.
 */

import { isAuthorizedAdmin } from "./worker-utils.js";

const WORKERS = [
  ["scanner", "https://whalesignal-scanner.mv3sxp7x4fkv-6d9.workers.dev/"],
  ["analyst", "https://whalesignal-analyst.mv3sxp7x4fkv-6d9.workers.dev/"],
  ["bot", "https://whalesignal-bot.mv3sxp7x4fkv-6d9.workers.dev/history?limit=1"],
  ["news", "https://whalesignal-news.mv3sxp7x4fkv-6d9.workers.dev/"],
  ["price", "https://whalesignal-price.mv3sxp7x4fkv-6d9.workers.dev/"],
  ["sentiment", "https://whalesignal-sentiment.mv3sxp7x4fkv-6d9.workers.dev/"],
  ["eval", "https://whalesignal-eval.mv3sxp7x4fkv-6d9.workers.dev/"],
];

const FAIL_THRESHOLD = 3; // consecutive failures before alerting

async function checkUrl(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    // bot returns 404 on / but 200 on /history — accept 2xx/4xx, not 5xx/timeout
    return { ok: r.status < 500, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally {
    clearTimeout(tid);
  }
}

async function sendTelegram(env, text) {
  if (!env.BOT_TOKEN || !env.PUBLIC_CHANNEL) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.PUBLIC_CHANNEL, text }),
    });
  } catch (e) {
    console.warn("[health] telegram alert failed:", e.message);
  }
}

export async function runHealthTick(env) {
  const now = Date.now();
  const results = {};
  let allOk = true;

  // 1. Worker pings
  for (const [name, url] of WORKERS) {
    const r = await checkUrl(url);
    results[name] = r;
    if (!r.ok) allOk = false;
  }

  // 2. D1 check (cheap query)
  try {
    await env.DB.prepare("SELECT 1 as x").first();
    results.d1 = { ok: true };
  } catch (e) {
    results.d1 = { ok: false, error: e.message.slice(0, 100) };
    allOk = false;
  }

  // 3. KV check
  try {
    await env.KV.put("health_ping", String(now), { expirationTtl: 600 });
    const v = await env.KV.get("health_ping");
    results.kv = { ok: v === String(now) };
    if (v !== String(now)) allOk = false;
  } catch (e) {
    results.kv = { ok: false, error: e.message.slice(0, 100) };
    allOk = false;
  }

  // 4. Scanner liveness: is it producing? (last_scan within 10 min)
  try {
    const row = await env.DB.prepare(
      "SELECT MAX(last_scan) as ls FROM scanner_state"
    ).first();
    const ageMin = row?.ls ? (now - row.ls) / 60000 : 999;
    results.scanner_live = { ok: ageMin < 10, age_min: Math.round(ageMin) };
    if (ageMin >= 10) allOk = false;
  } catch {
    results.scanner_live = { ok: false, error: "d1 unavailable" };
  }

  // Failure tracking in KV
  let fails = 0;
  try {
    fails = parseInt((await env.KV.get("health_fails")) || "0", 10) || 0;
  } catch {}
  const wasDown = fails >= FAIL_THRESHOLD;

  if (allOk) {
    if (wasDown) {
      await sendTelegram(env, "✅ WhaleSignal: all systems recovered.");
    }
    try { await env.KV.put("health_fails", "0", { expirationTtl: 3600 }); } catch {}
    try {
      await env.KV.put("health_status", JSON.stringify({ ok: true, at: now, results }), { expirationTtl: 600 });
    } catch {}
  } else {
    fails++;
    try { await env.KV.put("health_fails", String(fails), { expirationTtl: 3600 }); } catch {}
    const bad = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
    console.warn(`[health] failures (${fails}/${FAIL_THRESHOLD}): ${bad.join(", ")}`);
    if (fails === FAIL_THRESHOLD) {
      await sendTelegram(env,
        `🚨 WhaleSignal health alert: ${bad.join(", ")} failing (${fails}x). Check workers.`);
    }
    try {
      await env.KV.put("health_status", JSON.stringify({ ok: false, at: now, results }), { expirationTtl: 600 });
    } catch {}
  }

  console.log(`[health] tick: ${allOk ? "OK" : "DEGRADED"} (${Object.values(results).filter(r => r.ok).length}/${Object.keys(results).length})`);
  return { ok: allOk, results };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHealthTick(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/trigger") {
      if (!isAuthorizedAdmin(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
      }
      const r = await runHealthTick(env);
      return new Response(JSON.stringify(r), { headers: { "Content-Type": "application/json" } });
    }
    if (url.pathname === "/status") {
      const raw = await env.KV.get("health_status");
      return new Response(raw || JSON.stringify({ ok: false, error: "no check yet" }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    return new Response(JSON.stringify({ ok: true, worker: "whalesignal-health" }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
