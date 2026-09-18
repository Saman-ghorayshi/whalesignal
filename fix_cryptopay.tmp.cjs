const fs = require("fs");
let c = fs.readFileSync("../other-projects-audit/cryptopay.js", "utf8");
let fail = (m) => { console.error(m); process.exit(1); };

// 1. remove const fallbacks — secrets now come from bindings (fail closed)
c = c.replace(
  /const PAY_SECRET_CONST = "[^"]+";/,
  '// PAY_SECRET + ADMIN_SECRET come from wrangler secrets (rotated Sep 18 — old consts were leaked)'
);
c = c.replace(
  /const ADMIN_SECRET_CONST = "[^"]+";/,
  ""
);
c = c.replace(
  /function paySecret\(env\)   \{ return \(env && env\.PAY_SECRET\)   \|\| PAY_SECRET_CONST; \}/,
  'function paySecret(env)   { if (!env?.PAY_SECRET) throw new Error("PAY_SECRET not configured"); return env.PAY_SECRET; }'
);
c = c.replace(
  /function adminSecret\(env\) \{ return \(env && env\.ADMIN_SECRET\) \|\| ADMIN_SECRET_CONST; \}/,
  'function adminSecret(env) { if (!env?.ADMIN_SECRET) throw new Error("ADMIN_SECRET not configured"); return env.ADMIN_SECRET; }'
);
console.log("1. const fallbacks removed");

// 2. add whalesignal_premium to PRICING
const pricingAnchor = "const PRICING = {";
if (!c.includes(pricingAnchor)) fail("PRICING anchor missing");
c = c.replace(
  pricingAnchor,
  pricingAnchor + '\n  "whalesignal_premium": { price_usd: 10, gems: 0, days: 30, prices: {} },'
);
console.log("2. PRICING entry added");

// 3. timing-safe secret compare
const csOld = `function checkSecret(request, env) {
  return request.headers.get("X-Pay-Secret") === paySecret(env);
}`;
const csNew = `function checkSecret(request, env) {
  const given = request.headers.get("X-Pay-Secret") || "";
  const expected = paySecret(env);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}`;
if (!c.includes(csOld)) fail("checkSecret anchor missing");
c = c.replace(csOld, csNew);

const caOld = `function checkAdminSecret(request, env) {
  const a = request.headers.get("X-Admin-Secret");
  const admin = adminSecret(env);
  if (admin) return a === admin;`;
const caNew = `function checkAdminSecret(request, env) {
  const a = request.headers.get("X-Admin-Secret") || "";
  const admin = adminSecret(env);
  if (a.length !== admin.length) return false;
  let diff = 0;
  for (let i = 0; i < admin.length; i++) diff |= a.charCodeAt(i) ^ admin.charCodeAt(i);
  if (diff === 0) return true;`;
if (!c.includes(caOld)) fail("checkAdminSecret anchor missing");
c = c.replace(caOld, caNew);
console.log("3. timing-safe compare");

fs.writeFileSync("../other-projects-audit/cryptopay_fixed.js", c);
console.log("ALL OK");
