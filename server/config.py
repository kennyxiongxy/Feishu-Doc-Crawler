"""飞书文档爬取 - 服务端配置与常量。"""

import os
import re
import shutil


def resolve_lark_cli_path():
    """自动检测 lark-cli 路径。

    优先级:
      1) LARK_CLI 环境变量
      2) shutil.which('lark-cli')
      3) 常见 Homebrew 路径
      4) 保留原默认路径，便于产生可识别的错误信息
    """
    candidates = [
        os.environ.get('LARK_CLI'),
        shutil.which('lark-cli'),
        '/opt/homebrew/bin/lark-cli',
        '/usr/local/bin/lark-cli',
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    # 兜底：返回原默认值，让后续调用给出清晰的 "file not found" 错误
    return '/opt/homebrew/bin/lark-cli'


LARK_CLI = resolve_lark_cli_path()
PORT = int(os.environ.get('FEISHU_CRAWLER_PORT', 8765))

LARK_CLI_MIN_VERSION = (1, 0, 48)


def parse_lark_cli_version(output):
    """从 lark-cli --version 输出解析版本元组，例如 '1.0.53' -> (1, 0, 53)"""
    if not output:
        return None
    m = re.search(r'(\d+)\.(\d+)\.(\d+)', output)
    if not m:
        return None
    return tuple(int(x) for x in m.groups())


def get_lark_cli_version():
    """获取 lark-cli 版本，失败返回 None。"""
    import subprocess
    try:
        result = subprocess.run(
            [LARK_CLI, '--version'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return parse_lark_cli_version(result.stdout.strip())
    except Exception:
        pass
    return None


def is_lark_cli_version_ok(version_tuple):
    """检查 lark-cli 版本是否满足最低要求。"""
    if not version_tuple:
        return False
    return version_tuple >= LARK_CLI_MIN_VERSION
