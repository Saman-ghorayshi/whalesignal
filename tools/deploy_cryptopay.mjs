#!/usr/bin/env node
// tools/deploy_cryptopay.mjs — deploy the fixed cryptopay worker via the
// Cloudflare API, preserving its D1 binding. Reads .env for CF_ID.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const acctRes = await fetch("https://api.cloudflare.com/client/v4/accounts", {
  headers: { Authorization: "Bearer " + env.CF_ID },
});
const acct = (await acctRes.json()).result[0].id;

const script = readFileSync("../other-projects-audit/cryptopay_fixed.js", "utf8");

const metadata = {
  main_module: "worker.js",
  bindings: [
    { type: "d1", name: "DB", id: "de90f5d2-bf53-4a42-a63b-d21d78e239c8" },
    { type: "secret_text", name: "PAY_SECRET" },
    { type: "secret_text", name: "ADMIN_SECRET" },
  ],
  compatibility_date: "2025-09-01",
};

const form = new FormData();
form.append("metadata", JSON.stringify(metadata), { type: "application/json" });
form.append("worker.js", new Blob([script], { type: "application/javascript+module" }), "worker.js");

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${acct}/workers/scripts/cryptopay`,
  { method: "PUT", headers: { Authorization: "Bearer " + env.CF_ID }, body: form }
);
const j = await res.json();
console.log(j.success ? "✅ cryptopay deployed (bindings preserved, secrets intact)" : "❌ " + JSON.stringify(j.errors || j).slice(0, 300));
