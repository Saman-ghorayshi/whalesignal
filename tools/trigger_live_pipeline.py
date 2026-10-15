import json
import urllib.request
import os

account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "6d98bd85c8bdd1275a14db45e152518b")
queue_id = os.environ.get("CLOUDFLARE_QUEUE_ID", "167cd5e35e5543d3a1e9638b5bc53152")
cf_token = os.environ.get("CLOUDFLARE_API_TOKEN", "")

url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/queues/{queue_id}/messages"
payload = {
    "body": {"kind": "diagnose_ai"}
}

req = urllib.request.Request(
    url,
    data=json.dumps(payload).encode(),
    headers={
        "Authorization": f"Bearer {cf_token}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
    },
    method="POST",
)

try:
    resp = urllib.request.urlopen(req, timeout=15)
    data = json.loads(resp.read().decode())
    print("Success sending message to Queue:", json.dumps(data, indent=2))
except urllib.error.HTTPError as e:
    print(f"HTTPError {e.code}: {e.read().decode()}")
except Exception as e:
    print(f"Error: {e}")
