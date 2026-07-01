#!/usr/bin/env python3
"""
飞书文档爬取 - 本地 API 服务（兼容入口）

核心实现已迁移到 server/ 包。本文件保留作为向后兼容的入口点，
原有 `python3 feishu_server.py` 启动方式继续生效。

启动方式：
    python3 feishu_server.py
    python3 -m server
    python3 feishu_server.py --port 8765
"""

# 导出底层模块/常量，保持旧测试 `from feishu_server import x` 有效
from server import config, lark_client, markdown, wiki, folders, images  # noqa: F401
from server.app import FeishuHandler, main  # noqa: F401
from server.config import (  # noqa: F401
    LARK_CLI,
    PORT,
    LARK_CLI_MIN_VERSION,
    get_lark_cli_version,
    is_lark_cli_version_ok,
    parse_lark_cli_version,
    resolve_lark_cli_path,
)
from server.folders import open_folder_in_os, validate_open_folder_path  # noqa: F401
from server.images import _download_image_impl  # noqa: F401
from server.lark_client import (  # noqa: F401
    PERMANENT_LARK_CODES,
    _extract_lark_code,
    _lark_cli_semaphore,
    fetch_doc_content,
    is_retryable_failure,
    run_lark_cli,
    run_lark_cli_limited,
    run_lark_cli_raw,
    with_retry,
)
from server.markdown import (  # noqa: F401
    cell_to_text,
    clean_rich_text_in_markdown,
    extract_images,
    extract_title_from_markdown,
    parse_cite_elements,
)
from server.wiki import (  # noqa: F401
    _space_root_cache,
    cache_root_for_space,
    discover_via_wiki_api,
    extract_token_from_url,
    get_base_url,
    get_cached_root,
    get_space_key,
    _is_obj_type_missing_error,
    _is_wiki_url,
)


# 向后兼容：旧测试直接调用 clean_markdown(content)
def clean_markdown(content):
    """清理 Markdown，使用默认 lark-cli 与并发限流器。"""
    return markdown.clean_markdown(content, LARK_CLI, run_lark_cli_limited)


# 向后兼容：旧签名 discover_sub_documents(url_or_token, auto_find_root=False)
def discover_sub_documents(url_or_token, auto_find_root=False):
    """发现子文档，使用默认 lark-cli 与 markdown 模块。"""
    from server import lark_client as _lark_client
    from server import markdown as _markdown
    return wiki.discover_sub_documents(
        LARK_CLI, _lark_client.run_lark_cli, _lark_client.run_lark_cli_raw,
        _markdown, url_or_token, auto_find_root=auto_find_root
    )


# 向后兼容：测试代码 `server_module.subprocess.Popen`
# 向后兼容：测试代码 `server_module.ThreadingHTTPServer`
# 向后兼容：测试代码 `server_module.platform.system`
# 向后兼容：测试代码 `server_module._CACHE_FILE`
import subprocess  # noqa: E402, F401
from http.server import ThreadingHTTPServer  # noqa: E402, F401
import platform  # noqa: E402, F401
_CACHE_FILE = wiki._CACHE_FILE


if __name__ == '__main__':
    main()
