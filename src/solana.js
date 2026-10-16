/**
 * solana.js — Solana wallet-watch scanner.
 *
 * Solana does ~400ms blocks: global scanning is infeasible on Workers.
 * Instead we watch a curated list of high-signal wallets (exchanges,
 * treasuries, whales) via getSignaturesForAddress, parsing new
 * transactions for large SOL and SPL-USDC movements.
 *
 * Efficiency: wallets rotate across ticks (15 per 2-min tick), each
 * wallet costs 1 RPC call when quiet, +1 per new transaction.
 */

const SOL_RPC = "https://api.mainnet-beta.solana.com";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_DECIMALS = 9;

const MIN_SOL_USD = 250_000;
const MIN_USDC_USD = 500_000;

async function rpcCall(method, params, timeoutMs = 10000) {
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(SOL_RPC, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "WhaleSignal/1.0 (solana monitor)",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`Solana RPC HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`Solana RPC: ${j.error.message}`);
    return j.result;
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Get recent signatures for a wallet. Pure RPC wrapper.
 * Returns array of { signature, slot, blockTime } (newest first).
 */
export async function getSignatures(address, limit = 10, before = null) {
  const params = [address, { limit, commitment: "confirmed" }];
  if (before) params[1].before = before;
  return rpcCall("getSignaturesForAddress", params) || [];
}

/**
 * Get a full transaction. Returns null on failure (caller skips).
 */
export async function getTransaction(sig) {
  try {
    return await rpcCall("getTransaction", [
      sig,
      { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ], 15000);
  } catch (e) {
    console.warn(`[solana] getTransaction ${sig.slice(0, 8)} failed:`, e.message);
    return null;
  }
}

/**
 * Parse a Solana transaction into whale candidates.
 * Detects native SOL moves (balance deltas) and USDC SPL moves.
 * Pure. Returns array of { symbol, amount, usd_value, from, to }.
 */
export function parseSolanaTx(tx, solPrice) {
  if (!tx?.meta || tx.meta.err) return [];
  const out = [];
  const meta = tx.meta;
  const keys = tx.transaction?.message?.accountKeys || [];

  const addrOf = (i) => {
    const k = keys[i];
    // Solana addresses are base58 case-SENSITIVE — never lowercase
    return typeof k === "string" ? k : k?.pubkey || "";
  };

  // Native SOL: balance deltas
  const pre = meta.preBalances || [];
  const post = meta.postBalances || [];
  for (let i = 0; i < keys.length && i < pre.length; i++) {
    const delta = (post[i] ?? pre[i]) - pre[i];
    const solAmount = Math.abs(delta) / 10 ** SOL_DECIMALS;
    const usd = solAmount * (solPrice || 0);
    if (delta < 0 && usd >= MIN_SOL_USD) {
      let toIdx = -1, maxIn = 0;
      for (let j = 0; j < keys.length && j < pre.length; j++) {
        const d = (post[j] ?? pre[j]) - pre[j];
        if (d > maxIn) { maxIn = d; toIdx = j; }
      }
      out.push({
        symbol: "SOL",
        amount: solAmount,
        usd_value: usd,
        from_address: addrOf(i),
        to_address: toIdx >= 0 ? addrOf(toIdx) : "",
      });
      break; // one SOL candidate per tx (largest mover)
    }
  }

  // SPL USDC: token balance deltas
  const preT = meta.preTokenBalances || [];
  const postT = meta.postTokenBalances || [];
  const byAcct = new Map();
  for (const b of preT) {
    if (b.mint === USDC_MINT) {
      byAcct.set(b.accountIndex, { pre: Number(b.uiTokenAmount?.uiAmount || 0), owner: b.owner });
    }
  }
  for (const b of postT) {
    if (b.mint === USDC_MINT) {
      const e = byAcct.get(b.accountIndex) || { pre: 0 };
      e.post = Number(b.uiTokenAmount?.uiAmount || 0);
      byAcct.set(b.accountIndex, e);
    }
  }
  for (const [, e] of byAcct) {
    const delta = (e.post ?? e.pre) - e.pre;
    if (delta < 0 && Math.abs(delta) >= MIN_USDC_USD) {
      let toOwner = "";
      for (const [, o] of byAcct) {
        const d = (o.post ?? o.pre) - o.pre;
        if (d > 0 && Math.abs(d + delta) < 1) { toOwner = o.owner || ""; break; }
      }
      out.push({
        symbol: "USDC",
        amount: Math.abs(delta),
        usd_value: Math.abs(delta),
        from_address: e.owner || "",
        to_address: toOwner,
      });
    }
  }

  return out.filter((c) => c.from_address && c.to_address && c.from_address !== c.to_address);
}

/**
 * Main Solana scan: rotate through active wallets, check for new
 * signatures, parse new transactions. Respects subrequest budget.
 */
export async function scanSolana(env, market, budget = null) {
  const take = (n = 1) => {
    if (!budget) return true;
    if (budget.remaining < n) return false;
    budget.remaining -= n;
    return true;
  };

  let wallets;
  try {
    const rows = await env.DB.prepare(
      `SELECT address, label, type, last_sig FROM sol_wallets
       WHERE active = 1 ORDER BY last_check ASC NULLS FIRST LIMIT 15`
    ).all();
    wallets = rows.results || [];
  } catch (e) {
    console.warn("[solana] wallet list failed:", e.message);
    return { chain: "solana", processed: 0, newWhales: 0, error: e.message };
  }

  if (!wallets.length) {
    return { chain: "solana", processed: 0, newWhales: 0, note: "no wallets" };
  }

  const solPrice = market?.sol?.price || 150;
  let newWhales = 0;
  let processed = 0;

  for (const w of wallets) {
    if (!take(1)) break;
    let sigs;
    try {
      sigs = await getSignatures(w.address, 10);
    } catch (e) {
      console.warn(`[solana] sigs failed for ${w.address.slice(0, 8)}:`, e.message);
      continue;
    }
    processed++;

    const fresh = [];
    for (const s of sigs) {
      if (s.signature === w.last_sig) break;
      fresh.push(s);
    }
    const newest = sigs[0]?.signature || w.last_sig;
    try {
      await env.DB.prepare(
        "UPDATE sol_wallets SET last_sig = ?, last_check = ? WHERE address = ?"
      ).bind(newest, Date.now(), w.address).run();
    } catch {}

    for (const s of fresh.reverse()) {
      if (!take(1)) break;
      const tx = await getTransaction(s.signature);
      if (!tx) continue;
      const candidates = parseSolanaTx(tx, solPrice);
      for (const c of candidates) {
        try {
          const inserted = await insertSolanaWhale(env, {
            ...c,
            tx_hash: s.signature,
            block_time: (s.blockTime || 0) * 1000,
            wallet_label: w.label,
            wallet_type: w.type,
          }, market);
          if (inserted) newWhales++;
        } catch (e) {
          console.warn("[solana] insert failed:", e.message);
        }
      }
    }
  }

  return { chain: "solana", processed, newWhales };
}

async function insertSolanaWhale(env, c, market) {
  const { computeInterestingness } = await import("./scanner.js");
  const { classifyTx } = await import("./worker-utils.js");
  const { tx_type } = classifyTx(
    c.wallet_type === "exchange" ? "exchange" : null,
    null
  );
  const score = computeInterestingness(
    { ...c, chain: "solana", tx_type },
    c.wallet_type === "exchange" ? { type: "exchange", label: c.wallet_label } : null,
    []
  );
  const shouldAnalyze = score >= 50;
  try {
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO whales
       (chain, tx_hash, from_address, to_address, amount, symbol, usd_value,
        tx_type, block_time, detected_at, analysis_status, interesting_score,
        price_at_detect, is_self_transfer)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).bind(
      "solana", c.tx_hash, c.from_address, c.to_address, c.amount, c.symbol,
      c.usd_value, tx_type, c.block_time, Date.now(),
      shouldAnalyze ? "queued" : "skipped", score,
      c.symbol === "SOL" ? (market?.sol?.price ?? null) : 1
    ).run();
    return (r.meta?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}
