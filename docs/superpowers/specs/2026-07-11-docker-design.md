# Dockerfile and docker-compose — Design Spec

**Date:** 2026-07-11
**Status:** Approved

## Overview

Provide a container image and a `docker-compose.yml` that auto-builds it, so the
app can be run with a single `docker compose up`. The image is multi-stage on an
Alpine base to keep the final size small, builds the frontend and installs the
Python package, and runs `python -m tether_ddns` on port 8000 as a non-root
user, persisting config to a mounted volume.

## Dockerfile (multi-stage, Alpine)

**Stage 1 — frontend build (`node:22-alpine`):**
- Workdir `/app/frontend`; copy `frontend/package.json` + `frontend/package-lock.json`; `npm ci`.
- Copy the rest of `frontend/` and the `tether_ddns/` package dir (Vite's
  `outDir` is `../tether_ddns/static`).
- `npm run build` → emits static assets into `/app/tether_ddns/static`.

**Stage 2 — python build (`python:3.12-alpine`):**
- Install build deps needed for musl wheels: `build-base`, `gcc`, `musl-dev`,
  `libffi-dev` (aiohttp, aiodns/pycares, pydantic-core may compile). Install
  `uv` (via `pip install uv`).
- Copy `pyproject.toml`, `uv.lock`, `README.md`, and the `tether_ddns/` package
  (including the built `static/` copied from stage 1).
- Create a venv at `/opt/venv` and install the project into it with `uv`
  (`uv pip install --python /opt/venv/bin/python .`). No dev dependencies.

**Stage 3 — runtime (`python:3.12-alpine`):**
- Install only runtime shared libs if required (e.g. `libstdc++`); no compilers.
- Copy `/opt/venv` from stage 2 and the app code (`tether_ddns/` with `static/`).
- Create a non-root user (e.g. `app`), `mkdir /data` owned by it.
- `ENV PATH=/opt/venv/bin:$PATH`, `TETHER_DDNS_CONFIG_PATH=/data/tether-ddns.json`,
  `PYTHONUNBUFFERED=1`.
- `EXPOSE 8000`; `USER app`; `CMD ["python", "-m", "tether_ddns"]`.

## `.dockerignore`

Exclude: `.venv`, `frontend/node_modules`, `frontend/dist`,
`tether_ddns/static` (rebuilt in-image), `.git`, `__pycache__`, `.mypy_cache`,
`.pytest_cache`, `htmlcov`, `.coverage`, `docs`, `test`, `frontend/coverage`,
`frontend/playwright-report`, `frontend/test-results`, `tether-ddns.json`, and
`.superpowers`.

## `docker-compose.yml`

- One service `tether-ddns` with `build: .`.
- `ports: ["8000:8000"]`.
- Named volume `tether-config` mounted at `/data` (persists the JSON config).
- `restart: unless-stopped`.
- A commented `# network_mode: host` note explaining it can improve router/LAN
  reachability and public-IP detection (with published-port bridge as the
  default).

## Verification

This feature ships infrastructure files; verification is manual (no unit tests):

- `docker compose build` completes successfully.
- `docker compose up -d` then `curl -sf http://localhost:8000/` returns the SPA
  HTML and `curl -sf http://localhost:8000/api/hooks` returns JSON.
- The final image is reasonably small (Alpine + a single venv; record the
  `docker images` size in the plan's verification step, no hard threshold).
- Config persists across `docker compose down && up` via the named volume.

The existing test suites are unaffected and must still pass.

## Out of Scope

- Publishing the image to a registry or CI wiring.
- A production reverse proxy / TLS termination setup.
- Multi-arch builds (document as a possible follow-up only).
