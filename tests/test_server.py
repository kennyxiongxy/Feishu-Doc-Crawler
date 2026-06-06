"""Tests for feishu_server.py pure functions.

These tests cover the text-processing pipeline that runs on every
crawled document. No subprocess / network calls — only pure functions.
"""
import os
import tempfile

import pytest

# All tests use the `server_module` fixture from conftest.py
# which loads feishu_server.py by file path.


# ============================================================
# cell_to_text
# ============================================================
class TestCellToText:
    def test_none(self, server_module):
        assert server_module.cell_to_text(None) == ""

    def test_plain_string(self, server_module):
        assert server_module.cell_to_text("hello") == "hello"

    def test_string_with_whitespace(self, server_module):
        # cell_to_text returns the original cell (not stripped) when the
        # string isn't a rich-text segment — only the parser path strips.
        assert server_module.cell_to_text("  hello  ") == "  hello  "

    def test_rich_text_segment_string(self, server_module):
        # Feishu returns rich text cells as Python-dict stringified list
        s = "[{'text': 'foo'}, {'text': 'bar'}]"
        assert server_module.cell_to_text(s) == "foobar"

    def test_rich_text_with_non_dict_items(self, server_module):
        # Non-dict items in the segment list are dropped (filtered by
        # isinstance(seg, dict) check), not coerced to str.
        s = "[{'text': 'a'}, 'raw', {'text': 'b'}]"
        assert server_module.cell_to_text(s) == "ab"

    def test_malformed_rich_text_falls_back(self, server_module):
        # SyntaxError -> fall through and return original
        s = "[{not valid"
        assert server_module.cell_to_text(s) == "[{not valid"

    def test_list_input(self, server_module):
        assert server_module.cell_to_text([{"text": "x"}, {"text": "y"}]) == "xy"

    def test_number_input(self, server_module):
        assert server_module.cell_to_text(42) == "42"

    def test_string_that_looks_like_segment_but_isnt_pair(self, server_module):
        # Starts with [{ but doesn't end with }] — should not be parsed
        s = "[{abc"
        assert server_module.cell_to_text(s) == "[{abc"


# ============================================================
# clean_rich_text_in_markdown
# ============================================================
class TestCleanRichTextInMarkdown:
    def test_table_row_with_rich_text(self, server_module):
        line = "| col1 | [{'text': 'foo'}] | col3 |"
        out = server_module.clean_rich_text_in_markdown(line)
        assert out == "| col1 | foo | col3 |"

    def test_multiple_segments_in_row(self, server_module):
        line = "| [{'text': 'a'}] | [{'text': 'b'}] |"
        out = server_module.clean_rich_text_in_markdown(line)
        assert out == "| a | b |"

    def test_non_table_line_untouched(self, server_module):
        line = "This is regular text with [{'text': 'foo'}] in it"
        out = server_module.clean_rich_text_in_markdown(line)
        # Only table rows (|) are processed
        assert "[{'text': 'foo'}]" in out

    def test_multiline_input(self, server_module):
        content = (
            "# Title\n"
            "\n"
            "| a | [{'text': 'b'}] |\n"
            "| --- | --- |\n"
            "| c | d |\n"
        )
        out = server_module.clean_rich_text_in_markdown(content)
        assert "| a | b |" in out
        assert "| c | d |" in out
        assert "# Title" in out

    def test_malformed_segment_does_not_crash(self, server_module):
        line = "| a | [{broken | b |"
        # Should not raise, just leave the broken segment alone
        out = server_module.clean_rich_text_in_markdown(line)
        assert "| a |" in out

    def test_nested_brackets(self, server_module):
        # segments with quoted brackets inside
        line = "| x | [{'text': 'has [brackets]'}] | y |"
        out = server_module.clean_rich_text_in_markdown(line)
        assert "has [brackets]" in out


