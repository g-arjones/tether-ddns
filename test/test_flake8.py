"""Test that the package passes flake8 checks."""
import subprocess
from pathlib import Path

import pytest


@pytest.mark.linter
@pytest.mark.flake8
def test_flake8() -> None:
    """Run flake8 over the package and assert no errors are found."""
    package_path = Path(__file__).parent.parent
    rc = subprocess.run(['flake8'], capture_output=False, cwd=package_path).returncode
    assert rc == 0, 'Found code style errors / warnings'
