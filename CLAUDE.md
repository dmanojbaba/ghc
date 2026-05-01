# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Controls Chromecast devices over HTTP. Four components — each has its own `CLAUDE.md`:

- **`catt_bff/`** — Cloudflare Worker (TypeScript). Google Home C2C, per-device play queues via Durable Objects, Slack/Telegram webhooks, `POST /catt` endpoint. Deployed at `bff.example.com`.
- **`catt_backend/`** — Flask REST API (Python). Wraps the `catt` CLI. Runs on a Raspberry Pi inside Docker on the LAN, exposed via Cloudflare Tunnel.
- **`catt_frontend/`** — Cloudflare Pages (TypeScript + HTML). Web UI with a kids view (preset buttons + playback controls) and an admin view (full control surface). PIN auth for kids, password auth for admin.
- **`redirect/`** — Cloudflare Worker (JavaScript). URL shortener/redirect service. Deployed at `redirect.example.com`.


## Architecture

```
Browser / Google Assistant / Slack / Telegram
         │
         ├── catt_frontend  (Cloudflare Pages — kids + admin web UI)
         │         │
         ▼         ▼
  catt_bff  (Cloudflare Worker — bff.example.com)
         │  Cloudflare Tunnel
         ▼
  catt_backend  (LAN, Docker, port 5000)
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
| `.env` | Contains `CATT_BACKEND_SECRET` — injected into the container via `EnvironmentFile`. |
| `catt.service` | systemd unit that runs `dmanojbaba/catt:latest` with `--network host` (required for mDNS) and mounts `catt.cfg`. Restarts always. |
| `catt.sh` | Helper script to exec `catt` commands inside the running container. If `$2` starts with `http`, runs `catt -d $1 cast $2`; otherwise passes all args directly. |

### `dotfiles/cloudflared/`

| File | Purpose |
|---|---|
| `cloudflared.service` | systemd unit that runs `cloudflare/cloudflared:latest` tunnel with `--network host`. Exposes `catt_backend` to the internet. |
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
| `catt-backend.yml` | Push/PR to `catt_backend/**`, weekly, manual | PR: pytest + build image. Merge: pytest + build + push to Docker Hub |
| `catt-frontend.yml` | Push/PR to `catt_frontend/**`, manual | PR: vitest + tsc + pages dry-run. Merge: vitest + tsc + pages deploy |
| `redirect.yml` | Push/PR to `redirect/**`, manual | Deploy |

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`.
