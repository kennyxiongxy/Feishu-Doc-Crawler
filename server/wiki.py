"""飞书文档爬取 - Wiki API 发现、缓存与回退。"""

import json
import os
import threading
from datetime import datetime
from urllib.parse import urlparse


# 空间 -> 根页面 token 缓存（持久化到文件）
_CACHE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.space_cache.json')
_space_root_cache = {}
_cache_lock = threading.RLock()


def _load_cache():
    """从文件加载缓存的映射"""
    global _space_root_cache
    try:
        if os.path.exists(_CACHE_FILE):
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


def run_wiki_node_get(lark_cli, run_lark_cli_raw, token_or_url):
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
            lark_cli, 'wiki', '+node-get',
            '--node-token', token_or_url,
            '--as', 'user',
            '--format', 'json'
        ]
        return run_lark_cli_raw(lark_cli, cmd)

    # 步骤 2: 原始 token — 先用 --node-token (lark-cli 1.0.48+ 推荐)
    cmd = [
        lark_cli, 'wiki', '+node-get',
        '--node-token', token_or_url,
        '--as', 'user',
        '--format', 'json'
    ]
    result = run_lark_cli_raw(lark_cli, cmd)
    if result.get('ok'):
        return result
    if not _is_obj_type_missing_error(result):
        return result
    # 步骤 3: 缺 --obj-type → 加 --obj-type docx 重试
    _wiki_log('wiki_api: node-get 缺 --obj-type, 重试加 --obj-type docx')
    cmd2 = list(cmd) + ['--obj-type', 'docx']
    return run_lark_cli_raw(lark_cli, cmd2)


def run_wiki_node_list(lark_cli, run_lark_cli_raw, space_id, parent_token):
    """List wiki nodes under a parent node.

    v5.10.2: 同样在缺 --obj-type 时自动重试. 这里 parent_token
    必须是 +node-get 返回的 node_token (不能用 obj_token 也不能是 URL).

    默认 +node-list 返回单页（最多 50 条）。之前尝试过 --page-all --page-limit 0，
    但实际运行中出现只返回一条/一页的问题，因此先恢复为单页获取；后续如需
    超过 50 条再实现手动翻页。
    """
    cmd = [
        lark_cli, 'wiki', '+node-list',
        '--space-id', space_id,
        '--parent-node-token', parent_token,
        '--as', 'user',
        '--format', 'json'
    ]
    result = run_lark_cli_raw(lark_cli, cmd, timeout=15)
    if result.get('ok'):
        return result
    if not _is_obj_type_missing_error(result):
        return result
    _wiki_log('wiki_api: node-list 缺 --obj-type, 重试加 --obj-type docx')
    cmd2 = list(cmd) + ['--obj-type', 'docx']
    return run_lark_cli_raw(lark_cli, cmd2, timeout=15)


