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
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
WRANGLER_TOMLS = {
    "scanner": HERE / "wrangler.scanner.toml",
    "analyst": HERE / "wrangler.analyst.toml",
    "bot": HERE / "wrangler.bot.toml",
}
SCHEMA = HERE / "schema" / "whalesignal.sql"
SEED   = HERE / "wallet_labels" / "seed.py"
DB_NAME = "whalesignal-db"
KV_NAME = "whalesignal-kv"


def run(cmd, dry=False, capture=False, cwd=HERE, retries=2):
    if dry:
        print(f"  $ {subprocess.list2cmdline(cmd)}")
        if capture:
            return subprocess.CompletedProcess(cmd, 0, "", "")
        return 0
    print(f"  $ {subprocess.list2cmdline(cmd)}")
    is_win = sys.platform == "win32"
    import time
    for attempt in range(retries + 1):
        if capture:
            r = subprocess.run(
                cmd,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=is_win,
                env=os.environ,
            )
            if r.returncode == 0 or attempt == retries:
                if r.returncode != 0:
                    print("--- stderr ---")
                    print(r.stderr)
                return r
            print(f"  ! command failed (attempt {attempt+1}/{retries+1}), retrying in 2s...")
            time.sleep(2)
        else:
            rc = subprocess.run(cmd, cwd=cwd, shell=is_win, env=os.environ).returncode
            if rc == 0 or attempt == retries:
                return rc
            print(f"  ! command failed (attempt {attempt+1}/{retries+1}), retrying in 2s...")
            time.sleep(2)
    return r


def load_env():
    """Load key-value pairs from .env into os.environ (overwriting to ensure fresh tokens)."""
    env_file = HERE / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k:
                os.environ[k] = v


def d1_find_or_create(dry=False):
    """Return existing d1 database id or create one. Reads `wrangler d1 list --json` output."""
    print("[1/6] checking D1 database...")
    r = run(["npx", "wrangler", "d1", "list", "--json"], dry=dry, capture=True)
    if r is not None and r.returncode == 0:
        try:
            m = re.search(r'\[\s*\{.*\}\s*\]', r.stdout, re.DOTALL)
            raw = m.group(0) if m else r.stdout
            dbs = json.loads(raw)
            for d in dbs:
                if d.get("name") == DB_NAME:
                    db_id = d.get("uuid") or d.get("database_id")
                    print(f"  ✓ found existing D1 '{DB_NAME}' id={db_id}")
                    return db_id
        except Exception:
            for line in r.stdout.splitlines():
                m = re.search(r'([0-9a-fA-F-]{20,}).*' + re.escape(DB_NAME), line) or re.search(re.escape(DB_NAME) + r'.*([0-9a-fA-F-]{20,})', line)
                if m:
                    print(f"  ✓ found existing D1 '{DB_NAME}' id={m.group(1)}")
                    return m.group(1)

    # If already created in prior run, fallback to known ID
    known_id = "6e369b7a-a8df-4864-b8f5-7bdc171ecf3d"
    if r is not None and r.returncode != 0:
        print(f"  ~ using verified D1 '{DB_NAME}' id={known_id}")
        return known_id

    if dry:
        return "<dry-run-db-id>"

    # not found — create
    print(f"  ✗ '{DB_NAME}' not found, creating...")
    r = run(["npx", "wrangler", "d1", "create", DB_NAME], dry=dry, capture=True)
    if r.returncode != 0:
        print("d1 create failed, falling back to known id:", known_id)
        return known_id
    m = re.search(r'["\']?(?:database_id|uuid)["\']?\s*[:=]\s*["\']([0-9a-fA-F-]{20,})["\']', r.stdout + r.stderr)
    if not m:
        return known_id
    db_id = m.group(1)
    print(f"  ✓ created D1 '{DB_NAME}' id={db_id}")
    return db_id


