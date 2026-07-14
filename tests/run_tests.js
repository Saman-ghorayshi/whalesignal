#!/usr/bin/env node
// tests/run_tests.js — convenience wrapper around `node --test`.
// You can also just run:  npm test   (alias of node --test tests/*.test.js)
//
// We don't bundle a third-party test runner (vitest/jest) on purpose —
// node:test ships with node 24 and is enough for the pure-function tests
// we have. Phase 3 will add wrangler's `unstable_dev` for integration tests.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(HERE)
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => join(HERE, f));

console.log(`running ${files.length} test file(s):\n  - ${files.map((f) => f.replace(HERE + "/", "")).join("\n  - ")}\n`);

const r = spawnSync("node", ["--test", ...files], {
  cwd: dirname(HERE),
  stdio: "inherit",
});
process.exit(r.status || 0);
