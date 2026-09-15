"""tests/test_llm.py — tests for the upgraded llm.py.

Tests:
  1. extract_json on clean JSON
  2. extract_json on ```json fenced JSON
  3. extract_json on JSON embedded in prose
  4. extract_json on malformed text (raises RuntimeError)
  5. extract_json on JSON with extra trailing text
  6. call_llm with gemini_key=None uses 9Router backend (mocked)
  7. call_llm with gemini_key="test" uses Gemini direct backend (mocked)
  8. call_llm retry on failure (mocked, 1 retry then success)
  9. call_llm raises after max_retries exhausted
 10. stub_response loads a JSON file

All network calls are mocked — no real LLM calls in these tests.
The LIVE 9Router test is in test_loop_live.py (run manually).
"""

import json
import os
import sys
import tempfile
from unittest.mock import patch, MagicMock
from pathlib import Path

import pytest
import httpx

# Add project root to path so imports work
sys.path.insert(0, str(Path(__file__).parent.parent))

from trading_loop.llm import (
    extract_json,
    stub_response,
    call_llm,
    _call_9router,
    _call_gemini_direct,
    MODEL_TRADE_9ROUTER,
    MODEL_TRADE_GEMINI,
    MODEL_REVIEW_9ROUTER,
    MODEL_REVIEW_GEMINI,
)


# ─── extract_json tests ──────────────────────────────────────────────

class TestExtractJson:
    def test_clean_json(self):
        text = '{"decision": "SKIP", "confidence": 0.3}'
        result = extract_json(text)
        assert result == {"decision": "SKIP", "confidence": 0.3}

    def test_fenced_json(self):
        text = '```json\n{"decision": "COPY", "side": "long"}\n```'
        result = extract_json(text)
        assert result == {"decision": "COPY", "side": "long"}

    def test_json_in_prose(self):
        text = 'Here is my decision: {"decision": "SKIP", "confidence": 0.1} hope that helps.'
        result = extract_json(text)
        assert result == {"decision": "SKIP", "confidence": 0.1}

    def test_malformed_raises(self):
        with pytest.raises(RuntimeError, match="no JSON object"):
            extract_json("no json here at all")

    def test_json_with_trailing_text(self):
        """extract_json uses rfind('}') to find the last closing brace.
        Realistic trailing text from LLMs doesn't have extra }} — it's
        things like 'Hope this helps!' after the JSON block."""
        text = '{"decision": "COPY"} Hope this helps!'
        result = extract_json(text)
        assert result == {"decision": "COPY"}

    def test_nested_json(self):
        text = '{"decision": "COPY", "risk": {"leverage": 3, "size_pct": 8}}'
        result = extract_json(text)
        assert result["risk"]["leverage"] == 3

    def test_empty_string_raises(self):
        with pytest.raises(RuntimeError):
            extract_json("")


# ─── stub_response tests ─────────────────────────────────────────────

class TestStubResponse:
    def test_loads_json_file(self, tmp_path):
        f = tmp_path / "stub.json"
        f.write_text(json.dumps({"decision": "SKIP"}))
        result = stub_response(str(f))
        assert result == {"decision": "SKIP"}


# ─── model defaults ──────────────────────────────────────────────────

class TestModelDefaults:
    def test_trade_model_is_deepseek_v4_flash(self):
        """The plan says flash-lite is dumb — we upgraded to deepseek-v4-flash."""
        assert MODEL_TRADE_9ROUTER == "nvidia/deepseek-ai/deepseek-v4-flash"

    def test_review_model_is_glm_5_2(self):
        """Weekly review uses glm-5.2 (deepseek-v4-pro times out on 9Router)."""
        assert MODEL_REVIEW_9ROUTER == "nvidia/z-ai/glm-5.2"

    def test_gemini_trade_model_is_flash_not_lite(self):
        """Skip flash-lite for direct Gemini — it's too dumb."""
        assert "flash" in MODEL_TRADE_GEMINI
        assert "lite" not in MODEL_TRADE_GEMINI.lower()


