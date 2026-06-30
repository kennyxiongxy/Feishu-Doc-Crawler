#!/usr/bin/env bash
# macOS 双击启动脚本
# 作用：切换到项目根目录并启动飞书文档爬取 API 服务

set -e

# 获取脚本所在目录，再切换到项目根目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# 优先使用项目虚拟环境，否则回退到系统 python3
if [ -f "$PROJECT_DIR/.venv/bin/python3" ]; then
    PYTHON="$PROJECT_DIR/.venv/bin/python3"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
else
    echo "错误：未找到 python3，请先安装 Python 3.9+"
    read -r
    exit 1
fi

echo "使用 Python: $PYTHON"
echo "启动飞书文档爬取 API 服务..."
echo ""

exec "$PYTHON" feishu_server.py "$@"
