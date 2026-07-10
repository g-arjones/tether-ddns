"""Test that the package passes mypy checks."""
import subprocess
from pathlib import Path

import pytest


@pytest.mark.linter
@pytest.mark.mypy
def test_mypy() -> None:
    """Run mypy over the package and assert no errors are found."""
    package_path = Path(__file__).parent.parent
    rc = subprocess.run(['mypy', '.'], capture_output=False, cwd=package_path).returncode
    assert rc == 0, 'Found type checking errors / warnings'
