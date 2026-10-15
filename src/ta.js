/**
 * ta.js — Technical analysis for the whale-intelligence layer.
 *
 * Pure indicator math (testable, no I/O) plus klines fetching with a
 * Binance → CoinGecko fallback chain. The analyst calls getMarketSnapshot()
 * once per whale and feeds the result into the prompt as structured TA facts;
 * the bot uses the returned price series for the QuickChart alert image.
 *
 * No credentials needed: both price sources are public.
 */

// ─── pure indicators ──────────────────────────────────────────────────

export function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function macd(closes, fast = 12, slow = 26, signalP = 9) {
  if (!closes || closes.length < slow + signalP) return null;
  const macdLine = [];
  for (let i = slow; i <= closes.length; i++) {
    const f = ema(closes.slice(0, i), fast);
    const s = ema(closes.slice(0, i), slow);
    if (f == null || s == null) return null;
    macdLine.push(f - s);
  }
  const signal = ema(macdLine, signalP);
  if (signal == null) return null;
  const hist = macdLine[macdLine.length - 1] - signal;
  return { macd: macdLine[macdLine.length - 1], signal, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const price = closes[closes.length - 1];
  const upper = mid + mult * sd, lower = mid - mult * sd;
  // %B: where the price sits inside the bands (0 = lower, 1 = upper)
  const pctB = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  return { mid, upper, lower, pctB };
}

/** z-score of the latest volume vs its N-period mean. */
export function volumeZ(volumes, period = 20) {
  if (!volumes || volumes.length < period) return null;
  const slice = volumes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  if (mean === 0) return null;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  if (sd === 0) return 0;
  return (volumes[volumes.length - 1] - mean) / sd;
}

/** Recent swing high/low over the last N candles (naive support/resistance). */
export function swingLevels(klines, lookback = 48) {
  const slice = klines.slice(-lookback);
  if (!slice.length) return { support: null, resistance: null };
  return {
    support: Math.min(...slice.map((k) => k.l)),
    resistance: Math.max(...slice.map((k) => k.h)),
  };
}

// ─── pro indicators ─────────────────────────────────────────────────

/** Average True Range — the market's per-candle volatility in price units. */
export function atr(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].h, l = klines[i].l, pc = klines[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

/** VWAP over the klines (typical price × volume). Institutional benchmark. */
export function vwap(klines) {
  if (!klines || !klines.length) return null;
  let pv = 0, v = 0;
  for (const k of klines) {
    const tp = (k.h + k.l + k.c) / 3;
    pv += tp * (k.v || 0); v += (k.v || 0);
  }
  return v > 0 ? pv / v : null;
}

/** Stochastic RSI — where RSI sits in its recent range (0-100). */
export function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14) {
  if (!closes || closes.length < rsiPeriod + stochPeriod) return null;
  const rsis = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    const r = rsi(closes.slice(0, i), rsiPeriod);
    if (r == null) return null;
    rsis.push(r);
  }
  const slice = rsis.slice(-stochPeriod);
  const lo = Math.min(...slice), hi = Math.max(...slice);
  if (hi === lo) return 50;
  return ((rsis[rsis.length - 1] - lo) / (hi - lo)) * 100;
}

/** On-Balance Volume — cumulative volume flow. Rising = accumulation. */
export function obv(klines) {
  if (!klines || klines.length < 2) return null;
  let o = 0;
  for (let i = 1; i < klines.length; i++) {
    if (klines[i].c > klines[i - 1].c) o += klines[i].v || 0;
    else if (klines[i].c < klines[i - 1].c) o -= klines[i].v || 0;
  }
  return o;
}

/** OBV trend over the last N values: rising/falling/flat. */
export function obvTrend(klines, lookback = 10) {
  if (!klines || klines.length < lookback + 1) return null;
  const vals = [];
  for (let i = klines.length - lookback; i <= klines.length; i++) {
    vals.push(obv(klines.slice(0, i)));
  }
  const first = vals[0], last = vals[vals.length - 1];
  if (last == null || first == null) return null;
  const chg = first !== 0 ? (last - first) / Math.abs(first) : 0;
  return chg > 0.05 ? "rising" : chg < -0.05 ? "falling" : "flat";
}

/**
 * Fibonacci retracement levels from the swing high/low.
 * Returns {levels: [{ratio, price}], position} — where price sits.
 */
