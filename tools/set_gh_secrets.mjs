#!/usr/bin/env node
// tools/set_gh_secrets.mjs — set GitHub Actions repo secrets via the API.
// Uses libsodium sealed-box encryption (the only format GitHub accepts).
import sodium from "libsodium-wrappers";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const REPO = "Saman-ghorayshi/whalesignal";
const GH = env.github_TOKEN || env.GH_TOKEN;
if (!GH) { console.error("no github_TOKEN in .env"); process.exit(1); }

await sodium.ready;

// get the repo's public key
const pkRes = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/public-key`, {
  headers: { Authorization: `Bearer ${GH}` },
});
const pk = await pkRes.json();
if (!pk.key) { console.error("failed to get public key:", JSON.stringify(pk)); process.exit(1); }
console.log("public key:", pk.key_id);

function sealSecret(value, publicKeyB64) {
  const pk = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    pk
  );
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

async function setSecret(name, value) {
  const encrypted = sealSecret(value, pk.key);
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/secrets/${name}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GH}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ encrypted_value: encrypted, key_id: pk.key_id }),
  });
  console.log(`  ${name}: HTTP ${res.status}`);
  return res.status === 201 || res.status === 204;
}

const results = [];
results.push(await setSecret("WS_BOT_TOKEN", env.TG_TOKEN));
results.push(await setSecret("ADMIN_CHAT_ID", "7472552536"));

const ok = results.filter(Boolean).length;
console.log(`${ok}/${results.length} secrets set`);
process.exit(ok === results.length ? 0 : 1);