# ─── call_llm backend selection (mocked) ─────────────────────────────

class TestCallLlmBackendSelection:
    """Verify that gemini_key switches between 9Router and Gemini direct."""

    @patch("trading_loop.llm._call_9router")
    def test_no_gemini_key_uses_9router(self, mock_9router):
        mock_9router.return_value = {"decision": "SKIP"}
        result = call_llm("test prompt", gemini_key=None)
        assert result == {"decision": "SKIP"}
        mock_9router.assert_called_once()

    @patch("trading_loop.llm._call_gemini_direct")
    def test_gemini_key_uses_gemini_direct(self, mock_gemini):
        mock_gemini.return_value = {"decision": "COPY"}
        result = call_llm("test prompt", gemini_key="AIzaSyTest123")
        assert result == {"decision": "COPY"}
        mock_gemini.assert_called_once()
        assert mock_gemini.call_args[0][1] == "AIzaSyTest123"  # gemini_key arg

    @patch("trading_loop.llm._call_9router")
    def test_9router_called_with_correct_model(self, mock_9router):
        mock_9router.return_value = {"decision": "SKIP"}
        call_llm("prompt", gemini_key=None)
        # model is the 3rd positional arg (index 2)
        assert mock_9router.call_args[0][2] == MODEL_TRADE_9ROUTER

    @patch("trading_loop.llm._call_gemini_direct")
    def test_gemini_called_with_correct_model(self, mock_gemini):
        mock_gemini.return_value = {"decision": "SKIP"}
        call_llm("prompt", gemini_key="test_key")
        # model is the 3rd positional arg (index 2)
        assert mock_gemini.call_args[0][2] == MODEL_TRADE_GEMINI


# ─── retry logic (mocked) ────────────────────────────────────────────

class TestRetryLogic:
    @patch("trading_loop.llm.time.sleep")
    @patch("trading_loop.llm.httpx.post")
    def test_retry_on_failure_then_success(self, mock_post, mock_sleep):
        """9Router returns 503 on first call, succeeds on retry."""
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = [httpx.HTTPStatusError("503", request=MagicMock(), response=MagicMock(status_code=503)), None]
        mock_response.json.return_value = {"choices": [{"message": {"content": '{"decision": "COPY"}'}}]}
        mock_post.return_value = mock_response

        result = call_llm("prompt", gemini_key=None, max_retries=1)
        assert result == {"decision": "COPY"}
        assert mock_post.call_count == 2

    @patch("trading_loop.llm.time.sleep")
    @patch("trading_loop.llm.httpx.post")
    def test_raises_after_max_retries(self, mock_post, mock_sleep):
        """All attempts fail → RuntimeError after max_retries exhausted."""
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "503", request=MagicMock(), response=MagicMock(status_code=503)
        )
        mock_response.json.return_value = {}
        mock_post.return_value = mock_response

        with pytest.raises(RuntimeError, match="failed after 2 attempts"):
            call_llm("prompt", gemini_key=None, max_retries=1)
        assert mock_post.call_count == 2  # 1 initial + 1 retry

    @patch("trading_loop.llm.time.sleep")
    @patch("trading_loop.llm.httpx.post")
    def test_sleep_between_retries(self, mock_post, mock_sleep):
        """time.sleep(2) is called between retry attempts."""
        mock_response = MagicMock()
        err = httpx.HTTPStatusError("503", request=MagicMock(), response=MagicMock(status_code=503))
        mock_response.raise_for_status.side_effect = [err, None]
        mock_response.json.return_value = {"choices": [{"message": {"content": '{"decision": "COPY"}'}}]}
        mock_post.return_value = mock_response

        call_llm("prompt", gemini_key=None, max_retries=1)
        mock_sleep.assert_called_once_with(2)
