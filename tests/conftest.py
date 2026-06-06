"""Shared fixtures for feishu_server tests."""
import importlib.util
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SERVER_PATH = ROOT / "feishu_server.py"

sys.dont_write_bytecode = True


def pytest_sessionfinish(session, exitstatus):
    """Remove __pycache__ dirs created during the test run.

    Chrome refuses to load unpacked extensions when the extension root
    contains a file or directory whose name starts with '_' (it reserves
    those names for system use). Pytest writes .pyc files into a sibling
    __pycache__/ alongside every imported module, including the project
    root when it imports the single-file server module. Clean them up
    so reloading the extension never trips on leftover bytecode.
    """
    for cache_dir in (ROOT, ROOT / "tests"):
        for name in ("__pycache__", ".pytest_cache"):
            target = cache_dir / name
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)


@pytest.fixture(scope="module")
def server_module():
    """Import feishu_server.py as a module and reload it for isolation.

    The server is a single-file script (no package), so we use importlib
    to load it by file path. We also clean it out of sys.modules first
    to guarantee a fresh import per test module.
    """
    if "feishu_server" in sys.modules:
        del sys.modules["feishu_server"]
    spec = importlib.util.spec_from_file_location("feishu_server", SERVER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