# ============================================================
# parse_cite_elements
# ============================================================
class TestParseCiteElements:
    def test_basic_cite(self, server_module):
        content = '<cite doc-id="abc123" title="Hello" type="doc"></cite>'
        out = server_module.parse_cite_elements(content)
        assert len(out) == 1
        assert out[0]["doc_token"] == "abc123"
        assert out[0]["title"] == "Hello"

    def test_multiple_cites(self, server_module):
        content = (
            '<cite doc-id="a1" title="A" type="doc"></cite>\n'
            '<cite doc-id="b2" title="B" type="doc"></cite>'
        )
        out = server_module.parse_cite_elements(content)
        assert len(out) == 2
        assert {o["title"] for o in out} == {"A", "B"}

    def test_duplicate_doc_id_deduped(self, server_module):
        content = (
            '<cite doc-id="dup" title="First" type="doc"></cite>\n'
            '<cite doc-id="dup" title="Second" type="doc"></cite>'
        )
        out = server_module.parse_cite_elements(content)
        assert len(out) == 1
        assert out[0]["title"] == "First"

    def test_missing_attributes_skipped(self, server_module):
        content = '<cite title="no id" type="doc"></cite>'
        out = server_module.parse_cite_elements(content)
        assert out == []

    def test_empty_content(self, server_module):
        assert server_module.parse_cite_elements("") == []

    def test_no_cite(self, server_module):
        assert server_module.parse_cite_elements("# Just a heading\n\nbody") == []

    def test_url_includes_wiki(self, server_module):
        content = '<cite doc-id="xyz" title="T" type="doc"></cite>'
        out = server_module.parse_cite_elements(content)
        assert "wiki/xyz" in out[0]["url"]


# ============================================================
# extract_title_from_markdown
# ============================================================
class TestExtractTitle:
    def test_basic_h1(self, server_module):
        assert server_module.extract_title_from_markdown("# Hello\n\nbody") == "Hello"

    def test_h1_with_whitespace(self, server_module):
        assert server_module.extract_title_from_markdown("#   Hello   \n\nbody") == "Hello"

    def test_no_h1_returns_default(self, server_module):
        assert server_module.extract_title_from_markdown("body without h1") == "未命名文档"

    def test_h2_is_not_picked(self, server_module):
        # Only H1 should be picked
        assert server_module.extract_title_from_markdown("## Sub\n\nbody") == "未命名文档"

    def test_h1_after_other_content(self, server_module):
        content = "Some text\n\n# Real Title\n\nmore"
        assert server_module.extract_title_from_markdown(content) == "Real Title"


# ============================================================
# extract_images
# ============================================================
class TestExtractImages:
    def test_basic_png(self, server_module):
        content = "![alt](https://example.com/foo.png)"
        out = server_module.extract_images(content)
        assert len(out) == 1
        assert out[0]["ext"] == "png"
        assert out[0]["alt"] == "alt"

    def test_avatar_url_filtered(self, server_module):
        content = "![avatar](https://example.com/avatar/123.png)"
        out = server_module.extract_images(content)
        assert out == []

    def test_icon_url_filtered(self, server_module):
        content = "![icon](https://example.com/static/icon.png)"
        out = server_module.extract_images(content)
        assert out == []

    def test_extension_inferred(self, server_module):
        cases = {
            "https://x.com/a.jpg": "jpg",
            "https://x.com/a.jpeg": "jpeg",
            "https://x.com/a.gif": "gif",
            "https://x.com/a.webp": "webp",
            "https://x.com/a.svg": "svg",
        }
        for url, expected in cases.items():
            out = server_module.extract_images(f"![a]({url})")
            assert out[0]["ext"] == expected, f"{url} -> {out[0]['ext']}"

    def test_unknown_extension_defaults_to_png(self, server_module):
        out = server_module.extract_images("![a](https://x.com/file.bin)")
        assert out[0]["ext"] == "png"

    def test_url_with_query_string(self, server_module):
        out = server_module.extract_images("![a](https://x.com/foo.png?v=123)")
        assert out[0]["ext"] == "png"

    def test_multiple_images(self, server_module):
        content = (
            "![a](https://x.com/1.png)\n"
            "![b](https://x.com/2.jpg)\n"
        )
        out = server_module.extract_images(content)
        assert len(out) == 2
        assert [o["ext"] for o in out] == ["png", "jpg"]


