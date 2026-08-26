#!/usr/bin/env python3
"""
deploy_all.py — one-shot deploy of all 3 workers + create infra + seed schema.

Sequence (idempotent):

  1. create D1 (if missing)  -> inject database_id into the 3 wrangler.*.toml
  2. create KV namespace (if missing) -> inject id into the 3 wrangler.*.toml
  3. create Queue A (whalesignal-q) and Queue B (whalesignal-bot-q) —
     Wrangler creates queues IMPLICITLY as consumers/producers get deployed,
     so we don't manage them explicitly.
  4. apply schema/whalesignal.sql to remote D1
  5. seed wallet labels (calls wallet_labels/seed.py)
  6. deploy each worker with `npx wrangler deploy -c wrangler.<name>.toml`

Flags:
  --set-webhook    after deploy, print the exact curl to wire Telegram to the
                   bot's webhook URL. (uses BOT_TOKEN from env, since it's
                   a wrangler secret — never on disk.)
  --skip-schema    skip the D1 schema apply (for fast redeploys)
  --skip-seed      skip wallet seed reload (if labels haven't changed)
  --dry-run        print every command without running
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def npx():
    """Resolve npx cross-platform — on Windows subprocess needs npx.cmd."""
    return shutil.which("npx") or "npx"


# wrangler output and our own checkmarks are UTF-8; Windows consoles default
# to cp1252 and explode on both.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
WRANGLER_TOMLS = {
    "scanner": HERE / "wrangler.scanner.toml",
    "analyst": HERE / "wrangler.analyst.toml",
    "bot": HERE / "wrangler.bot.toml",
}
SCHEMA = HERE / "schema" / "whalesignal.sql"
SEED   = HERE / "wallet_labels" / "seed.py"
DB_NAME = "whalesignal-db"
KV_NAME = "whalesignal-kv"


def run(cmd, dry=False, capture=False, cwd=HERE):
    if dry:
        print(f"  $ {subprocess.list2cmdline(cmd)}")
        return 0
    print(f"  $ {subprocess.list2cmdline(cmd)}")
    if capture:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            print("--- stderr ---")
            print(r.stderr)
        return r
    r = subprocess.run(cmd, cwd=cwd)
    return r.returncode


def d1_find_or_create(dry=False):
    """Return existing d1 database id or create one. Reads `wrangler d1 list` output."""
    print("[1/6] checking D1 database...")
    r = run([npx(), "wrangler", "d1", "list"], dry=dry, capture=True)
    if r is None or r.returncode != 0:
        if dry:
            return "<dry-run-db-id>"
        print("could not list D1; check `wrangler login`.")
        sys.exit(1)
    out = r.stdout
    # wrangler 4 prints a table: uuid │ name │ created_at │ ...
    # (older versions used ascii pipes and name-first ordering)
    for line in out.splitlines():
        m = re.search(
            r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
            r"\s*[|│]\s*" + re.escape(DB_NAME) + r"\b",
            line, re.IGNORECASE)
        if m:
            print(f"  ✓ found existing D1 '{DB_NAME}' id={m.group(1)}")
            return m.group(1)
    # not found — create
    print(f"  ✗ '{DB_NAME}' not found, creating...")
    r = run([npx(), "wrangler", "d1", "create", DB_NAME], dry=dry, capture=True)
    if dry:
        return "<dry-run-db-id>"
    if r.returncode != 0:
        print("d1 create failed:", r.stderr)
        sys.exit(1)
    # parse database_id from output — wrangler 4 prints JSON
    # ("database_id": "..."), older versions printed TOML (database_id = "...")
    m = re.search(r'database_id"?\s*[:=]\s*"?([0-9a-fA-F-]{20,})', r.stdout + r.stderr)
    if not m:
        print("could not parse database_id from wrangler output:")
        print(r.stdout, r.stderr)
        sys.exit(1)
    db_id = m.group(1)
    print(f"  ✓ created D1 '{DB_NAME}' id={db_id}")
    return db_id


def kv_find_or_create(dry=False):
    print("[2/6] checking KV namespace...")
    r = run([npx(), "wrangler", "kv", "namespace", "list"], dry=dry, capture=True)
    if r is None:
        return "<dry-run-kv-id>"
    if r.returncode != 0:
        if dry:
            return "<dry-run-kv-id>"
        print("kv list failed:", r.stderr)
        sys.exit(1)
    # JSON array of {id, title}
    try:
        ns = json.loads(r.stdout)
        for n in ns:
            if n.get("title") == KV_NAME:
                print(f"  ✓ found existing KV '{KV_NAME}' id={n['id']}")
                return n["id"]
    except json.JSONDecodeError:
        # Older wrangler printed a table — try a regex fallback
        m = re.search(r"\b([0-9a-fA-F]{32})\b.*" + re.escape(KV_NAME), r.stdout, re.DOTALL)
        if m:
            print(f"  ✓ found KV '{KV_NAME}' id={m.group(1)} (parsed from table)")
            return m.group(1)
    print(f"  ✗ '{KV_NAME}' not found, creating...")
    r = run([npx(), "wrangler", "kv", "namespace", "create", KV_NAME], dry=dry, capture=True)
    if dry:
        return "<dry-run-kv-id>"
    if r.returncode != 0:
        print("kv create failed:", r.stderr)
        sys.exit(1)
    # same dual-format parse as D1: JSON in wrangler 4, TOML before
    m = re.search(r'"?id"?\s*[:=]\s*"?([0-9a-fA-F]{32})', r.stdout + r.stderr)
    if not m:
        print("could not parse kv id from wrangler output:")
        print(r.stdout, r.stderr)
        sys.exit(1)
    return m.group(1)


def inject_into_tomls(db_id, kv_id, dry=False):
    """Rewrite database_id and kv id lines in each wrangler.*.toml."""
    print(f"[3/6] injecting bindings into wrangler.toml files (dry={dry})...")
    for name, path in WRANGLER_TOMLS.items():
        if not path.exists():
            print(f"  ! missing {path}")
            continue
        text = path.read_text(encoding="utf-8")
        text = re.sub(r'database_id\s*=\s*"[^"]*"', f'database_id = "{db_id}"', text, count=1)
        # KV id line is `id = "..."`. The two `database_id`/`id` regexes can both match
        # the string `id = "..."` (database_id includes "id"), so we match the id line
        # with the preceding newline + optional indentation to anchor it tight.
        text = re.sub(r'(\n\s*)id\s*=\s*"[^"]*"', r'\1id = "' + kv_id + '"', text, count=1)
        if not dry:
            path.write_text(text, encoding="utf-8")
            print(f"  ✓ updated {path.name}")
        else:
            print(f"  ~ would update {path.name}")


def apply_schema(dry=False):
    print("[4/6] applying D1 schema (remote)...")
    if not SCHEMA.exists():
        print(f"  ! missing schema {SCHEMA}")
        return
    run([npx(), "wrangler", "d1", "execute", DB_NAME, "--remote",
         "--file", str(SCHEMA)], dry=dry)


def seed_wallets(dry=False):
    print("[5/6] seeding wallet labels...")
    if not SEED.exists():
        print(f"  ! missing seed script {SEED}")
        return
    run(["python", str(SEED)], dry=dry)


def deploy_workers(dry=False):
    print("[6/6] deploying workers...")
    for name in WRANGLER_TOMLS:
        toml = WRANGLER_TOMLS[name]
        run([npx(), "wrangler", "deploy", "-c", toml.name], dry=dry)


def set_webhook_step():
    print("\n--- Setting Telegram webhook ---")
    token = os.environ.get("BOT_TOKEN")
    if not token:
        print("export BOT_TOKEN=<your_bot_token> first; secrets never touch disk.")
        print("Then re-run:  python deploy_all.py --set-webhook")
        sys.exit(1)
    # We don't know the workers.dev URL programmatically since wrangler doesn't
    # print it in a stable form. Ask the user to paste the URL from `wrangler deploy`
    # output. (Phase 1 pragmatic; Phase 5 we hit the CF API for exact URLs.)
    print("Paste the bot worker URL (output from `npx wrangler deploy -c wrangler.bot.toml`).")
    print("It looks like:  https://whalesignal-bot.<account-subdomain>.workers.dev")
    base = input("base URL: ").strip().rstrip("/")
    if not base:
        print("aborted — no URL provided")
        return
    path = f"/tg/{token}"
    url = base + path
    import urllib.request, urllib.error
    tg = f"https://api.telegram.org/bot{token}/setWebhook"
    print(f"calling Telegram setWebhook for {base}/tg/<token>")
    try:
        req = urllib.request.Request(
            tg,
            data=json.dumps({"url": url}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=10)
        body = json.loads(resp.read())
        if body.get("ok"):
            print(f"✓ webhook set: {body.get('description', 'ok')}")
        else:
            print(f"✗ telegram rejected: {body}")
    except Exception as e:
        print(f"✗ error: {e}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-schema", action="store_true")
    ap.add_argument("--skip-seed", action="store_true")
    ap.add_argument("--set-webhook", action="store_true",
                    help="wire telegram webhook to the bot worker URL")
    args = ap.parse_args()

    if args.dry_run:
        print("--- DRY RUN --- no commands actually run.\n")

    if args.set_webhook:
        set_webhook_step()
        return

    db_id = d1_find_or_create(dry=args.dry_run)
    kv_id = kv_find_or_create(dry=args.dry_run)
    inject_into_tomls(db_id, kv_id, dry=args.dry_run)

    if not args.skip_schema:
        apply_schema(dry=args.dry_run)
    if not args.skip_seed:
        seed_wallets(dry=args.dry_run)
    deploy_workers(dry=args.dry_run)

    print("\nAll done. Next:")
    print("  export BOT_TOKEN=<your_token>     # never written to disk")
    print("  python deploy_all.py --set-webhook")
    print("  npx wrangler tail whalesignal-scanner")


if __name__ == "__main__":
    main()
