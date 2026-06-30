"""Shared fixtures for feishu_server tests."""
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SERVER_PATH = ROOT / "server"

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
    for cache_dir in (ROOT, ROOT / "tests", ROOT / "server"):
        for name in ("__pycache__", ".pytest_cache"):
            target = cache_dir / name
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)


@pytest.fixture(scope="module")
def server_module():
    """Import the feishu_server compatibility entry point and reload it.

    feishu_server.py re-exports the split server/ package API so that
    existing tests keep working without being rewritten. We reload the
    entry point (and any cached server sub-modules) so each test module
    gets a fresh import.
    """
    # Make sure project root is importable
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))

    # Remove any cached server modules so the import is fresh
    for name in list(sys.modules.keys()):
        if name == "feishu_server" or name == "server" or name.startswith("server."):
            del sys.modules[name]

    import feishu_server
    return feishu_server
