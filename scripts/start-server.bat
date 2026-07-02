@echo off
chcp 65001 > nul
:: Windows 双击启动脚本
:: 作用：切换到项目根目录并启动飞书文档爬取 API 服务

setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "PROJECT_DIR=%SCRIPT_DIR%.."

cd /d "%PROJECT_DIR%"

if exist "%PROJECT_DIR%\.venv\Scripts\python.exe" (
    set "PYTHON=%PROJECT_DIR%\.venv\Scripts\python.exe"
) else if exist "%PROJECT_DIR%\.venv\bin\python.exe" (
    set "PYTHON=%PROJECT_DIR%\.venv\bin\python.exe"
) else (
    where python > nul 2> nul
    if %errorlevel% == 0 (
        set "PYTHON=python"
    ) else (
        echo 错误：未找到 python，请先安装 Python 3.9+
        pause
        exit /b 1
    )
)

echo 使用 Python: %PYTHON%
echo 启动飞书文档爬取 API 服务...
echo.

"%PYTHON%" feishu_server.py %*

pause
