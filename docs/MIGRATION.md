# Migrating WhaleSignal to its own Cloudflare account

## Why

The D1 free-tier read cap (5M rows/day) is **account-wide** — shared by every
database on the account. This account also hosts `battery-relay-db`,
`battery-relay-staging-db`, `cryptopay` and `mechanicfriend`, whose traffic
shares (and can exhaust) the budget WhaleSignal depends on. Moving WhaleSignal
to its own free account fully isolates the budget. Cost: $0. Time: ~30–45 min.

## Steps

1. **Create the new Cloudflare account** (free) and generate an API token with
   Workers/D1/KV edit permissions. Keep the old token until the end.

2. **Create the infra on the new account:**
   ```
   CLOUDFLARE_API_TOKEN=<new-token> npx wrangler d1 create whalesignal-db
   CLOUDFLARE_API_TOKEN=<new-token> npx wrangler kv namespace create whalesignal-kv
   ```
   Copy the new `database_id` and KV `id` into all four `wrangler.*.toml` files
   (replace the old ids — they appear once per file under `[[d1_databases]]`
   and `[[kv_namespaces]]`).

3. **Export the data from the old account** (old token, old account id):
   ```
   CLOUDFLARE_API_TOKEN=<old-token> CLOUDFLARE_ACCOUNT_ID=<old-id> \
     npx wrangler d1 export whalesignal-db --remote --output dump.sql
   ```
   Re-apply the current schema first on the new account (step 4 handles it:
   the dump contains CREATE + data; run the schema file BEFORE the dump with
   the new guarded `apply_schema`, or simply skip the schema file and let the
   dump create everything — the dump includes the full schema).

4. **Import the data (new account):**
   ```
   CLOUDFLARE_API_TOKEN=<new-token> npx wrangler d1 execute whalesignal-db \
     --remote --file dump.sql -y
   ```
   (Large dump: split if wrangler times out — `split -l 5000 dump.sql`.)

5. **Re-create secrets on the new account** (they do NOT migrate):
   ```
   for k in BOT_TOKEN PUBLIC_CHANNEL GEMINI_KEY GROQ_KEY NEWS_TOKEN ETHSCAN_KEY \
            CG_KEYS ADMIN_TOKEN ADMIN_CHAT_ID; do
     npx wrangler secret put "$k" -c wrangler.scanner.toml   # repeat per worker
   done
   ```
   (Only the bindings each worker needs: scanner needs ETHSCAN_KEY; analyst
   GEMINI_KEY/GROQ_KEY; bot BOT_TOKEN/PUBLIC_CHANNEL/ADMIN_CHAT_ID; admin
   ADMIN_TOKEN.)

6. **Deploy all four workers with the new token:**
   ```
   for w in scanner analyst bot admin; do
     npx wrangler deploy -c wrangler.$w.toml
   done
   ```

7. **Re-wire the Telegram webhook** (new workers.dev subdomain!):
   ```
   curl "https://api.telegram.org/bot<TG_TOKEN>/setWebhook" \
     -d url="https://whalesignal-bot.<NEW-SUBDOMAIN>.workers.dev/tg/<TG_TOKEN>"
   ```

8. **Update the GitHub Pages dashboards** — the API base URL in
   `docs/*.html` (`API='https://whalesignal-bot...workers.dev'`) and
   `.github/workflows/monitor.yml`. Push, and the Pages deploy refreshes.

9. **Point the trading loop** at the new `/alerts/export` URL
   (`R2_ALERTS_URL` secret in trade.yml).

10. **Smoke test** (docs/AUDIT.md checklist): /health, /stats, /netflow,
    /market, /news, /feed.xml, /latest, a DM /ping, and confirm the next
    18:00 UTC scoreboard lands.

## Old-account cleanup

After a verified week: pause the workers on the old account (or delete them)
so nothing double-posts to the channel. Keep the old D1 as a cold backup.
