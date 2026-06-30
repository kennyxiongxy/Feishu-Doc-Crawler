#!/usr/bin/env bash
# Linux 命令行启动脚本
# 作用：切换到项目根目录并启动飞书文档爬取 API 服务

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

if [ -f "$PROJECT_DIR/.venv/bin/python3" ]; then
    PYTHON="$PROJECT_DIR/.venv/bin/python3"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
else
    echo "错误：未找到 python3，请先安装 Python 3.9+"
    exit 1
fi

exec "$PYTHON" feishu_server.py "$@"