export function fibonacci(klines, lookback = 72) {
  const { support: lo, resistance: hi } = swingLevels(klines, lookback);
  if (lo == null || hi == null || hi <= lo) return null;
  const price = klines[klines.length - 1].c;
  const range = hi - lo;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const levels = ratios.map((r) => ({ ratio: r, price: hi - range * r }));
  // nearest level below/above price
  let position = "mid";
  if (price > hi) position = "above_swing_high";
  else if (price < lo) position = "below_swing_low";
  else {
    const below = levels.filter((l) => l.price <= price).pop();
    position = below ? `above_fib_${below.ratio}` : "mid";
  }
  return { levels: levels.map((l) => ({ ratio: l.ratio, price: +l.price.toFixed(2) })), position };
}

/**
 * ADX — trend STRENGTH (0-100), direction-agnostic.
 * <20 = ranging, 20-40 = trending, >40 = strong trend.
 */
export function adx(klines, period = 14) {
  if (!klines || klines.length < period * 2 + 1) return null;
  const dmPlus = [], dmMinus = [], trs = [];
  for (let i = 1; i < klines.length; i++) {
    const up = klines[i].h - klines[i - 1].h;
    const dn = klines[i - 1].l - klines[i].l;
    dmPlus.push(up > dn && up > 0 ? up : 0);
    dmMinus.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(
      klines[i].h - klines[i].l,
      Math.abs(klines[i].h - klines[i - 1].c),
      Math.abs(klines[i].l - klines[i - 1].c)
    ));
  }
  const smooth = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) s = s - s / period + arr[i], out.push(s);
    return out;
  };
  const sPlus = smooth(dmPlus), sMinus = smooth(dmMinus), sTr = smooth(trs);
  const dx = [];
  for (let i = 0; i < sPlus.length; i++) {
    if (!sTr[i]) continue;
    const pdi = (sPlus[i] / sTr[i]) * 100, mdi = (sMinus[i] / sTr[i]) * 100;
    dx.push(sTr[i] === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi || 1)) * 100);
  }
  if (!dx.length) return null;
  const recent = dx.slice(-period);
  const adxVal = recent.reduce((a, b) => a + b, 0) / recent.length;
  // direction from the last PDI/MDI
  const i = sPlus.length - 1;
  const dir = sPlus[i] >= sMinus[i] ? "up" : "down";
  return { value: +adxVal.toFixed(1), direction: dir };
}

/** Volatility regime: current ATR vs its own history percentile. */
export function volatilityRegime(klines, period = 14) {
  if (!klines || klines.length < 60) return null;
  const atrs = [];
  for (let i = period + 1; i <= klines.length; i++) {
    atrs.push(atr(klines.slice(0, i), period));
  }
  const cur = atrs[atrs.length - 1];
  const sorted = [...atrs].sort((a, b) => a - b);
  const pct = sorted.findIndex((v) => v >= cur) / sorted.length;
  return {
    atr: +cur.toFixed(2),
    percentile: +pct.toFixed(2),
    regime: pct > 0.8 ? "high_vol" : pct < 0.2 ? "low_vol" : "normal_vol",
  };
}

// ─── klines fetching ────────────────────────────────────────────────

/**
 * Coinbase Exchange candles → normalized {t,o,h,l,c,v}. No key needed.
 * Reliable from datacenter IPs (unlike Binance, which often 403s workers).
 * Returns newest-first; we reverse to oldest-first.
 */
async function fetchCoinbase(symbol, interval = "1h", limit = 100) {
  const pair = `${symbol.toUpperCase()}-USD`;
  const granularity = interval === "1h" ? 3600 : 3600;
  const url = `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${granularity}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "user-agent": "WhaleSignal/1.0" },
    });
    if (!res.ok) throw new Error(`Coinbase HTTP ${res.status}`);
    const j = await res.json(); // [time, low, high, open, close, volume], newest first
    if (!Array.isArray(j) || !j.length) throw new Error("Coinbase: empty candles");
    return j.slice(0, limit).reverse().map((k) => ({
      t: k[0] * 1000, o: +k[3], h: +k[2], l: +k[1], c: +k[4], v: +k[5],
    }));
  } finally {
    clearTimeout(tid);
  }
}

/** Kraken OHLC → normalized. Free, no key. Second fallback. */
async function fetchKraken(symbol, interval = "1h", limit = 100) {
  const pairs = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };
  const pair = pairs[symbol.toUpperCase()];
  if (!pair) throw new Error(`Kraken: no pair for ${symbol}`);
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=60`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const j = await res.json();
    const key = Object.keys(j.result || {}).find((k) => k !== "last");
    const rows = (j.result && j.result[key]) || [];
    if (!rows.length) throw new Error("Kraken: empty OHLC");
    // [time, open, high, low, close, vwap, volume, count]
    return rows.slice(-limit).map((k) => ({
      t: k[0] * 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6],
    }));
  } finally {
    clearTimeout(tid);
  }
}