def _wiki_log(msg):
    """wiki API 日志 — 写到 /tmp/feishu_server_wiki.log, 同时 stdout 备用"""
    line = f'[{datetime.now().isoformat(timespec="seconds")}] {msg}'
    try:
        with open('/tmp/feishu_server_wiki.log', 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass
    print(f'[Server] {msg}', flush=True)


def discover_via_wiki_api(lark_cli, run_lark_cli_raw, token_or_url):
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
    node_data = run_wiki_node_get(lark_cli, run_lark_cli_raw, token_or_url)

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
    parent_node_token = node.get('parent_node_token', '')

    if not space_id:
        return {
            'error': 'No space_id found',
            'source': 'wiki_api',
            'wiki_status': 'error',
            'wiki_debug': {'node_get_raw': node_data, 'step': 'no-space-id'},
        }

    # Step 2: 取当前节点下的子文档；如果当前节点没有子文档且是空间根节点
    # （parent_node_token 为空），则退一步列出该空间下所有根节点作为同级目录。
    # 这种 Wiki 空间的顶层文档本身没有子节点，用户打开其中一篇时期望看到全部章节。
    if not has_child and parent_node_token == '':
        _wiki_log(f'wiki_api: current node has no children and is root-level, '
                  f'listing root nodes of space {space_id[:16]}...')
        list_data = run_wiki_node_list(lark_cli, run_lark_cli_raw, space_id, '')

        if 'error' in list_data:
            _wiki_log(f'wiki_api: root node-list failed: {list_data["error"][:100]}')
            return {
                'error': list_data['error'],
                'source': 'wiki_api',
                'wiki_status': 'error',
                'wiki_debug': {'node_get_raw': node_data, 'node_list_raw': list_data,
                               'has_child': False, 'step': 'root-node-list'},
            }

        if not list_data.get('ok'):
            return {
                'error': 'Wiki root node-list API returned not ok',
                'source': 'wiki_api',
                'wiki_status': 'error',
                'wiki_debug': {'node_get_raw': node_data, 'node_list_raw': list_data,
                               'has_child': False, 'step': 'root-node-list-ok'},
            }

        raw_data = list_data.get('data', {}) or {}
        nodes = (raw_data.get('nodes')
                 or raw_data.get('items')
                 or raw_data.get('children')
                 or raw_data.get('list')
                 or [])
        _wiki_log(f'wiki_api: root +node-list returned {len(nodes)} nodes')

        articles = []
        for n in nodes:
            node_token = n.get('node_token') or n.get('token') or ''
            if not node_token:
                continue
            # 根节点平铺列出，标记 has_child=false 避免前端再次展开时递归列出同级
            articles.append({
                'title': n.get('title', ''),
                'doc_token': node_token,
                'url': f'https://internal.feishu.cn/wiki/{node_token}',
                'has_child': False,
                'obj_token': n.get('obj_token', ''),
            })

        status = 'ok' if articles else 'list-empty'
        _wiki_log(f'wiki_api: status={status} found {len(articles)} root nodes')
        return {
            'title': title,
            'space_id': space_id,
            'page_token': token,
            'articles': articles,
            'source': 'wiki_api',
            'wiki_status': status,
            'wiki_debug': {'node_get_raw': node_data, 'node_list_raw': list_data,
                           'has_child': False, 'is_space_root': True,
                           'nodes_count': len(nodes), 'articles_count': len(articles)},
        }

    if not has_child:
        _wiki_log(f'wiki_api: has_child=false for {token[:16]} (no children per API)')
        return {
            'title': title, 'articles': [], 'source': 'wiki_api',
            'wiki_status': 'no-children',
            'wiki_debug': {'node_get_raw': node_data, 'has_child': False,
                           'space_id': space_id, 'node_list_raw': None},
        }

    # Step 3: List all children of the current node
    _wiki_log(f'wiki_api: listing children of {token[:16]} (space={space_id[:16]}...)')
    list_data = run_wiki_node_list(lark_cli, run_lark_cli_raw, space_id, token)

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


def discover_sub_documents(lark_cli, run_lark_cli, run_lark_cli_raw, markdown_module,
                           url_or_token, auto_find_root=False):
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
    wiki_result = discover_via_wiki_api(lark_cli, run_lark_cli_raw, url_or_token)
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
    data = run_lark_cli(lark_cli, token)
    if 'error' in data:
        return {
            **data,
            'source': 'lark_cli',
            'wiki_status': 'error',
            'wiki_debug': wiki_debug,
        }

    doc = data.get('data', {}).get('document', {})
    raw_content = doc.get('content', '')
    title = markdown_module.extract_title_from_markdown(raw_content)

    sub_docs = markdown_module.parse_cite_elements(raw_content)

    space_key = get_space_key(url_or_token) if '/' in str(url_or_token) else ''

    if sub_docs:
        if space_key:
            cache_root_for_space(space_key, token, len(sub_docs))

    if auto_find_root and space_key:
        cached_root = get_cached_root(space_key)
        if cached_root and cached_root != token:
            print(f'[Server] Auto-retrying with cached root: {cached_root}', flush=True)
            root_data = run_lark_cli(lark_cli, cached_root)
            if 'error' not in root_data:
                root_doc = root_data.get('data', {}).get('document', {})
                root_content = root_doc.get('content', '')
                root_sub_docs = markdown_module.parse_cite_elements(root_content)
                if root_sub_docs and len(root_sub_docs) > len(sub_docs):
                    return {
                        'title': markdown_module.extract_title_from_markdown(root_content),
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