# ============================================================
# extract_token_from_url
# ============================================================
class TestExtractTokenFromUrl:
    def test_wiki_url(self, server_module):
        url = "https://zcnv4hck1o2h.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvWx"
        assert server_module.extract_token_from_url(url) == "AbCdEfGhIjKlMnOpQrStUvWx"

    def test_docx_url(self, server_module):
        url = "https://x.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWx"
        assert server_module.extract_token_from_url(url) == "AbCdEfGhIjKlMnOpQrStUvWx"

    def test_docs_url(self, server_module):
        url = "https://x.feishu.cn/docs/AbCdEfGhIjKlMnOpQrStUvWx"
        assert server_module.extract_token_from_url(url) == "AbCdEfGhIjKlMnOpQrStUvWx"

    def test_url_with_query(self, server_module):
        url = "https://x.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvWx?from=wiki"
        assert server_module.extract_token_from_url(url) == "AbCdEfGhIjKlMnOpQrStUvWx"

    def test_trailing_slash(self, server_module):
        url = "https://x.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvWx/"
        assert server_module.extract_token_from_url(url) == "AbCdEfGhIjKlMnOpQrStUvWx"

    def test_short_token_in_path_falls_back_to_last_segment(self, server_module):
        url = "https://x.feishu.cn/AbCdEfGhIjKlMnOpQrStUvWx"
        # Last segment is the long token, so should return it
        assert server_module.extract_token_from_url(url) == "AbCdEfGhIjKlMnOpQrStUvWx"

    def test_no_token(self, server_module):
        assert server_module.extract_token_from_url("https://x.feishu.cn/wiki/") is None

    def test_empty_string(self, server_module):
        assert server_module.extract_token_from_url("") is None


# ============================================================
# get_space_key
# ============================================================
class TestGetSpaceKey:
    def test_feishu_subdomain(self, server_module):
        assert server_module.get_space_key("https://zcnv4hck1o2h.feishu.cn/wiki/xxx") == "zcnv4hck1o2h"

    def test_feishu_staging(self, server_module):
        # Not a real feishu staging host, but verify the parts logic
        url = "https://test.feishu.cn/wiki/abc"
        assert server_module.get_space_key(url) == "test"

    def test_localhost(self, server_module):
        # Should return hostname as-is for non-feishu hosts
        assert server_module.get_space_key("http://127.0.0.1:8765/health") == "127.0.0.1"


# ============================================================
# clean_markdown (integration of helpers)
# ============================================================
class TestCleanMarkdown:
    def test_callout_conversion(self, server_module):
        content = '<callout emoji="💡">Hello world</callout>'
        out = server_module.clean_markdown(content)
        assert "> **💡**" in out
        assert "Hello world" in out

    def test_callout_multiline(self, server_module):
        content = '<callout emoji="⚠️">Line 1\nLine 2</callout>'
        out = server_module.clean_markdown(content)
        assert "> **⚠️**" in out
        assert "> Line 1" in out
        assert "> Line 2" in out

    def test_cite_removed(self, server_module):
        content = 'Some text <cite doc-id="abc" title="X" type="doc"></cite> more text'
        out = server_module.clean_markdown(content)
        assert "<cite" not in out
        assert "Some text" in out
        assert "more text" in out

    def test_excessive_blank_lines_collapsed(self, server_module):
        content = "line1\n\n\n\n\n\nline2"
        out = server_module.clean_markdown(content)
        # Should have at most 3 consecutive newlines
        assert "\n\n\n\n" not in out

    def test_table_rich_text_cleaned(self, server_module):
        content = "| col | [{'text': 'val'}] |"
        out = server_module.clean_markdown(content)
        assert "| col | val |" in out


