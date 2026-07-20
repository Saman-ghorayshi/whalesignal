"""trading_loop/llm.py — 9Router LLM wrapper.

One call to 9Router (localhost:20128), OpenAI-compatible. Send stream=False
or it defaults to SSE and breaks JSON parsing. Takes a prompt string,
returns parsed JSON from the LLM's text response.

ponytail: no openai pip package (not installed). Raw httpx to /v1/chat/completions.
"""

import json
import httpx


def call_llm(prompt: str, base_url: str = "http://localhost:20128/v1/chat/completions",
             model: str = "gemini/gemini-3.1-flash-lite-preview",
             timeout: float = 30.0) -> dict:
    """Call 9Router, extract JSON from the response. Returns parsed dict.

    Raises:
        RuntimeError if the call fails or response isn't parseable JSON.
    """
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


def extract_json(text: str) -> dict:
    """Extract first JSON object from LLM text (may be fenced in ```json)."""
    s = text.strip()
    # strip code fences
    if s.startswith("```"):
        s = s.replace("```json", "").replace("```", "").strip()
    first = s.find("{")
    last = s.rfind("}")
    if first < 0 or last <= first:
        raise RuntimeError(f"no JSON object in LLM response: {text[:200]}")
    return json.loads(s[first : last + 1])


def stub_response(path: str) -> dict:
    """Load a stub LLM response from a JSON file (for --dry-run testing)."""
    with open(path, "r") as f:
        return json.load(f)
