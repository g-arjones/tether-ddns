"""Console entrypoint: run the app with uvicorn."""
from __future__ import annotations

from tether_ddns.app import create_app

import uvicorn


def main() -> None:  # pragma: no cover - starts a real server
    """Run the FastAPI app under uvicorn."""
    uvicorn.run(create_app(), host='0.0.0.0', port=8000)  # noqa: S104


if __name__ == '__main__':
    main()
