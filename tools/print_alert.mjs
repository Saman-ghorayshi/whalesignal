// Standalone demo: print the actual alert message the bot would send to your
// channel, after running the full pipeline. This is what your subscribers see.
// Run:  node tools/print_alert.mjs
import { fullPipeline } from "../tests/e2e.fixture.js";
const r = await fullPipeline();
console.log("=== Telegram messages that would be sent to @whalesignal_test ===\n");
for (const t of r.telegramSent) {
  console.log("─ chat_id:", t.chat_id);
  console.log(t.text);
  console.log("─".repeat(60));
  console.log();
}
