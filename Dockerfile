# syntax=docker/dockerfile:1

# --- Stage 1: build the frontend ---
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Vite emits to ../tether_ddns/static (outDir), so provide the package dir.
COPY tether_ddns/ /app/tether_ddns/
RUN npm run build

# --- Stage 2: install the Python package into a venv ---
FROM python:3.12-alpine AS builder
RUN apk add --no-cache build-base gcc musl-dev libffi-dev \
    && pip install --no-cache-dir uv
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY tether_ddns/ ./tether_ddns/
# Bring in the built static assets from stage 1.
COPY --from=frontend /app/tether_ddns/static ./tether_ddns/static
RUN uv sync --no-dev

# --- Stage 3: slim runtime ---
FROM python:3.12-alpine AS runtime
RUN apk add --no-cache libstdc++ \
    && adduser -D -h /home/app app \
    && mkdir /data && chown app:app /data
COPY --from=builder /app /app
ENV PATH=/app/.venv/bin:$PATH \
    TETHER_DDNS_CONFIG_PATH=/data/tether-ddns.json \
    PYTHONUNBUFFERED=1
WORKDIR /app
EXPOSE 8000
USER app
CMD ["tether-ddns"]
