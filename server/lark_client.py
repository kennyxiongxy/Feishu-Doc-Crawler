"""飞书文档爬取 - lark-cli 调用、重试与并发限流。"""

import json
import os
import re
import subprocess
import threading
import time


# 已知永久性错误码（auth/permission/token 类，不重试）
# 飞书 OpenAPI: https://open.feishu.cn/document/server-docs/api-call-guide/server-api-list
PERMANENT_LARK_CODES = {
    99991663,  # user access token expired
    99991668,  # invalid access token
    99991675,  # no permission
    99991677,  # token revoked
    99991679,  # token does not exist
    230001,    # invalid parameter (caller bug, won't help to retry)
    230002,    # parameter validation failed
    230006,    # invalid id
}


def _extract_lark_code(err_str):
    """Try to extract a numeric error code from a lark-cli error string."""
    if not err_str:
        return None
    m = re.search(r'"code"\s*:\s*(\d+)', err_str)
    return int(m.group(1)) if m else None


def is_retryable_failure(err_str):
    """Decide if a lark-cli error is transient and worth retrying.

    Heuristics:
      - subprocess/timeout/JSON parse errors → retry (network glitch)
      - code < 100 → retry (server-side transient)
      - known permanent codes → no retry
      - unparseable → retry (safer default)
    """
    if not err_str:
        return True
    s = err_str.lower()
    if 'timeout' in s:
        return True
    if 'json' in s and 'parse' in s:
        return True
    if 'no json found' in s:
        return True
    if 'connection' in s or 'network' in s:
        return True
    code = _extract_lark_code(err_str)
    if code is None:
        return True
    if code in PERMANENT_LARK_CODES:
        return False
    if code < 100:
        return True
    return False


# 进程级 lark-cli 并发限流：3 路同时调用。
# 防止 popup 端开 3 路并发 + 用户手动多开 popup 时把 lark-cli / 飞书 API 打爆。
_lark_cli_semaphore = threading.Semaphore(3)


def with_retry(fn, *args, max_attempts=4, base_delay=1.0, **kwargs):
    """Call fn(*args, **kwargs) with exponential backoff on transient failures.

    fn should return a dict. Returns immediately on success or permanent error.
    On retryable failure, sleeps 1s, 2s, 4s between attempts (up to max_attempts).

    For lark-cli subprocess calls, use this in conjunction with _lark_cli_semaphore
    for concurrency limiting.
    """
    last_result = None
    for attempt in range(max_attempts):
        try:
            result = fn(*args, **kwargs)
        except subprocess.TimeoutExpired:
            last_result = {'error': f'lark-cli timeout (attempt {attempt+1}/{max_attempts})'}
        except Exception as e:
            return {'error': f'{type(e).__name__}: {str(e)[:200]}'}
        else:
            if not (isinstance(result, dict) and 'error' in result):
                return result  # success
            err_str = result['error']
            if not is_retryable_failure(err_str):
                return result  # permanent
            last_result = result

        # Backoff before next attempt
        if attempt < max_attempts - 1:
            time.sleep(base_delay * (2 ** attempt))

    return last_result


def run_lark_cli_limited(fn, *args, **kwargs):
    """Acquire the lark-cli semaphore and run with retry. Use for any lark-cli subprocess call."""
    with _lark_cli_semaphore:
        return with_retry(fn, *args, **kwargs)


def _run_lark_cli_impl(lark_cli, token):
    """调用 lark-cli 获取文档原始 JSON (inner impl, no retry)"""
    env = os.environ.copy()
    env['LARK_CLI_NO_PROXY'] = '1'

    cmd = [
        lark_cli, 'docs', '+fetch',
        '--api-version', 'v2',
        '--doc-format', 'markdown',
        '--doc', token,
        '--as', 'user',
        '--format', 'json'
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=30,
        env=env
    )

    if result.returncode != 0:
        return {'error': f'lark-cli failed: {result.stderr}'}

    try:
        data = json.loads(result.stdout)
        if not data.get('ok'):
            return {'error': 'API returned not ok'}
        return data
    except json.JSONDecodeError as e:
        return {'error': f'JSON parse error: {e}'}


def run_lark_cli(lark_cli, token):
    """Public entry — wraps _run_lark_cli_impl with concurrency limit + retry."""
    return run_lark_cli_limited(_run_lark_cli_impl, lark_cli, token)


def fetch_doc_content(lark_cli, token, markdown_module):
    """通过 lark-cli 获取文档的 Markdown 内容"""
    data = run_lark_cli(lark_cli, token)
    if 'error' in data:
        return data

    doc = data.get('data', {}).get('document', {})
    content = doc.get('content', '')
    title = markdown_module.extract_title_from_markdown(content)

    # 先从原始内容中提取 cite 来获得子文档列表
    sub_docs = markdown_module.parse_cite_elements(content)

    # 提取图片 URL 列表
    images = markdown_module.extract_images(content)

    # 清理特殊标签
    content = markdown_module.clean_markdown(content, lark_cli, run_lark_cli_limited)

    return {
        'title': title,
        'content': content,
        'images': images,
        'document_id': doc.get('document_id', ''),
        'sub_docs': sub_docs,
    }


def _run_lark_cli_raw_impl(lark_cli, cmd, timeout=30):
    """Run a lark-cli command and return parsed JSON (inner impl, no retry)"""
    env = os.environ.copy()
    env['LARK_CLI_NO_PROXY'] = '1'

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if result.returncode != 0:
        return {'error': f'lark-cli failed: {result.stderr}'}

    # Parse JSON from output (may have leading text like "Found X node(s)")
    lines = result.stdout.split('\n')
    json_start = None
    for i, line in enumerate(lines):
        if line.strip().startswith('{'):
            json_start = i
            break

    if json_start is None:
        return {'error': 'No JSON found in output'}

    try:
        json_str = '\n'.join(lines[json_start:])
        return json.loads(json_str)
    except json.JSONDecodeError as e:
        return {'error': f'JSON parse error: {e}'}


def run_lark_cli_raw(lark_cli, cmd, timeout=30):
    """Public entry — wraps _run_lark_cli_raw_impl with concurrency limit + retry."""
    return run_lark_cli_limited(_run_lark_cli_raw_impl, lark_cli, cmd, timeout=timeout)
