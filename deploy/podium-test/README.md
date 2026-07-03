# Podium Test Environment

This directory contains the single-node test deployment for Podium.

Current test environment:

- URL: `https://podium.hallu.info`
- Origin: `52.68.15.209`
- Host path: `/opt/podium`
- Runtime: Docker Compose, with Nginx bound to origin HTTP port `80`

The intended flow is:

1. GitHub Actions publishes `ghcr.io/hallucination-studio/symphony-podium:latest`, `:beta`, and `:<git-sha>` on every `main` push.
2. The Lightsail host runs Docker Compose with Nginx, Podium, PostgreSQL, Redis, and Watchtower.
3. Watchtower watches only labeled containers and updates the Podium container when the `beta` image digest changes.
4. Cloudflare terminates TLS. The origin exposes Podium over HTTP.

## Bootstrap Ubuntu

From a fresh Ubuntu host:

```bash
sudo bash deploy/podium-test/bootstrap-ubuntu.sh
```

Or from a remote checkout:

```bash
curl -fsSL https://raw.githubusercontent.com/hallucination-studio/symphony/main/deploy/podium-test/bootstrap-ubuntu.sh | sudo bash
```

The script installs Git, Docker Engine, the Docker Compose plugin, creates a `dev`
user, creates a 2GB swap file, applies Redis-friendly kernel settings, opens
port `80/tcp`, and copies the Compose files into `/opt/podium`.

## Configure

Edit `/opt/podium/.env` before starting services:

```bash
sudo editor /opt/podium/.env
```

Required values:

- `PODIUM_DOMAIN`
- `PODIUM_BASE_URL`
- `PODIUM_SECRET_KEY`
- `POSTGRES_PASSWORD`

Linear settings are optional until OAuth/webhook testing is needed.

## Start

```bash
cd /opt/podium
docker compose pull
docker compose up -d
docker compose ps
```

Health check:

```bash
curl -fsS https://$PODIUM_DOMAIN/api/v1/health
```

For Cloudflare, point DNS at the server and enable proxying. Use Cloudflare SSL
mode `Flexible` when the origin is plain HTTP-only. The default
`PODIUM_HTTP_BIND=0.0.0.0:80` binds Nginx to the origin's HTTP port and proxies
to Podium on the Docker network.

Compose applies Docker `json-file` log rotation to every service:

```yaml
max-size: 10m
max-file: 3
```

## GHCR Access

The test host tracks:

```env
PODIUM_IMAGE=ghcr.io/hallucination-studio/symphony-podium:beta
```

If the package is public, no Docker login is required. If GHCR returns
`unauthorized`, make the package public in GitHub Packages or log in on the host
with a GitHub token that has `read:packages`.

After access works:

```bash
cd /opt/podium
docker compose pull podium
docker compose up -d podium watchtower
curl -fsS http://127.0.0.1/api/v1/health
```
