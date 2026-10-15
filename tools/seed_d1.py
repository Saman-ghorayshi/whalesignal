# tools/seed_d1.py
# Seeds wallet labels directly to D1 via Cloudflare REST API

import json
import urllib.request
import sys
import os

account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "6d98bd85c8bdd1275a14db45e152518b")
database_id = os.environ.get("CLOUDFLARE_DATABASE_ID", "6e369b7a-a8df-4864-b8f5-7bdc171ecf3d")
cf_token = os.environ.get("CLOUDFLARE_API_TOKEN", "")

with open("wallet_labels/exchanges.json", "r", encoding="utf-8") as f:
    data = json.load(f)

statements = []
for chain in ("btc", "eth"):
    for row in data.get(chain, []):
        addr = row["address"].replace("'", "''")
        label = row["label"].replace("'", "''")
        typ = row.get("type", "exchange")
        statements.append(f"INSERT OR IGNORE INTO wallets (address, chain, label, type) VALUES ('{addr}', '{chain}', '{label}', '{typ}');")
        if chain == "eth" and addr != addr.lower():
            statements.append(f"INSERT OR IGNORE INTO wallets (address, chain, label, type) VALUES ('{addr.lower()}', '{chain}', '{label}', '{typ}');")

sql = "\n".join(statements)
url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"

req = urllib.request.Request(
    url,
    data=json.dumps({"sql": sql}).encode(),
    headers={
        "Authorization": f"Bearer {cf_token}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    },
    method="POST",
)

try:
    with urllib.request.urlopen(req, timeout=15) as resp:
        res = json.loads(resp.read().decode())
        print("Success:", res.get("success"), "| Statements executed:", len(res.get("result", [])))
except Exception as e:
    print("Error seeding D1:", e)
    sys.exit(1)
