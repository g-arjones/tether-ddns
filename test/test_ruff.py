"""Test that the package passes ruff checks."""
import subprocess
from pathlib import Path

import pytest


@pytest.mark.linter
@pytest.mark.ruff
def test_ruff() -> None:
    """Run ruff over the package and assert no errors are found."""
    package_path = Path(__file__).parent.parent
    rc = subprocess.run(['ruff', 'check'], capture_output=False, cwd=package_path).returncode
    assert rc == 0, 'Found code style errors / warnings'