# ============================================================
# Cache functions (in-memory state, not file IO)
# ============================================================
class TestCacheRoundTrip:
    def test_cache_root_for_space_keeps_highest_count(self, server_module):
        # Reset module-level cache
        server_module._space_root_cache.clear()

        server_module.cache_root_for_space("sp1", "tokenA", sub_doc_count=3)
        assert server_module.get_cached_root("sp1") == "tokenA"

        # Lower count should NOT replace
        server_module.cache_root_for_space("sp1", "tokenB", sub_doc_count=1)
        assert server_module.get_cached_root("sp1") == "tokenA"

        # Higher count should replace
        server_module.cache_root_for_space("sp1", "tokenC", sub_doc_count=10)
        assert server_module.get_cached_root("sp1") == "tokenC"

    def test_cache_persists_to_file(self, server_module):
        server_module._space_root_cache.clear()
        server_module.cache_root_for_space("spfile", "tokFile", sub_doc_count=2)

        # File should exist and contain the mapping
        assert os.path.exists(server_module._CACHE_FILE)
        with open(server_module._CACHE_FILE) as f:
            import json as _json
            data = _json.load(f)
        assert data.get("spfile") == "tokFile"

        # Cleanup so we don't pollute the repo
        try:
            os.unlink(server_module._CACHE_FILE)
        except FileNotFoundError:
            pass


# ============================================================
# is_retryable_failure / _extract_lark_code
# ============================================================
class TestRetryClassification:
    def test_timeout_is_retryable(self, server_module):
        assert server_module.is_retryable_failure("lark-cli timeout (attempt 1/4)") is True

    def test_json_parse_error_is_retryable(self, server_module):
        assert server_module.is_retryable_failure("JSON parse error: bad json") is True

    def test_no_json_found_is_retryable(self, server_module):
        assert server_module.is_retryable_failure("No JSON found in output") is True

    def test_network_error_is_retryable(self, server_module):
        assert server_module.is_retryable_failure("Connection refused") is True
        assert server_module.is_retryable_failure("Network unreachable") is True

    def test_permanent_token_code_not_retryable(self, server_module):
        # 99991663 = user access token expired (permanent)
        err = 'lark-cli failed: {"ok": false, "error": {"code": 99991663, "message": "token expired"}}'
        assert server_module.is_retryable_failure(err) is False

    def test_permanent_permission_code_not_retryable(self, server_module):
        # 99991675 = no permission
        err = 'lark-cli failed: {"ok": false, "error": {"code": 99991675, "message": "no perm"}}'
        assert server_module.is_retryable_failure(err) is False

    def test_permanent_invalid_param_not_retryable(self, server_module):
        # 230002 = parameter validation failed
        err = '{"code": 230002, "message": "invalid param"}'
        assert server_module.is_retryable_failure(err) is False

    def test_low_code_is_retryable(self, server_module):
        # code < 100 → server-side transient, retry
        err = '{"code": 1, "message": "Internal error. Please retry."}'
        assert server_module.is_retryable_failure(err) is True

    def test_unknown_high_code_defaults_to_no_retry(self, server_module):
        # Conservative: unknown high codes don't retry (could be business logic)
        err = '{"code": 99999999, "message": "unknown"}'
        assert server_module.is_retryable_failure(err) is False

    def test_unparseable_defaults_to_retry(self, server_module):
        # No code found → safer to retry (network glitches)
        assert server_module.is_retryable_failure("random garbage output") is True

    def test_empty_string_is_retryable(self, server_module):
        assert server_module.is_retryable_failure("") is True


class TestExtractLarkCode:
    def test_code_in_message(self, server_module):
        assert server_module._extract_lark_code('{"code": 123, "msg": "x"}') == 123

    def test_no_code(self, server_module):
        assert server_module._extract_lark_code("no json here") is None

    def test_empty(self, server_module):
        assert server_module._extract_lark_code("") is None

    def test_code_in_lark_cli_failed(self, server_module):
        s = 'lark-cli failed: {"ok": false, "error": {"code": 5, "message": "x"}}'
        assert server_module._extract_lark_code(s) == 5


