#!/usr/bin/env python3
"""
飞书文档爬取 - 本地 API 服务
通过 lark-cli 获取飞书文档的完整 Markdown 内容。

启动方式：
    python3 feishu_server.py

    或指定端口：
    python3 feishu_server.py --port 8765
"""

import json
import re
import ast
import base64
import subprocess
import sys
import os
import platform
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import argparse
from datetime import datetime


def cell_to_text(cell):
    """将单元格值转为纯文本，处理飞书富文本段格式"""
    if cell is None:
        return ''
    if isinstance(cell, str):
        s = cell.strip()
        if s.startswith('[{') and s.endswith('}]'):
            try:
                segments = ast.literal_eval(s)
                if isinstance(segments, list):
                    return ''.join(seg.get('text', '') for seg in segments if isinstance(seg, dict))
            except (ValueError, SyntaxError):
                pass
        return cell
    if isinstance(cell, list):
        return ''.join(seg.get('text', '') if isinstance(seg, dict) else str(seg) for seg in cell)
    return str(cell)


def clean_rich_text_in_markdown(content):
    """将 Markdown 表格中嵌入的飞书富文本段（Python 对象字符串）转为纯文本"""
    def find_rich_text_segments(line):
        """Find all [{...}] patterns in a line, handling nested brackets"""
        results = []
        i = 0
        while i < len(line):
            if line[i:i+2] == '[{':
                depth = 1
                j = i + 2
                while j < len(line) and depth > 0:
                    if line[j] == '[':
                        depth += 1
                    elif line[j] == ']':
                        depth -= 1
                    j += 1
                if depth == 0:
                    results.append((i, j, line[i:j]))
                i = j
            else:
                i += 1
        return results

    lines = content.split('\n')
    result_lines = []
    for line in lines:
        if line.strip().startswith('|') and '[{' in line:
            segments = find_rich_text_segments(line)
            if segments:
                for start, end, seg_text in reversed(segments):
                    try:
                        parsed = ast.literal_eval(seg_text)
                        if isinstance(parsed, list):
                            plain_text = ''.join(seg.get('text', '') for seg in parsed if isinstance(seg, dict))
                            line = line[:start] + plain_text + line[end:]
                    except (ValueError, SyntaxError):
                        pass
        result_lines.append(line)
    return '\n'.join(result_lines)


LARK_CLI = '/opt/homebrew/bin/lark-cli'

# 空间 -> 根页面 token 缓存（持久化到文件）
import threading
import time
import os as _os

_CACHE_FILE = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), '.space_cache.json')
_space_root_cache = {}
_cache_lock = threading.RLock()


def _load_cache():
    """从文件加载缓存的映射"""
    global _space_root_cache
    try:
        if _os.path.exists(_CACHE_FILE):
            with open(_CACHE_FILE, 'r') as f:
                _space_root_cache = json.load(f)
            print(f'[Server] Loaded {len(_space_root_cache)} cached space mappings')
    except Exception:
        pass


def _save_cache():
    """保存映射到文件"""
    with _cache_lock:
        try:
            with open(_CACHE_FILE, 'w') as f:
                json.dump(_space_root_cache, f)
        except Exception:
            pass


_load_cache()


def get_space_key(url):
    """从 URL 提取空间 key（子域名）"""
    parsed = urlparse(url)
    host = parsed.hostname or ''
    parts = host.split('.')
    if len(parts) >= 3 and parts[1] == 'feishu':
        return parts[0]
    return host


def cache_root_for_space(space_key, root_token, sub_doc_count=0):
    """缓存空间的根页面 token（保留子文档最多的那个）"""
    with _cache_lock:
        # 用复合 key 存储: {token: count}
        cache_key = space_key + '__count'
        current_best = _space_root_cache.get(space_key)
        current_count = _space_root_cache.get(cache_key, 0)
        
        if sub_doc_count > current_count:
            _space_root_cache[space_key] = root_token
            _space_root_cache[cache_key] = sub_doc_count
            _save_cache()
            print(f'[Server] Cached root for {space_key}: {root_token[:16]}... ({sub_doc_count} sub-docs)')


