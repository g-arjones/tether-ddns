"""Console entrypoint: run the app with uvicorn."""
from __future__ import annotations

import argparse
import os

from tether_ddns.app import create_app

import uvicorn

HOST_ENV = 'TETHER_DDNS_HOST'
PORT_ENV = 'TETHER_DDNS_PORT'
DEFAULT_HOST = '0.0.0.0'  # noqa: S104
DEFAULT_PORT = 8000


def resolve_bind(
    cli_host: str | None, cli_port: int | None,
) -> tuple[str, int]:
    """Resolve bind host/port: CLI flag > env var > default."""
    host = cli_host if cli_host is not None else os.environ.get(
        HOST_ENV, DEFAULT_HOST,
    )
    if cli_port is not None:
        port = cli_port
    else:
        env_port = os.environ.get(PORT_ENV)
        port = int(env_port) if env_port else DEFAULT_PORT
    return host, port


def main() -> None:  # pragma: no cover - starts a real server
    """Run the FastAPI app under uvicorn."""
    parser = argparse.ArgumentParser(prog='tether-ddns')
    parser.add_argument('--host', help=f'bind host (env {HOST_ENV})')
    parser.add_argument(
        '--port', type=int, help=f'bind port (env {PORT_ENV})',
    )
    args = parser.parse_args()
    host, port = resolve_bind(args.host, args.port)
    uvicorn.run(create_app(), host=host, port=port)


if __name__ == '__main__':
    main()
