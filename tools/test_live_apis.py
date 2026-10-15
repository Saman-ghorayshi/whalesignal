import os
import json
import urllib.request
import urllib.error

# Load .env
env = {}
with open(".env", "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")

gemini_key = env.get("GEMINI_KEY")
groq_key = env.get("GROQ_KEY")

print("=== 1. Testing Google Gemini Models ===")
prompt = 'Whale moved 500 BTC to Binance. Return valid JSON only: {"headline": "500 BTC deposited to Binance", "signal": "bearish"}'
gemini_candidates = [
    "gemini-flash-latest",
    "gemini-3.7-flash",
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-flash-lite-latest",
]

for model in gemini_candidates:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}"
    req = urllib.request.Request(
        url,
        data=json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    try:
        resp = urllib.request.urlopen(req, timeout=12)
        data = json.loads(resp.read().decode())
        cand = data["candidates"][0]["content"]["parts"][0]["text"].strip()
        print(f"  ✓ {model}: SUCCESS! (HTTP 200)")
        print(f"    Snippet: {cand[:120]}")
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f"  ✗ {model}: HTTP {e.code} -> {err[:150]}")
    except Exception as e:
        print(f"  ✗ {model}: Error -> {e}")

print("\n=== 2. Testing Groq Models ===")
groq_candidates = [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
]

for model in groq_candidates:
    url = "https://api.groq.com/openai/v1/chat/completions"
    payload = {
        "messages": [
            {"role": "system", "content": "You are a crypto whale analyst. Return valid JSON only."},
            {"role": "user", "content": prompt},
        ],
        "model": model,
        "temperature": 0.2,
        "max_tokens": 150,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {groq_key}",
            "User-Agent": "Mozilla/5.0",
        },
    )
    try:
        resp = urllib.request.urlopen(req, timeout=12)
        data = json.loads(resp.read().decode())
        cand = data["choices"][0]["message"]["content"].strip()
        print(f"  ✓ {model}: SUCCESS! (HTTP 200)")
        print(f"    Snippet: {cand[:120]}")
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f"  ✗ {model}: HTTP {e.code} -> {err[:150]}")
    except Exception as e:
        print(f"  ✗ {model}: Error -> {e}")
