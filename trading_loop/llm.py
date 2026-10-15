"""trading_loop/llm.py — LLM wrapper (9Router + Gemini direct).

Two backends:
  1. 9Router (localhost:20128, OpenAI-compatible). Default for local dev.
     Send stream=False or it defaults to SSE and breaks JSON parsing.
  2. Gemini direct (generativelanguage.googleapis.com). For GH Actions
     where 9router on localhost is unreachable. Active when gemini_key is set.

Model defaults:
  - Trade decisions: nvidia/deepseek-ai/deepseek-v4-flash (9router) or
    gemini-2.5-flash (gemini direct). Skip flash-lite — it's too dumb.
  - Weekly review: nvidia/deepseek-ai/deepseek-v4-pro (9router) or
    gemini-2.5-flash (gemini direct).

Retry: if the first call fails (503, 429, timeout), sleep 2s and retry once.
If the retry also fails, raise — the caller decides whether to skip the trade.
No infinite retry loops.

No openai pip package (not installed). Raw httpx to the endpoints.
"""

import json
import time
import httpx


# ─── model defaults ─────────────────────────────────────────────────

MODEL_TRADE_9ROUTER = "nvidia/deepseek-ai/deepseek-v4-flash"
MODEL_REVIEW_9ROUTER = "nvidia/z-ai/glm-5.2"  # deepseek-v4-pro times out on 9Router; glm-5.2 is fast + quality enough for 1 call/week
MODEL_TRADE_GEMINI = "gemini-flash-latest"
MODEL_REVIEW_GEMINI = "gemini-flash-latest"

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"


# ─── public API ──────────────────────────────────────────────────────

def call_llm(prompt: str,
             base_url: str = "http://localhost:20128/v1/chat/completions",
             model: str = None,
             gemini_key: str = None,
             timeout: float = 90.0,  # deepseek-v4-flash takes ~20-40s on real prompts
             max_retries: int = 1) -> dict:
    """Call LLM, extract JSON from the response. Returns parsed dict.

    If gemini_key is set, calls Gemini directly (bypasses base_url).
    Otherwise calls the OpenAI-compatible endpoint at base_url (9Router).

    Args:
        prompt:    The user prompt text.
        base_url:  OpenAI-compatible chat completions URL (9router).
        model:     Model name. If None, picks a sensible default per backend.
        gemini_key: Google AI Studio API key. When set, switches to Gemini direct.
        timeout:   HTTP timeout per request (seconds).
        max_retries: How many times to retry on failure (default 1 = 2 attempts).

    Raises:
        RuntimeError if all attempts fail or response isn't parseable JSON.
    """
    if gemini_key:
        return _call_gemini_direct(prompt, gemini_key, model or MODEL_TRADE_GEMINI,
                                   timeout, max_retries)
    return _call_9router(prompt, base_url, model or MODEL_TRADE_9ROUTER,
                         timeout, max_retries)


def extract_json(text: str) -> dict:
    """Extract first JSON object from LLM text (may be fenced in ```json)."""
    s = text.strip()
    # strip code fences
    if s.startswith("```"):
        s = s.replace("```json", "").replace("```", "").strip()
    # fast path: the whole thing is already clean JSON (avoids the
    # brace-slicing below, which breaks on prose containing { }).
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    first = s.find("{")
    last = s.rfind("}")
    if first < 0 or last <= first:
        raise RuntimeError(f"no JSON object in LLM response: {text[:200]}")
    return json.loads(s[first : last + 1])


def stub_response(path: str) -> dict:
    """Load a stub LLM response from a JSON file (for --dry-run testing)."""
    with open(path, "r") as f:
        return json.load(f)


# ─── 9Router backend ─────────────────────────────────────────────────

def _call_9router(prompt: str, base_url: str, model: str,
                  timeout: float, max_retries: int) -> dict:
    """Call OpenAI-compatible endpoint (9Router). stream=False is critical."""
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            resp = httpx.post(
                base_url,
                json={
                    "model": model,
                    "stream": False,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=timeout,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            return extract_json(text)
        except Exception as e:
            last_err = e
            if attempt < max_retries:
                time.sleep(2)
                continue
    raise RuntimeError(f"9Router LLM call failed after {max_retries + 1} attempts: {last_err}")


# ─── Gemini direct backend ───────────────────────────────────────────

def _call_gemini_direct(prompt: str, gemini_key: str, model: str,
                         timeout: float, max_retries: int) -> dict:
    """Call Google Gemini API directly with multi-model fallback."""
    # NOTE: keep this list short and real. flash-lite was deliberately
    # excluded (too dumb per module docstring); speculative model names
    # just burn round-trips on 404s.
    candidate_models = [model, "gemini-flash-latest"]
    # Deduplicate while preserving order
    seen = set()
    candidate_models = [m for m in candidate_models if m and not (m in seen or seen.add(m))]

    last_err = None
    for m in candidate_models:
        url = f"{GEMINI_BASE}/models/{m}:generateContent"
        for attempt in range(max_retries + 1):
            try:
                resp = httpx.post(
                    url,
                    # T13: key in header, not URL query — query keys land in
                    # exception messages, logs, and process listings.
                    headers={"x-goog-api-key": gemini_key},
                    json={
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {"responseMimeType": "application/json"},
                    },
                    timeout=timeout,
                )
                resp.raise_for_status()
                data = resp.json()
                text = data["candidates"][0]["content"]["parts"][0]["text"]
                return extract_json(text)
            except Exception as e:
                last_err = e
                if attempt < max_retries:
                    time.sleep(1)
                    continue
    raise RuntimeError(f"Gemini direct LLM call failed across models: {last_err}")