def get_cached_root(space_key):
    """获取缓存的空间根 token"""
    with _cache_lock:
        return _space_root_cache.get(space_key)


# ============================================================
# lark-cli 调用的重试 + 并发限流
# ============================================================

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
        except subprocess.TimeoutExpired as e:
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


PORT = 8765


def extract_token_from_url(url):
    """从飞书文档 URL 中提取 doc token"""
    parsed = urlparse(url)
    path = parsed.path.rstrip('/')
    parts = path.split('/')

    for i, part in enumerate(parts):
        if part in ('wiki', 'docx', 'docs'):
            if i + 1 < len(parts):
                token = parts[i + 1]
                if '?' in token:
                    token = token.split('?')[0]
                return token

    last = parts[-1] if parts else ''
    if len(last) >= 20:
        return last

    return None


def _run_lark_cli_impl(token):
    """调用 lark-cli 获取文档原始 JSON (inner impl, no retry)"""
    env = os.environ.copy()
    env['LARK_CLI_NO_PROXY'] = '1'

    cmd = [
        LARK_CLI, 'docs', '+fetch',
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


def run_lark_cli(token):
    """Public entry — wraps _run_lark_cli_impl with concurrency limit + retry."""
    return run_lark_cli_limited(_run_lark_cli_impl, token)


def fetch_doc_content(token):
    """通过 lark-cli 获取文档的 Markdown 内容"""
    data = run_lark_cli(token)
    if 'error' in data:
        return data

    doc = data.get('data', {}).get('document', {})
    content = doc.get('content', '')
    title = extract_title_from_markdown(content)

    # 先从原始内容中提取 cite 来获得子文档列表
    sub_docs = parse_cite_elements(content)

    # 提取图片 URL 列表
    images = extract_images(content)

    # 清理特殊标签
    content = clean_markdown(content)

    return {
        'title': title,
        'content': content,
        'images': images,
        'document_id': doc.get('document_id', ''),
        'sub_docs': sub_docs,
    }



def _run_lark_cli_raw_impl(cmd, timeout=30):
    """Run a lark-cli command and return parsed JSON (inner impl, no retry)"""
    env = os.environ.copy()
    env['LARK_CLI_NO_PROXY'] = '1'

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    if result.returncode != 0:
        return {'error': f'lark-cli failed: {result.stderr}'}

    # Parse JSON from output (may have leading text like "Found X node(s)")
    lines = result.stdout.split('\n')
    json_start = None
    for i, l in enumerate(lines):
        if l.strip().startswith('{'):
            json_start = i
            break

    if json_start is None:
        return {'error': 'No JSON found in output'}

    try:
        json_str = '\n'.join(lines[json_start:])
        return json.loads(json_str)
    except json.JSONDecodeError as e:
        return {'error': f'JSON parse error: {e}'}


def run_lark_cli_raw(cmd, timeout=30):
    """Public entry — wraps _run_lark_cli_raw_impl with concurrency limit + retry."""
    return run_lark_cli_limited(_run_lark_cli_raw_impl, cmd, timeout=timeout)


def run_wiki_node_get(token_or_url):
    """Get wiki node info using lark-cli wiki +node-get

    v5.10.2 关键修复: lark-cli 1.0.48+ 的 +node-get 必须传 --node-token,
    且对 raw token 会报 '--obj-type is required'. 但传完整 Lark URL
    (如 https://feishu.cn/wiki/<token>) 就能自动推断 obj_type.

    优先级:
      1) 如果 token_or_url 看起来是 URL (含 :// 或 以 /wiki/ 开头), 直接用
      2) 否则先试原始 token; 失败且报缺 --obj-type 时:
         a) 重试加 --obj-type docx (最常见的 wiki 底层类型, lark-cli's note 也提了)
         b) 仍失败则返回错误
    """
    # 步骤 1: 检测是否为 URL
    is_url = _is_wiki_url(token_or_url)

    if is_url:
        # URL 路径 — lark-cli 可自动推断 obj_type, 直接传
        cmd = [
            LARK_CLI, 'wiki', '+node-get',
            '--node-token', token_or_url,
            '--as', 'user',
            '--format', 'json'
        ]
        return run_lark_cli_raw(cmd)

    # 步骤 2: 原始 token — 先用 --node-token (lark-cli 1.0.48+ 推荐)
    cmd = [
        LARK_CLI, 'wiki', '+node-get',
        '--node-token', token_or_url,
        '--as', 'user',
        '--format', 'json'
    ]
    result = run_lark_cli_raw(cmd)
    if result.get('ok'):
        return result
    err = result.get('error', '') if isinstance(result, dict) else ''
    if not _is_obj_type_missing_error(result):
        return result
    # 步骤 3: 缺 --obj-type → 加 --obj-type docx 重试
    _wiki_log(f'wiki_api: node-get 缺 --obj-type, 重试加 --obj-type docx')
    cmd2 = list(cmd) + ['--obj-type', 'docx']
    return run_lark_cli_raw(cmd2)


def run_wiki_node_list(space_id, parent_token):
    """List wiki nodes under a parent node

    v5.10.2: 同样在缺 --obj-type 时自动重试. 这里 parent_token
    必须是 +node-get 返回的 node_token (不能用 obj_token 也不能是 URL).
    """
    cmd = [
        LARK_CLI, 'wiki', '+node-list',
        '--space-id', space_id,
        '--parent-node-token', parent_token,
        '--as', 'user',
        '--format', 'json'
    ]
    result = run_lark_cli_raw(cmd, timeout=15)
    if result.get('ok'):
        return result
    if not _is_obj_type_missing_error(result):
        return result
    _wiki_log(f'wiki_api: node-list 缺 --obj-type, 重试加 --obj-type docx')
    cmd2 = list(cmd) + ['--obj-type', 'docx']
    return run_lark_cli_raw(cmd2, timeout=15)


def _is_obj_type_missing_error(result):
    """检测 lark-cli 是否因 token 是 raw obj_token 缺 --obj-type 而失败"""
    if not isinstance(result, dict):
        return False
    err = result.get('error', '')
    if not isinstance(err, str):
        return False
    return ('--obj-type is required' in err) or ('raw obj_token' in err)


def _is_wiki_url(token_or_url):
    """v5.10.2: 检测是否传入的是完整 URL (含 :// 或 /wiki/)"""
    if not isinstance(token_or_url, str):
        return False
    return '://' in token_or_url or token_or_url.startswith('/wiki/')


def discover_via_wiki_api(token_or_url):
    """
    Use wiki API to discover sub-documents.
    Returns a list of articles from the wiki node tree.
    Falls back gracefully if the wiki API is unavailable.

    Result shape:
      On success (with or without children):
        {
          'title': str, 'space_id': str, 'page_token': str,
          'articles': [...], 'source': 'wiki_api',
          'wiki_status': 'ok' | 'no-children' | 'list-empty',
          'wiki_debug': { 'node_get_raw': {...}, 'node_list_raw': {...} or None,
                          'has_child': bool, 'nodes_count': int }
        }
      On error:
        { 'error': str, 'source': 'wiki_api',
          'wiki_status': 'error',
          'wiki_debug': { 'node_get_raw': {...} or None, ... } }
    """
    token = extract_token_from_url(token_or_url) if '/' in str(token_or_url) else token_or_url
    if not token:
        return {'error': 'Cannot extract token', 'source': 'wiki_api', 'wiki_status': 'error'}

    # Step 1: Get node info to check has_child and get space_id
    _wiki_log(f'wiki_api: getting node info for {token[:16]}...')
    node_data = run_wiki_node_get(token_or_url)

    if 'error' in node_data:
        _wiki_log(f'wiki_api: node-get failed: {node_data["error"][:100]}')
        return {
            'error': node_data['error'],
            'source': 'wiki_api',
            'wiki_status': 'error',
            'wiki_debug': {'node_get_raw': node_data, 'step': 'node-get'},
        }

    if not node_data.get('ok'):
        return {
            'error': 'Wiki API returned not ok',
            'source': 'wiki_api',
            'wiki_status': 'error',
            'wiki_debug': {'node_get_raw': node_data, 'step': 'node-get-ok'},
        }

    node = node_data.get('data', {})
    has_child = node.get('has_child', False)
    space_id = node.get('space_id', '')
    title = node.get('title', '')

    if not has_child:
        _wiki_log(f'wiki_api: has_child=false for {token[:16]} (no children per API)')
        return {
            'title': title, 'articles': [], 'source': 'wiki_api',
            'wiki_status': 'no-children',
            'wiki_debug': {'node_get_raw': node_data, 'has_child': False,
                           'space_id': space_id, 'node_list_raw': None},
        }

    if not space_id:
        return {
            'error': 'No space_id found',
            'source': 'wiki_api',
            'wiki_status': 'error',
            'wiki_debug': {'node_get_raw': node_data, 'step': 'no-space-id'},
        }

    # Step 2: List all children
    _wiki_log(f'wiki_api: listing children of {token[:16]} (space={space_id[:16]}...)')
    list_data = run_wiki_node_list(space_id, token)

    if 'error' in list_data:
        _wiki_log(f'wiki_api: node-list failed: {list_data["error"][:100]}')
        return {
            'error': list_data['error'],
            'source': 'wiki_api',
            'wiki_status': 'error',
            'wiki_debug': {'node_get_raw': node_data, 'node_list_raw': list_data,
                           'has_child': True, 'step': 'node-list'},
        }

    if not list_data.get('ok'):
        return {
            'error': 'Wiki node-list API returned not ok',
            'source': 'wiki_api',
            'wiki_status': 'error',
            'wiki_debug': {'node_get_raw': node_data, 'node_list_raw': list_data,
                           'has_child': True, 'step': 'node-list-ok'},
        }

    raw_data = list_data.get('data', {}) or {}
    # 防御: 字段名可能是 nodes / items / children / list
    nodes = (raw_data.get('nodes')
             or raw_data.get('items')
             or raw_data.get('children')
             or raw_data.get('list')
             or [])
    _wiki_log(f'wiki_api: +node-list returned {len(nodes)} nodes (raw keys={list(raw_data.keys())})')

    articles = []
    for n in nodes:
        node_token = n.get('node_token') or n.get('token') or ''
        if not node_token:
            continue
        articles.append({
            'title': n.get('title', ''),
            'doc_token': node_token,
            'url': f'https://internal.feishu.cn/wiki/{node_token}',
            'has_child': bool(n.get('has_child', False)),
            'obj_token': n.get('obj_token', ''),
        })

    status = 'ok' if articles else 'list-empty'
    _wiki_log(f'wiki_api: status={status} found {len(articles)} child nodes')
    return {
        'title': title,
        'space_id': space_id,
        'page_token': token,
        'articles': articles,
        'source': 'wiki_api',
        'wiki_status': status,
        'wiki_debug': {'node_get_raw': node_data, 'node_list_raw': list_data,
                       'has_child': True, 'nodes_count': len(nodes),
                       'articles_count': len(articles)},
    }


def _wiki_log(msg):
    """wiki API 日志 — 写到 /tmp/feishu_server_wiki.log, 同时 stdout 备用"""
    line = f'[{datetime.now().isoformat(timespec="seconds")}] {msg}'
    try:
        with open('/tmp/feishu_server_wiki.log', 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass
    print(f'[Server] {msg}', flush=True)


def discover_sub_documents(url_or_token, auto_find_root=False):
    """
    发现文档下的子文档列表。
    优先使用 wiki API 获取完整节点树，回退到 <cite> 元素解析。

    v5.10.2 行为变更:
      - 不再盲回退: 如果 wiki API 可达但返回空 (no-children / list-empty),
        就用 wiki API 的结果, 不再尝试 <cite> 解析
        (因为 <cite> 只能找到内联引用, 找不到 wiki 树中的纯子节点)
      - 始终透传 wiki_status / wiki_debug 给前端, 方便用户看到为什么空
      - 只有 wiki API 真正报错时才回退到 <cite> 解析
    """
    token = extract_token_from_url(url_or_token) if '/' in str(url_or_token) else url_or_token
    if not token:
        return {'error': 'Cannot extract token'}

    # --- Strategy 1: Wiki API (most complete, source of truth for wiki tree) ---
    wiki_result = discover_via_wiki_api(url_or_token)
    wiki_status = wiki_result.get('wiki_status', 'unknown')
    wiki_debug = wiki_result.get('wiki_debug', {})

    if 'error' not in wiki_result and wiki_result.get('articles'):
        # 成功且有子文档
        space_key = get_space_key(url_or_token) if '/' in str(url_or_token) else ''
        if space_key:
            cache_root_for_space(space_key, token, len(wiki_result['articles']))
        return {
            'title': wiki_result.get('title', ''),
            'document_id': '',
            'page_token': token,
            'articles': wiki_result['articles'],
            'source': 'wiki_api',
            'wiki_status': wiki_status,
            'wiki_debug': wiki_debug,
        }

    if 'error' not in wiki_result:
        # wiki API 可达但 wiki 树中确实无子 (no-children / list-empty)
        # 这是权威答案, 不回退到 <cite> 解析
        space_key = get_space_key(url_or_token) if '/' in str(url_or_token) else ''
        return {
            'title': wiki_result.get('title', ''),
            'document_id': '',
            'page_token': token,
            'articles': [],
            'source': 'wiki_api',
            'wiki_status': wiki_status,  # 'no-children' or 'list-empty'
            'wiki_debug': wiki_debug,
            'message': f'Wiki API 报告该节点无子文档 (status={wiki_status})',
        }

    # wiki API 报错 → 尝试 <cite> 解析 (老 fallback, 仅当 wiki 不可达时)
    print(f'[Server] Wiki API error: {wiki_result["error"][:100]}, falling back to <cite> parse', flush=True)
    data = run_lark_cli(token)
    if 'error' in data:
        return {
            **data,
            'source': 'lark_cli',
            'wiki_status': 'error',
            'wiki_debug': wiki_debug,
        }

    doc = data.get('data', {}).get('document', {})
    raw_content = doc.get('content', '')
    title = extract_title_from_markdown(raw_content)

    sub_docs = parse_cite_elements(raw_content)

    space_key = get_space_key(url_or_token) if '/' in str(url_or_token) else ''

    if sub_docs:
        if space_key:
            cache_root_for_space(space_key, token, len(sub_docs))

    if auto_find_root and space_key:
        cached_root = get_cached_root(space_key)
        if cached_root and cached_root != token:
            print(f'[Server] Auto-retrying with cached root: {cached_root}', flush=True)
            root_data = run_lark_cli(cached_root)
            if 'error' not in root_data:
                root_doc = root_data.get('data', {}).get('document', {})
                root_content = root_doc.get('content', '')
                root_sub_docs = parse_cite_elements(root_content)
                if root_sub_docs and len(root_sub_docs) > len(sub_docs):
                    return {
                        'title': extract_title_from_markdown(root_content),
                        'document_id': root_doc.get('document_id', ''),
                        'page_token': cached_root,
                        'articles': root_sub_docs,
                        'source': 'cite_fallback',
                        'wiki_status': wiki_status,
                        'wiki_debug': wiki_debug,
                    }

    return {
        'title': title,
        'document_id': doc.get('document_id', ''),
        'page_token': token,
        'articles': sub_docs,
        'source': 'cite_fallback',
        'wiki_status': wiki_status,
        'wiki_debug': wiki_debug,
    }


def parse_cite_elements(content):
    """
    从原始 Markdown 中解析 <cite> 元素，提取子文档列表。
    <cite doc-id="XXX" file-type="wiki" title="标题" type="doc"></cite>
    """
    articles = []
    seen_ids = set()

    pattern = r'<cite\s+([^>]*?)></cite>'
    attr_pattern = r'(\S+)="([^"]*)"'

    for match in re.finditer(pattern, content, flags=re.DOTALL):
        attrs_str = match.group(1)
        attrs = dict(re.findall(attr_pattern, attrs_str))

        title = attrs.get('title', '')
        doc_id = attrs.get('doc-id', '')

        if not title or not doc_id:
            continue
        if doc_id in seen_ids:
            continue
        seen_ids.add(doc_id)

        articles.append({
            'title': title,
            'doc_token': doc_id,
            'url': f'https://internal.feishu.cn/wiki/{doc_id}',
        })
    return articles


def extract_title_from_markdown(content):
    """从 Markdown 内容中提取第一个 H1 标题"""
    match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
    if match:
        return match.group(1).strip()
    return '未命名文档'


def extract_images(content):
    """从 Markdown 内容中提取图片 URL"""
    images = []
    pattern = r'!\[([^\]]*)\]\((https?://[^\)]+)\)'
    for match in re.finditer(pattern, content):
        alt = match.group(1)
        url = match.group(2)
        url_lower = url.lower()
        if any(skip in url_lower for skip in ['avatar', 'profile', '/icon', 'logo', 'emoj', 'badge', 'sticker', 'sprite', 'favicon']):
            continue
        ext = 'png'
        url_path = urlparse(url).path
        if '.' in url_path:
            possible_ext = url_path.rsplit('.', 1)[1].split('?')[0]
            if possible_ext in ('png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'):
                ext = possible_ext

        images.append({
            'url': url,
            'file_token': urlparse(url).path.rsplit('/', 1)[-1].split('?')[0],
            'alt': alt,
            'ext': ext
        })
    return images



def _fetch_sheet_raw(spreadsheet_token, sheet_id):
    """Inner impl: call lark-cli sheets +read, return parsed dict or error."""
    env = os.environ.copy()
    env['LARK_CLI_NO_PROXY'] = '1'

    cmd = [
        LARK_CLI, 'sheets', '+read',
        '--spreadsheet-token', spreadsheet_token,
        '--sheet-id', sheet_id,
        '--as', 'user',
        '--value-render-option', 'FormattedValue'
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=20, env=env)
    if result.returncode != 0:
        return {'error': f'lark-cli failed: {result.stderr}'}
    try:
        data = json.loads(result.stdout)
        if not data.get('ok'):
            return {'error': 'API returned not ok'}
        return data
    except json.JSONDecodeError as e:
        return {'error': f'JSON parse error: {e}'}


def fetch_sheet_content(spreadsheet_token, sheet_id):
    """读取飞书电子表格内容并转为 Markdown 表格 (含重试)"""
    data = run_lark_cli_limited(_fetch_sheet_raw, spreadsheet_token, sheet_id)

    if 'error' in data:
        return f'*(表格读取失败: {data["error"][:50]})*'

    values = data.get('data', {}).get('valueRange', {}).get('values', [])
    if not values or len(values) < 2:
        return f'*(空表格)*'

    try:
        # 转换为 Markdown 表格
        lines = []
        # Header row
        headers = [cell_to_text(cell) for cell in values[0]]
        lines.append('| ' + ' | '.join(headers) + ' |')
        # Separator
        lines.append('|' + '|'.join([' --- ' for _ in headers]) + '|')
        # Data rows
        for row in values[1:]:
            cells = []
            for cell in row:
                text = cell_to_text(cell)
                text = text.replace('\n', ' ').replace('|', '\\|')
                cells.append(text)
            # Pad to match header count
            while len(cells) < len(headers):
                cells.append('')
            lines.append('| ' + ' | '.join(cells[:len(headers)]) + ' |')

        return '\n\n' + '\n'.join(lines) + '\n\n'
    except Exception as e:
        return f'*(表格读取异常: {str(e)[:50]})*'


def replace_sheets_with_content(content):
    """将 <sheet> 标签替换为实际表格内容"""
    def replace_sheet(match):
        attrs_str = match.group(1)
        attrs = dict(re.findall(r'(\S+)="([^"]*)"', attrs_str))
        sheet_id = attrs.get('sheet-id', '')
        token = attrs.get('token', '')
        
        if not sheet_id or not token:
            return '\n\n*(内嵌电子表格 - 无法识别)*\n\n'
        
        print(f'[Server] Fetching sheet: {sheet_id} from {token[:20]}...')
        table_md = fetch_sheet_content(token, sheet_id)
        return table_md
    
    content = re.sub(
        r'<sheet\s+([^>]*?)></sheet>',
        replace_sheet,
        content,
        flags=re.DOTALL
    )
    return content


def clean_markdown(content):
    """清理飞书 API 返回的 Markdown 中的特殊标签"""
    # 0. 先处理表格单元格中的富文本段（Python 对象字符串 -> 纯文本）
    content = clean_rich_text_in_markdown(content)

    # 1. <callout emoji="X">...</callout> -> > **X** ...
    def replace_callout(match):
        emoji = match.group(1)
        inner = match.group(2)
        lines = inner.strip().split('\n')
        result = f'> **{emoji}**\n'
        for line in lines:
            result += f'> {line.strip()}\n'
        return result

    content = re.sub(
        r'<callout\s+emoji="([^"]*)">(.*?)</callout>',
        replace_callout,
        content,
        flags=re.DOTALL
    )

    # 2. 移除 <cite> 标签
    content = re.sub(r'<cite\s+[^>]*?></cite>', '', content)

    # 3. <sheet> -> 标记
    # 用实际表格内容替换 sheet 占位符
    content = replace_sheets_with_content(content)

    # 4. 清理多余空行
    content = re.sub(r'\n{4,}', '\n\n\n', content)

    # 5. 清理目录下空行
    content = re.sub(r'## 目录\n\n(?:-\s*\n)*', '## 目录\n\n', content)

    return content.strip()


def validate_open_folder_path(path):
    """校验 /open-folder 的 path 参数。返回 (is_valid, normalized_path_or_error_msg)。"""
    if not isinstance(path, str):
        return False, 'path 必须是字符串'
    path = path.strip()
    if not path:
        return False, '缺少 path 参数'
    if not os.path.isabs(path):
        return False, f'path 必须是绝对路径: {path}'
    if not os.path.isdir(path):
        return False, f'目录不存在: {path}'
    return True, path


def open_folder_in_os(path):
    """在系统文件管理器中打开目录。返回 (success: bool, system: str, error: str|None)。"""
    system = platform.system()
    try:
        if system == 'Darwin':
            subprocess.Popen(['open', path])
        elif system == 'Windows':
            # explorer.exe 返回码不稳定，用 Popen 异步启动
            subprocess.Popen(['explorer', os.path.normpath(path)])
        else:
            subprocess.Popen(['xdg-open', path])
        return True, system, None
    except FileNotFoundError as e:
        return False, system, f'找不到系统命令: {e.filename}'
    except Exception as e:
        return False, system, f'打开失败: {e}'


class FeishuHandler(BaseHTTPRequestHandler):

    def _set_headers(self, status=200, content_type='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _send_json(self, data, status=200):
        self._set_headers(status)
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def _read_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length > 0:
            return json.loads(self.rfile.read(content_length))
        return {}

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_GET(self):
        if self.path == '/health':
            self._send_json({'status': 'ok', 'service': 'feishu-crawler-server'})
        elif self.path.startswith('/ping'):
            try:
                result = subprocess.run([LARK_CLI, '--version'], capture_output=True, text=True, timeout=5)
                self._send_json({'status': 'ok', 'lark_cli': result.stdout.strip()})
            except Exception as e:
                self._send_json({'status': 'error', 'error': str(e)}, 500)
        else:
            self._send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        try:
            data = self._read_body()
        except json.JSONDecodeError:
            self._send_json({'error': 'Invalid JSON'}, 400)
            return

        if self.path == '/discover':
            self.handle_discover(data)
        elif self.path == '/extract':
            self.handle_extract(data)
        elif self.path == '/download-image':
            self.handle_download_image(data)
        elif self.path == '/open-folder':
            self.handle_open_folder(data)
        else:
            self._send_json({'error': 'Not found'}, 404)

    def handle_discover(self, data):
        url = data.get('url', '')
        token = data.get('token', '')

        target = url or token
        if not target:
            self._send_json({'error': 'No URL or token provided'}, 400)
            return

        print(f'[Server] Discovering sub-docs from: {target}')
        result = discover_sub_documents(target, auto_find_root=True)

        if 'error' in result:
            self._send_json(result, 500)
        else:
            self._send_json(result)

    def handle_extract(self, data):
        url = data.get('url', '')
        token = data.get('token', '')

        if not token and url:
            token = extract_token_from_url(url)

        if not token:
            self._send_json({'error': 'Cannot extract token from URL'}, 400)
            return

        print(f'[Server] Extracting doc: {token}')
        result = fetch_doc_content(token)

        if 'error' in result:
            self._send_json(result, 500)
        else:
            result['token'] = token
            self._send_json(result)


    def _download_image_impl(self, file_token, tmp_dir, tmp_name):
        """Inner impl for handle_download_image — wrapped with retry + limiter."""
        env = os.environ.copy()
        env['LARK_CLI_NO_PROXY'] = '1'
        cmd = [LARK_CLI, 'docs', '+media-preview', '--token', file_token, '--output', tmp_name, '--overwrite', '--as', 'user']
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env, cwd=tmp_dir)
        # Parse multi-line JSON from stdout
        output = result.stdout + result.stderr
        json_str = ''
        in_json = False
        depth = 0
        for ch in output:
            if ch == '{':
                in_json = True
                depth += 1
                json_str += ch
            elif ch == '}' and in_json:
                depth -= 1
                json_str += ch
                if depth == 0:
                    break
            elif in_json:
                json_str += ch

        if not json_str:
            return {'error': 'No JSON in output'}
        try:
            j = json.loads(json_str)
        except json.JSONDecodeError as e:
            return {'error': f'JSON parse error: {e}'}

        if not j.get('ok'):
            return {'error': 'API returned not ok'}

        sp = j.get('data', {}).get('saved_path', '')
        if not sp or not os.path.exists(sp) or os.path.getsize(sp) <= 100:
            return {'error': 'Preview file missing or too small'}

        with open(sp, 'rb') as f:
            img_data = base64.b64encode(f.read()).decode('ascii')
        return {'ok': True, 'data': img_data, 'size': os.path.getsize(sp)}

    def handle_download_image(self, data):
        file_token = data.get('file_token', '')
        if not file_token:
            self._send_json({'error': 'No file_token'}, 400)
            return
        import tempfile
        tmp_dir = tempfile.mkdtemp(prefix='feishu_img_')
        tmp_name = file_token[:16] + '.png'
        try:
            result = run_lark_cli_limited(self._download_image_impl, file_token, tmp_dir, tmp_name)
            if 'error' in result:
                self._send_json({'error': result['error']}, 500)
            else:
                self._send_json(result)
        except Exception as e:
            self._send_json({'error': str(e)[:200]}, 500)

    def handle_open_folder(self, data):
        valid, result = validate_open_folder_path(data.get('path') if isinstance(data, dict) else None)
        if not valid:
            self._send_json({'error': result}, 400)
            return
        success, system, err = open_folder_in_os(result)
        if success:
            self._send_json({'ok': True, 'path': result, 'system': system})
        else:
            self._send_json({'error': err, 'system': system}, 500)

    def log_message(self, format, *args):
        print(f'[Server] {args[0]}')


def main():
    global PORT

    parser = argparse.ArgumentParser(description='飞书文档爬取本地 API 服务')
    parser.add_argument('--port', type=int, default=PORT, help=f'监听端口 (默认: {PORT})')
    args = parser.parse_args()
    PORT = args.port

    server = ThreadingHTTPServer(('127.0.0.1', PORT), FeishuHandler)
    print(f'🚀 飞书文档爬取 API 服务已启动')
    print(f'   地址: http://127.0.0.1:{PORT}')
    print(f'   /discover - 发现子文档列表')
    print(f'   /extract  - 提取单个文档内容')
    print(f'   健康检查: http://127.0.0.1:{PORT}/health')
    print(f'   Ctrl+C 停止服务')
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务已停止')
        server.shutdown()


if __name__ == '__main__':
    main()