/** CoinGecko market_chart/range fallback → hourly-ish candles. */
async function fetchCoinGecko(symbol, limit = 100) {
  const ids = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };
  const id = ids[symbol.toUpperCase()];
  if (!id) throw new Error(`CoinGecko: no id for ${symbol}`);
  const hours = Math.min(limit, 168);
  const to = Math.floor(Date.now() / 1000);
  const from = to - hours * 3600;
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const j = await res.json();
    const prices = j.prices || [], vols = j.total_volumes || [];
    // bucket into hourly candles
    const buckets = new Map();
    for (const [t, p] of prices) {
      const h = Math.floor(t / 3600000) * 3600000;
      if (!buckets.has(h)) buckets.set(h, { t: h, o: p, h: p, l: p, c: p, v: 0 });
      const b = buckets.get(h);
      b.h = Math.max(b.h, p); b.l = Math.min(b.l, p); b.c = p;
    }
    for (const [t, v] of vols) {
      const h = Math.floor(t / 3600000) * 3600000;
      const b = buckets.get(h);
      if (b) b.v = v; // daily volume; coarse but usable for z-score
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t).slice(-limit);
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Fetch klines: Coinbase → Kraken → CoinGecko.
 * (Binance was dropped: it 403s datacenter/worker IPs too often.)
 * fetchFn is injectable for tests: (symbol, interval, limit) => klines[].
 */
export async function fetchKlines(symbol, { interval = "1h", limit = 100, fetchFn = null } = {}) {
  if (fetchFn) return fetchFn(symbol, interval, limit);
  const attempts = [
    ["Coinbase", () => fetchCoinbase(symbol, interval, limit)],
    ["Kraken", () => fetchKraken(symbol, interval, limit)],
    ["CoinGecko", () => fetchCoinGecko(symbol, limit)],
  ];
  let lastErr = null;
  for (const [name, fn] of attempts) {
    try {
      const klines = await fn();
      if (klines && klines.length >= 30) return klines;
      lastErr = new Error(`${name}: too few klines`);
    } catch (e) {
      console.warn(`[ta] ${name} failed for ${symbol}:`, e.message);
      lastErr = e;
    }
  }
  throw lastErr || new Error("all kline sources failed");
}

// ─── snapshot ───────────────────────────────────────────────────────

/**
 * One-call market snapshot for the analyst prompt + bot chart.
 * Returns null when no price data is available (analyst must tolerate it).
 */
export async function getMarketSnapshot(symbol, opts = {}) {
  const sym = (symbol || "BTC").toUpperCase();
  // Only majors have reliable klines; stables map to BTC as market context.
  const tradable = ["BTC", "ETH", "SOL"].includes(sym) ? sym : "BTC";
  let klines;
  try {
    klines = await fetchKlines(tradable, opts);
  } catch (e) {
    console.warn(`[ta] no klines for ${tradable}:`, e.message);
    return null;
  }
  if (!klines || klines.length < 30) return null;

  const closes = klines.map((k) => k.c);
  const volumes = klines.map((k) => k.v);
  const price = closes[closes.length - 1];
  const prevDay = closes.length > 24 ? closes[closes.length - 25] : closes[0];
  const change24h = ((price - prevDay) / prevDay) * 100;

  const rsi14 = rsi(closes);
  const m = macd(closes);
  const bb = bollinger(closes);
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const vZ = volumeZ(volumes);
  const { support, resistance } = swingLevels(klines);

  // rough 24h spot volume in USD (Binance volumes are in base asset)
  let volume24hUsd = null;
  if (klines.length >= 24) {
    const v24 = klines.slice(-24).reduce((a, k) => a + (k.v || 0), 0);
    if (v24 > 0) volume24hUsd = v24 * price;
  }

  const trend = s20 != null && s50 != null
    ? (s20 > s50 * 1.005 ? "uptrend" : s20 < s50 * 0.995 ? "downtrend" : "sideways")
    : "unknown";
  const bbPos = bb == null ? "unknown"
    : bb.pctB > 0.8 ? "near_upper" : bb.pctB < 0.2 ? "near_lower" : "mid_band";

  return {
    symbol: tradable,
    price,
    change24h: +change24h.toFixed(2),
    rsi14: rsi14 == null ? null : +rsi14.toFixed(1),
    macdHist: m == null ? null : +m.hist.toFixed(2),
    macdBullish: m == null ? null : m.hist > 0,
    bbPos,
    bbPctB: bb == null ? null : +bb.pctB.toFixed(2),
    sma20: s20, sma50: s50,
    trend,
    volumeZ: vZ == null ? null : +vZ.toFixed(2),
    volumeSpike: vZ != null && vZ > 2,
    support, resistance,
    volume24hUsd,
    // compact series for the chart (time + close only, to keep URLs small)
    series: klines.slice(-48).map((k) => ({ t: k.t, c: +k.c.toFixed(2) })),
    fetchedAt: Date.now(),
  };
}

