"""飞书文档爬取 - 打开保存文件夹。"""

import os
import platform
import subprocess


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
