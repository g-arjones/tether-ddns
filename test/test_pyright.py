"""Test that the package passes pyright checks."""
import subprocess
from pathlib import Path

import pytest


@pytest.mark.pyright
@pytest.mark.linter
def test_pyright() -> None:
    """Run pyright over the package and assert no errors are found."""
    package_path = Path(__file__).parent.parent
    rc = subprocess.run(['pyright'], capture_output=False, cwd=package_path).returncode
    assert rc == 0, 'Found type checking errors / warnings'