/**
 * Build a QuickChart URL: 48h price line (dark theme) with a gold marker
 * where the whale moved. No API key needed; Telegram accepts the URL as photo.
 * whale = { t: epoch ms, usd: number } | null.
 */
export function buildChartUrl(symbol, series, whale) {
  if (!series || series.length < 2) return null;
  const sym = (symbol || "BTC").toUpperCase();
  const closes = series.map((p) => p.c);
  const up = closes[closes.length - 1] >= closes[0];
  const lineColor = up ? "#26a69a" : "#ef5350";
  // sparse time labels (every 6th point)
  const labels = series.map((p, i) =>
    i % 6 === 0
      ? new Date(p.t).toISOString().slice(5, 16).replace("T", " ")
      : ""
  );
  const datasets = [{
    label: `${sym}/USDT`,
    data: closes,
    borderColor: lineColor,
    backgroundColor: lineColor + "22",
    fill: true,
    pointRadius: 0,
    borderWidth: 2,
  }];
  let title = `${sym}/USDT — 48h`;
  if (whale && whale.t) {
    // nearest series index to the whale's timestamp
    let best = 0, bestD = Infinity;
    series.forEach((p, i) => {
      const d = Math.abs(p.t - whale.t);
      if (d < bestD) { bestD = d; best = i; }
    });
    const pts = new Array(series.length).fill(null);
    pts[best] = closes[best];
    datasets.push({
      label: "whale",
      data: pts,
      showLine: false,
      pointRadius: 9,
      pointBackgroundColor: "#f0b90b",
      pointBorderColor: "#ffffff",
      pointBorderWidth: 2,
    });
    const usd = whale.usd ? ` — whale $${(whale.usd / 1e6).toFixed(1)}M` : " — whale";
    title += usd;
  }
  const config = {
    type: "line",
    data: { labels, datasets },
    options: {
      title: { display: true, text: title, fontColor: "#e6e6e6", fontSize: 16 },
      legend: { labels: { fontColor: "#9aa0a6" } },
      scales: {
        xAxes: [{ ticks: { fontColor: "#9aa0a6", maxTicksLimit: 8 }, gridLines: { color: "#1f242b" } }],
        yAxes: [{ ticks: { fontColor: "#9aa0a6" }, gridLines: { color: "#1f242b" } }],
      },
    },
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&w=800&h=400&bkg=%230d1117&f=png`;
}

/** One-line human summary for the prompt / Telegram caption. */
export function summarizeTA(snap) {
  if (!snap) return "TA unavailable";
  const bits = [
    `$${snap.price.toLocaleString("en-US", { maximumFractionDigits: 0 })} (${snap.change24h >= 0 ? "+" : ""}${snap.change24h}%/24h)`,
    `RSI ${snap.rsi14 ?? "n/a"}`,
    snap.regime ? `regime: ${snap.regime.replace(/_/g, " ")}` : snap.trend,
    snap.bbPos === "near_upper" || snap.bbPos === "above_upper" ? "hugging upper Bollinger" : snap.bbPos === "near_lower" || snap.bbPos === "below_lower" ? "hugging lower Bollinger" : "mid Bollinger",
  ];
  if (snap.volumeSpike) bits.push("volume spike");
  if (snap.macdBullish === true) bits.push("MACD bullish");
  else if (snap.macdBullish === false) bits.push("MACD bearish");
  if (snap.adx) bits.push(`ADX ${snap.adx.value} ${snap.adx.direction}`);
  if (snap.aboveVwap === true) bits.push("above VWAP");
  else if (snap.aboveVwap === false) bits.push("below VWAP");
  if (snap.stochRsi != null) bits.push(`StochRSI ${snap.stochRsi}`);
  if (snap.obvTrend && snap.obvTrend !== "flat") bits.push(`OBV ${snap.obvTrend}`);
  if (snap.fib) bits.push(`fib ${snap.fib.position.replace(/_/g, " ")}`);
  if (snap.volRegime && snap.volRegime.regime !== "normal_vol") bits.push(snap.volRegime.regime.replace(/_/g, " "));
  return bits.join(" · ");
}
