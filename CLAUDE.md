# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Controls Chromecast devices over HTTP. Three components — each has its own `CLAUDE.md`:

- **`catt_bff/`** — Cloudflare Worker (TypeScript). Google Home C2C, per-device play queues via Durable Objects, Slack/Telegram webhooks, `POST /catt` endpoint. Deployed at `ghc.manojbaba.com`.
- **`catt_server/`** — Flask REST API (Python). Wraps the `catt` CLI. Runs on a Raspberry Pi inside Docker on the LAN, exposed via Cloudflare Tunnel.
- **`redirect/`** — Cloudflare Worker (JavaScript). URL shortener/redirect service. Deployed at `r.manojbaba.com`.

## Architecture

```
Google Assistant / Slack / Telegram
         │
         ▼
  catt_bff  (Cloudflare Worker — ghc.manojbaba.com)
         │  Cloudflare Tunnel
         ▼
  catt_server  (LAN, Docker, port 5000)
         │
         ▼
  Chromecast devices (mDNS)
```

## Raspberry Pi dotfiles

`dotfiles/` contains the systemd service units and config files that run on the Pi. They are deployed by symlinking or copying to `/home/pi/dotfiles/`.

### `dotfiles/catt/`

| File | Purpose |
|---|---|
| `catt.cfg` | `catt` CLI config — sets default device (`k`) and all device aliases (k/o/b/z/zob/zok/zbk/otv/tv). Mounted into the Docker container at `/root/.config/catt/catt.cfg`. |
| `.env` | Contains `CATT_SERVER_SECRET` — injected into the container via `EnvironmentFile`. |
| `catt.service` | systemd unit that runs `dmanojbaba/catt:latest` with `--network host` (required for mDNS) and mounts `catt.cfg`. Restarts always. |
| `catt.sh` | Helper script to exec `catt` commands inside the running container. If `$2` starts with `http`, runs `catt -d $1 cast $2`; otherwise passes all args directly. |

### `dotfiles/cloudflared/`

| File | Purpose |
|---|---|
| `cloudflared.service` | systemd unit that runs `cloudflare/cloudflared:latest` tunnel with `--network host`. Exposes `catt_server` to the internet. |
| `.env` | Contains `CLOUDFLARED_TOKEN` — injected via `EnvironmentFile`. |

### Deploying to the Pi

Services are managed with standard systemd commands:
```bash
sudo systemctl enable /home/pi/dotfiles/catt/catt.service
sudo systemctl start catt

sudo systemctl enable /home/pi/dotfiles/cloudflared/cloudflared.service
sudo systemctl start cloudflared
```

## CI/CD

All workflows live in `.github/workflows/`:

| Workflow | Trigger | Actions |
|---|---|---|
| `catt-bff.yml` | Push/PR to `catt_bff/**`, manual | PR: vitest + wrangler dry-run. Merge: vitest + deploy |
| `catt-server.yml` | Push/PR to `catt_server/**`, weekly, manual | PR: pytest + build image. Merge: pytest + build + push to Docker Hub |
| `redirect.yml` | Push/PR to `redirect/**`, manual | Deploy |

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.
