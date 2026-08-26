// src/admin-panel.js — the control panel HTML, kept out of admin.js's way.
// No framework, no build step: one template string, fetches /api/* with the
// token from a prompt() on first load (kept in sessionStorage).

export function renderPanel() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>WhaleSignal · control</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0b0f14; color:#c9d4e0; font:14px/1.5 ui-monospace,Consolas,monospace;
         margin:0 auto; max-width:880px; padding:24px; }
  h1 { font-size:18px; color:#7fd3ff; margin:0 0 4px; }
  .sub { color:#5a6b7d; font-size:12px; margin-bottom:20px; }
  section { border:1px solid #1d2836; border-radius:8px; padding:14px 16px; margin-bottom:16px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#8fa3b8; margin:0 0 10px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td { padding:3px 6px; border-bottom:1px solid #131c27; }
  .ok { color:#59d38e; } .warn { color:#ffb454; } .bad { color:#ff6b6b; }
  .muted { color:#5a6b7d; }
  button { background:#13202e; color:#c9d4e0; border:1px solid #2a3b4f; border-radius:6px;
           padding:6px 12px; cursor:pointer; font:inherit; margin-right:8px; }
  button:hover { border-color:#7fd3ff; }
  button.danger:hover { border-color:#ff6b6b; }
  #alerts { font-size:12.5px; }
  .score { color:#7fd3ff; }
</style>
</head>
<body>
<h1>🐳 WhaleSignal — control plane</h1>
<div class="sub">private · token-gated · <span id="clock"></span></div>

<section>
  <h2>Scanner health</h2>
  <table id="health"><tr><td class="muted">loading…</td></tr></table>
</section>

<section>
  <h2>Kill switches</h2>
  <button id="pauseAll" class="danger">⏸ pause everything</button>
  <button id="resumeAll">▶ resume all</button>
  <span id="pauseState" class="muted"></span>
</section>

<section>
  <h2>Recent events</h2>
  <div id="alerts" class="muted">loading…</div>
</section>

<script>
const TOKEN = sessionStorage.adminToken || (() => {
  const t = prompt("admin token:");
  sessionStorage.adminToken = t || "";
  return t || "";
})();
const H = { "x-admin-token": TOKEN };

function fmtAge(s) {
  if (s == null) return "never";
  if (s < 90) return s + "s ago";
  if (s < 5400) return Math.round(s/60) + "m ago";
  return Math.round(s/3600) + "h ago";
}
function usd(n) {
  if (!n) return "$0";
  if (n >= 1e9) return "$" + (n/1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n/1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n/1e3).toFixed(0) + "K";
  return "$" + n;
}

async function refresh() {
  document.getElementById("clock").textContent = new Date().toISOString().slice(11,19) + "Z";
  let h;
  try { h = await (await fetch("/api/health", { headers: H })).json(); }
  catch { document.getElementById("health").innerHTML = "<tr><td class='bad'>api unreachable</td></tr>"; return; }
  const rows = [];
  for (const [chain, c] of Object.entries(h.chains || {})) {
    const fresh = c.seconds_since_scan != null && c.seconds_since_scan < 180;
    rows.push("<tr><td><b>" + chain.toUpperCase() + "</b></td>" +
      "<td>block " + (c.last_block ?? "?") + "</td>" +
      "<td class='" + (fresh ? "ok" : "warn") + "'>scanned " + fmtAge(c.seconds_since_scan) + "</td>" +
      "<td>errors: " + c.errors + "</td>" +
      "<td>" + (c.paused ? "<span class='bad'>PAUSED</span>" : "<span class='ok'>running</span>") + "</td></tr>");
  }
  rows.push("<tr><td colspan=5 class='muted'>whales: " + (h.whales?.total ?? 0) +
    " total · " + (h.whales?.last_24h ?? 0) + " in 24h · " + usd(h.whales?.volume) +
    " | gemini key: " + (h.ai?.gemini_key ? "<span class='ok'>set</span>" : "<span class='bad'>missing</span>") +
    " | market cache " + fmtAge(h.caches?.market_age_s) +
    " | news " + fmtAge(h.caches?.news_age_s)) + "</td></tr>";
  document.getElementById("health").innerHTML = rows.join("");

  const p = h.paused || {};
  document.getElementById("pauseState").textContent =
    p.global ? "· EVERYTHING PAUSED" : ((p.btc ? "btc paused " : "") + (p.eth ? "eth paused" : ""));

  try {
    const a = await (await fetch("/api/alerts?limit=12", { headers: H })).json();
    document.getElementById("alerts").innerHTML = (a.alerts || []).map(x =>
      "<div>" + new Date(x.detected_at).toISOString().slice(5,16).replace("T"," ") +
      " <span class='score'>" + x.interesting_score + "</span> " +
      usd(x.usd_value) + " " + x.symbol + " " + x.tx_type +
      " → " + (x.headline || "<span class='muted'>" + x.analysis_status + "</span>") + "</div>"
    ).join("") || "(none yet)";
  } catch {}
}

document.getElementById("pauseAll").onclick = async () => {
  await fetch("/api/pause", { method:"POST", headers:{...H,"content-type":"application/json"},
    body: JSON.stringify({ scope:"all", paused:true }) });
  refresh();
};
document.getElementById("resumeAll").onclick = async () => {
  await fetch("/api/pause", { method:"POST", headers:{...H,"content-type":"application/json"},
    body: JSON.stringify({ scope:"all", paused:false }) });
  refresh();
};

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}