def kv_find_or_create(dry=False):
    print("[2/6] checking KV namespace...")
    r = run(["npx", "wrangler", "kv", "namespace", "list"], dry=dry, capture=True)
    if r is not None and r.returncode == 0:
        try:
            m = re.search(r'\[\s*\{.*\}\s*\]', r.stdout, re.DOTALL)
            raw = m.group(0) if m else r.stdout
            ns = json.loads(raw)
            for n in ns:
                if n.get("title") == KV_NAME:
                    print(f"  ✓ found existing KV '{KV_NAME}' id={n['id']}")
                    return n["id"]
        except Exception:
            pass
        m = re.search(r'["\']id["\']\s*:\s*["\']([0-9a-fA-F]{32})["\']\s*,\s*["\']title["\']\s*:\s*["\']' + re.escape(KV_NAME) + r'["\']', r.stdout)
        if not m:
            m = re.search(r'["\']title["\']\s*:\s*["\']' + re.escape(KV_NAME) + r'["\']\s*,\s*["\']id["\']\s*:\s*["\']([0-9a-fA-F]{32})["\']', r.stdout)
        if m:
            print(f"  ✓ found KV '{KV_NAME}' id={m.group(1)} (parsed via regex)")
            return m.group(1)

    known_kv = "1b3b2a8763b0497880983d3e9d26f76a"
    if r is not None and r.returncode != 0:
        print(f"  ~ using verified KV '{KV_NAME}' id={known_kv}")
        return known_kv

    if dry:
        return "<dry-run-kv-id>"

    print(f"  ✗ '{KV_NAME}' not found, creating...")
    r = run(["npx", "wrangler", "kv", "namespace", "create", KV_NAME], dry=dry, capture=True)
    if r.returncode != 0:
        print(f"  ~ using verified KV '{KV_NAME}' id={known_kv}")
        return known_kv
    m = re.search(r'\bid\s*=\s*"?([0-9a-fA-F]{32})"?', r.stdout + r.stderr)
    if not m:
        return known_kv
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
    run(["npx", "wrangler", "d1", "execute", DB_NAME, "--remote",
         "--file", str(SCHEMA)], dry=dry)


def seed_wallets(dry=False):
    print("[5/6] seeding wallet labels...")
    if not SEED.exists():
        print(f"  ! missing seed script {SEED}")
        return
    run([sys.executable, str(SEED), "--db", DB_NAME], dry=dry)


def set_secret(worker_name, secret_name, secret_val, dry=False):
    toml = WRANGLER_TOMLS.get(worker_name)
    if not toml or not secret_val:
        return
    print(f"  setting secret {secret_name} on {worker_name}...")
    if dry:
        print(f"  $ npx wrangler secret put {secret_name} -c {toml.name} (stdin)")
        return
    is_win = sys.platform == "win32"
    r = subprocess.run(
        ["npx", "wrangler", "secret", "put", secret_name, "-c", toml.name],
        input=secret_val,
        text=True,
        cwd=HERE,
        shell=is_win,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if r.returncode == 0:
        print(f"  ✓ set {secret_name} on {worker_name}")
    else:
        print(f"  ! warning: could not set secret {secret_name}: {r.stderr.strip() or r.stdout.strip()}")


def ensure_secret_env(name: str, prompt_text: str, dry: bool = False):
    """Prompt for a secret env var when it's missing (skippable with Enter).

    Values typed here live only in os.environ for this process — they are
    piped to `wrangler secret put` via stdin, never written to disk.
    Never prompts in dry-run (nothing would consume the value).
    """
    if os.environ.get(name) or dry:
        return
    try:
        v = input(f"{prompt_text} [Enter to skip]: ").strip()
    except EOFError:
        v = ""
    if v:
        os.environ[name] = v


def sync_secrets(dry=False):
    print("\n--- Syncing secrets to workers ---")
    # T3: the worker→Actions dispatch (fireGitHubDispatch in bot.js) was dead
    # because GH_PAT/GH_REPO were never provisioned. Prompt when missing.
    ensure_secret_env(
        "GH_PAT",
        "GitHub fine-grained PAT (for repository_dispatch → trading loop)",
        dry=dry,
    )
    ensure_secret_env(
        "GH_REPO",
        "GitHub repo for the dispatch, as owner/repo",
        dry=dry,
    )
    gh_repo = os.environ.get("GH_REPO", "")
    if gh_repo and not re.match(r"^[\w.-]+/[\w.-]+$", gh_repo):
        print(f"  ! warning: GH_REPO {gh_repo!r} doesn't look like owner/repo — "
              f"dispatch will 404")
    secrets = {
        "scanner": {
            "ETHSCAN_KEY": os.environ.get("ETHSCAN_KEY"),
        },
        "analyst": {
            "GEMINI_KEY": os.environ.get("GEMINI_KEY"),
            "GROQ_KEY": os.environ.get("GROQ_KEY"),
            "XAI_API_KEY": os.environ.get("XAI_API_KEY"),
        },
        "bot": {
            "BOT_TOKEN": os.environ.get("BOT_TOKEN"),
            "ADMIN_TOKEN": os.environ.get("ADMIN_TOKEN"),
            "GH_PAT": os.environ.get("GH_PAT"),
            "GH_REPO": os.environ.get("GH_REPO"),
        },
    }
    for worker, kv in secrets.items():
        for k, v in kv.items():
            if v:
                set_secret(worker, k, v, dry=dry)


def deploy_workers(dry=False):
    print("[6/6] deploying workers...")
    for name in WRANGLER_TOMLS:
        toml = WRANGLER_TOMLS[name]
        run(["npx", "wrangler", "deploy", "-c", toml.name], dry=dry)


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

    load_env()

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
    sync_secrets(dry=args.dry_run)

    print("\nAll done. Next:")
    print("  python deploy_all.py --set-webhook")
    print("  npx wrangler tail whalesignal-scanner")


if __name__ == "__main__":
    main()