# ============================================================
# with_retry
# ============================================================
class TestWithRetry:
    def test_immediate_success(self, server_module):
        calls = []
        def fn():
            calls.append(1)
            return {'ok': True, 'value': 42}
        result = server_module.with_retry(fn, max_attempts=3, base_delay=0.001)
        assert result == {'ok': True, 'value': 42}
        assert len(calls) == 1

    def test_succeeds_after_two_failures(self, server_module):
        calls = []
        def fn():
            calls.append(1)
            if len(calls) < 3:
                return {'error': 'lark-cli timeout (attempt 1/4)'}
            return {'ok': True}
        result = server_module.with_retry(fn, max_attempts=4, base_delay=0.001)
        assert result == {'ok': True}
        assert len(calls) == 3

    def test_gives_up_after_max_attempts(self, server_module):
        calls = []
        def fn():
            calls.append(1)
            return {'error': 'lark-cli timeout'}
        result = server_module.with_retry(fn, max_attempts=3, base_delay=0.001)
        assert 'error' in result
        assert len(calls) == 3

    def test_permanent_error_returns_immediately(self, server_module):
        calls = []
        def fn():
            calls.append(1)
            return {'error': '{"code": 99991663, "message": "token expired"}'}
        result = server_module.with_retry(fn, max_attempts=4, base_delay=0.001)
        assert 'error' in result
        # Should NOT retry on permanent error
        assert len(calls) == 1

    def test_subprocess_timeout_is_retryable(self, server_module):
        import subprocess as sp
        calls = []
        def fn():
            calls.append(1)
            if len(calls) < 2:
                raise sp.TimeoutExpired(cmd='lark-cli', timeout=30)
            return {'ok': True}
        result = server_module.with_retry(fn, max_attempts=3, base_delay=0.001)
        assert result == {'ok': True}
        assert len(calls) == 2

    def test_unexpected_exception_not_retried(self, server_module):
        calls = []
        def fn():
            calls.append(1)
            raise ValueError("unexpected")
        result = server_module.with_retry(fn, max_attempts=3, base_delay=0.001)
        assert 'error' in result
        assert 'ValueError' in result['error']
        # Don't retry on non-timeout exceptions
        assert len(calls) == 1

    def test_returns_non_dict_unchanged(self, server_module):
        # If a function returns something other than dict, return as-is
        result = server_module.with_retry(lambda: "just a string", max_attempts=2, base_delay=0.001)
        assert result == "just a string"

    def test_exponential_backoff_timing(self, server_module):
        import time
        calls = []
        timestamps = []
        def fn():
            calls.append(1)
            timestamps.append(time.monotonic())
            return {'error': 'lark-cli timeout'}
        server_module.with_retry(fn, max_attempts=4, base_delay=0.05)
        # Expected gaps: 0.05, 0.1, 0.2 between attempts
        assert len(timestamps) == 4
        gap1 = timestamps[1] - timestamps[0]
        gap2 = timestamps[2] - timestamps[1]
        gap3 = timestamps[3] - timestamps[2]
        # Generous lower bound to account for scheduler overhead
        assert gap1 >= 0.04
        assert gap2 >= 0.09
        assert gap3 >= 0.19
        # And upper bound to confirm we don't sleep too long
        assert gap1 < 0.5
        assert gap2 < 0.5
        assert gap3 < 0.5


# ============================================================
# Concurrency limiter
# ============================================================
class TestLarkCliLimiter:
    def test_semaphore_limits_concurrent_calls(self, server_module):
        import threading
        sem = server_module._lark_cli_semaphore
        # Sanity: this is a Semaphore(3) object with internal counter
        # We can't easily check the exact limit value, but we can verify
        # run_lark_cli_limited respects concurrency.
        active = 0
        max_active = 0
        lock = threading.Lock()

        def work():
            nonlocal active, max_active
            with lock:
                active += 1
                max_active = max(max_active, active)
            import time as _t
            _t.sleep(0.05)
            with lock:
                active -= 1

        # Fire 10 concurrent calls
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            futures = [pool.submit(server_module.run_lark_cli_limited, work) for _ in range(10)]
            for f in futures:
                f.result()

        # With Semaphore(3), max concurrent should be <= 3
        assert max_active <= 3, f"max_active={max_active}"
        assert max_active >= 1

    def test_run_lark_cli_limited_uses_retry(self, server_module, monkeypatch):
        # Stub out the semaphore & retry internals to count attempts
        import feishu_server as fs
        calls = []

        def stub():
            calls.append(1)
            if len(calls) < 2:
                return {'error': 'lark-cli timeout'}
            return {'ok': True}

        result = server_module.run_lark_cli_limited(stub)
        # Stub doesn't take the semaphore into account here, but
        # the result should reflect the retry succeeding
        assert result.get('ok') is True
        assert len(calls) == 2
