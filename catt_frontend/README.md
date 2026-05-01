# catt_frontend

Cloudflare Pages web UI for controlling Chromecast devices via `catt_bff`. Deployed at `frontend.example.com`.

Two views:
- **Kids view** (`/`) — PIN login, preset favourite buttons, playback controls
- **Admin view** (`/admin`) — password login, full control surface, state polling

---

## Local development

```bash
cd catt_frontend
npm install
cp .dev.vars.example .dev.vars   # fill in your values
npm run dev                       # http://localhost:8788
```

### `.dev.vars`

Create a `.dev.vars` file in `catt_frontend/` with the following:

```
UI_PIN=123456
UI_ADMIN_PASSWORD=your-admin-password
UI_COOKIE_SECRET=any-random-string-at-least-32-chars
CATT_BFF_URL=https://bff.example.com
CATT_API_KEY=your-catt-api-key
UI_KIDS_ALLOW_SEARCH=true
UI_KIDS_ALLOW_DEVICE_SWITCH=true
BUTTONS_CONFIG=[{"label":"ping","command":"channel","value":"ping"}]
```

> `.dev.vars` is gitignored — never commit it.

---

## Deploying to Cloudflare Pages

### 1. Create the Pages project

In the Cloudflare dashboard:
1. Go to **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select this repository, set the **project name** to `gha-catt`
3. Set **build output directory** to `public`
4. Leave the build command empty (no build step needed)

Or create it via CLI (one-time):
```bash
npx wrangler pages project create gha-catt
```

### 2. Set secrets

In the Cloudflare dashboard go to **Workers & Pages** → `gha-catt` → **Settings** → **Environment variables**.

Add the following as **Secrets** (encrypted):

| Secret | Value |
|---|---|
| `UI_PIN` | 6-digit numeric PIN for kids login (e.g. `123456`) |
| `UI_ADMIN_PASSWORD` | Admin login password |
| `UI_COOKIE_SECRET` | Random string, at least 32 characters — used to sign session cookies. Generate with: `openssl rand -hex 32` |
| `CATT_BFF_URL` | `https://bff.example.com` |
| `CATT_API_KEY` | The `CATT_API_KEY` secret from `catt_bff` |
| `BUTTONS_CONFIG` | JSON array of kids favourite buttons (see format below) |

Add the following as **Variables** (plain text):

| Variable | Default | Purpose |
|---|---|---|
| `UI_COOKIE_MAX_AGE_DAYS` | `7` | Cookie lifetime in days |
| `UI_KIDS_ALLOW_SEARCH` | `true` | Show search box on kids view |
| `UI_KIDS_ALLOW_DEVICE_SWITCH` | `true` | Show device switcher on kids view |

> Set variables for both **Production** and **Preview** environments.

### 3. Set custom domain

In the Cloudflare dashboard go to **Workers & Pages** → `gha-catt` → **Custom domains** → **Set up a custom domain** → enter `frontend.example.com`.

### 4. Deploy

Push to `main` — GitHub Actions deploys automatically. Or deploy manually:

```bash
cd catt_frontend
npx wrangler pages deploy public --project-name gha-catt
```

---

## BUTTONS_CONFIG format

JSON array of preset buttons shown on the kids view under "Favourites":

```json
[
  { "label": "ping",     "command": "channel", "value": "ping" },
  { "label": "Sun News", "command": "channel", "value": "sun" },
  { "label": "Bluey",    "command": "cast",    "device": "otv", "value": "https://youtu.be/..." },
  { "label": "Stop",     "command": "stop" }
]
```

| Field | Required | Notes |
|---|---|---|
| `label` | yes | Button text |
| `command` | yes | `cast`, `channel`, `stop`, `play`, etc. |
| `device` | no | Target device key — if omitted, uses the active device |
| `value` | no | URL, channel key, volume level |

---

## GitHub Actions

The workflow in `.github/workflows/catt-frontend.yml` runs on every push or PR touching `catt_frontend/**`.

| Trigger | Steps |
|---|---|
| PR | `npm ci` → `tsc --noEmit` → `npm test` → `wrangler pages deploy --dry-run` |
| Push to `main` | `npm ci` → `tsc --noEmit` → `npm test` → `wrangler pages deploy` |

Required GitHub secret: `CLOUDFLARE_API_TOKEN`

To add it: **GitHub repo** → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** → name: `CLOUDFLARE_API_TOKEN`, value: your Cloudflare API token with Pages edit permissions.

---

## Commands

```bash
npm install          # install dependencies
npm test             # vitest run (once)
npm run test:watch   # vitest watch
npm run build        # tsc --noEmit (type check)
npm run dev          # wrangler pages dev (local, http://localhost:8788)
npm run deploy       # wrangler pages deploy (production)
npm run deploy:dry   # dry run
```
