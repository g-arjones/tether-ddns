# Configurable server host & port — design

## Goal

Make the uvicorn bind **host** and **port** configurable at deployment time.
The port is currently hardcoded in `tether_ddns/__main__.py`
(`uvicorn.run(create_app(), host='0.0.0.0', port=8000)`). This matters
especially under `network_mode: host` in Docker, where Docker port remapping is
unavailable and the real bind port must change.

## Configuration precedence

Highest to lowest: **CLI flag → environment variable → default**.

This lets Docker/compose set env vars while still allowing a one-off CLI
override during local runs.

| Setting | CLI flag | Env var             | Default   |
| ------- | -------- | ------------------- | --------- |
| Host    | `--host` | `TETHER_DDNS_HOST`  | `0.0.0.0` |
| Port    | `--port` | `TETHER_DDNS_PORT`  | `8000`    |

## Implementation

Location: `tether_ddns/__main__.py`. CLI parsing uses stdlib `argparse`
(no new dependency; free `--help` and `--port` int validation).

Extract a small **pure, testable** resolver so the resolution logic is covered
without starting a real server:

```python
def resolve_bind(cli_host: str | None, cli_port: int | None) -> tuple[str, int]:
    host = cli_host if cli_host is not None else os.environ.get('TETHER_DDNS_HOST', '0.0.0.0')
    if cli_port is not None:
        port = cli_port
    else:
        env_port = os.environ.get('TETHER_DDNS_PORT')
        port = int(env_port) if env_port else 8000
    return host, port
```

`main()` stays thin and keeps `# pragma: no cover`:

```python
def main() -> None:  # pragma: no cover - starts a real server
    parser = argparse.ArgumentParser(prog='tether_ddns')
    parser.add_argument('--host')
    parser.add_argument('--port', type=int)
    args = parser.parse_args()
    host, port = resolve_bind(args.host, args.port)
    uvicorn.run(create_app(), host=host, port=port)
```

## Error handling

An invalid env port (e.g. `TETHER_DDNS_PORT=abc`) lets `int()` raise
`ValueError` and crash on startup — fail-fast, no silent fallback.

## Testing

Unit tests for `resolve_bind` (monkeypatching env):

- CLI value wins over env and default (host and port).
- Env value wins over default when no CLI value.
- Default fallback when neither CLI nor env is set.
- Invalid env port raises `ValueError`.

`main()` remains uncovered by design.

## Docs & Docker

- README **Configuration** section: document `TETHER_DDNS_HOST` and
  `TETHER_DDNS_PORT`.
- `docker-compose.yml`: mention the env vars in the comment near the
  `network_mode: host` guidance, since that's where changing the bind port
  actually matters.

## Out of scope

No changes to `AppConfig` / `ConfigStore`. Server bind settings are a
deployment concern, not persisted application config.
