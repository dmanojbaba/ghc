# Plan: catt_frontend — Cloudflare Pages UI

## Context

`catt_frontend` is a web UI for controlling Chromecast devices via `catt_bff`. It provides two views:

> **`catt_bff` endpoints used**: `GET /devices` (`[{ key, name }]`) and `GET /channels` (`[{ key, name, number }]`) are already implemented — single source of truth for device and channel lists. Both require `X-API-Key`.

- **Kids view** (`/`) — large tap-friendly preset buttons + basic playback controls; PIN-protected (6-digit)
- **Admin view** (`/admin`) — full control surface matching all `catt_bff` capabilities; password-protected

Hosted on Cloudflare Pages. Pages Functions handle auth and proxy all commands to `catt_bff` — the browser never communicates with `catt_bff` directly, keeping `CATT_API_KEY` server-side only.

---

## Architecture

```
Browser (iPad / phone / desktop)
        │
        ▼
Cloudflare Pages  (catt_frontend — <pages-domain>.pages.dev)
        │
        ├── GET  /              → public/index.html    (kids login)
        ├── POST /api/auth      → functions/api/auth.ts (kids PIN → cookie)
        ├── GET  /app           → public/app.html      (kids view)
        ├── POST /api/command   → functions/api/command.ts (proxy → catt_bff)
        ├── GET  /api/state     → functions/api/state.ts   (active device → catt_bff)
        ├── GET  /api/devices   → functions/api/devices.ts (device list → catt_bff)
        │
        ├── GET  /admin         → public/admin/index.html  (admin login)
        ├── POST /api/admin/auth → functions/api/admin/auth.ts (password → cookie)
        ├── GET  /admin/app     → public/admin/app.html     (admin view)
        ├── POST /api/admin/command → functions/api/admin/command.ts (proxy → catt_bff)
        └── GET  /api/admin/state   → functions/api/admin/state.ts  (state poll → catt_bff)
```

---

## Project Structure

```
catt_frontend/
├── public/
│   ├── index.html            # Kids login page
│   ├── app.html              # Kids view — preset buttons + playback controls
│   ├── admin/
│   │   ├── index.html        # Admin login page
│   │   └── app.html          # Admin view — full control surface
│   └── style.css             # Shared responsive styles
├── functions/
│   └── api/
│       ├── auth.ts           # Kids PIN auth → sets kids session cookie
│       ├── command.ts        # Validates kids cookie → proxies to catt_bff (rate limited)
│       ├── state.ts          # Validates kids cookie → returns active device + session
│       ├── devices.ts        # Validates kids cookie → proxies GET /devices from catt_bff
│       └── admin/
│           ├── auth.ts       # Admin password auth → sets admin session cookie
│           ├── command.ts    # Validates admin cookie → proxies to catt_bff (rate limited)
│           ├── logout.ts     # Clears admin cookie → redirects to /admin
│           └── state.ts      # Proxies state/history to admin view
├── src/
│   └── tests/
│       ├── auth.test.ts      # Cookie signing/verification, PIN validation
│       └── command.test.ts   # Auth guard, command proxying
├── docs/
│   └── plan.md
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── wrangler.toml
```

---

## Auth Flow

### Kids
1. Browser POSTs 6-digit PIN to `POST /api/auth`
2. Function validates PIN against `UI_PIN` secret
3. On match: generate signed cookie (HMAC-SHA256 of `kids:<timestamp>` using `UI_COOKIE_SECRET`), set `HttpOnly; Secure; SameSite=Strict; Max-Age=<days>`
4. Redirect to `/app`
5. Every `POST /api/command` validates the cookie signature before proxying

### Admin
1. Browser POSTs password to `POST /api/admin/auth`
2. Function validates against `UI_ADMIN_PASSWORD` secret
3. On match: generate signed admin cookie (HMAC-SHA256 of `admin:<timestamp>`)
4. Redirect to `/admin/app`
5. Every `POST /api/admin/command` and `GET /api/admin/state` validates the admin cookie

### Cookie format
```
catt_session=<base64(role:timestamp)>.<base64(hmac)>
```
- `role`: `kids` or `admin`
- `timestamp`: Unix ms of issue time — used to enforce `Max-Age` server-side
- `hmac`: HMAC-SHA256 of `role:timestamp` using `UI_COOKIE_SECRET`

### Brute-force protection
Not implemented in code — Cloudflare WAF rate limiting on auth endpoints handles this at the edge without any KV or application logic.

---

## Kids View (`/app`)

### Layout
```
┌──────────────────────────────────────┐
│  Device: [Kitchen] [●Office] [TV]... │  ← active device highlighted; tappable if UI_KIDS_ALLOW_DEVICE_SWITCH=true
│                                      │    plain text "Device: Office TV" if false
├──────────────────────────────────────┤
│  [preset]  [preset]  [preset]        │  ← BUTTONS_CONFIG rows (section labelled "Favourites")
│  [preset]  [preset]                  │
├──────────────────────────────────────┤ ← only if UI_KIDS_ALLOW_SEARCH=true
│  [search input ____________] [Play]  │
├──────────────────────────────────────┤
│  [Prev]  [Play/Pause]  [Stop]  [Next]│  ← always-present playback row
│       [Vol Down]  [Vol Up]           │
└──────────────────────────────────────┘
```

- CSS grid, `auto-fill`, `minmax(120px, 1fr)` — 2 columns on phone, 3–4 on tablet/desktop
- Minimum tap target: 80×80px
- Colour scheme follows system preference via `prefers-color-scheme` media query — no manual toggle; light mode: off-white background (`#f5f5f5`), dark grey text (`#1a1a1a`), blue buttons (`#2563eb`); dark mode: dark grey background (`#1a1a1a`), light text (`#f0f0f0`), blue buttons (`#3b82f6`)
- Active device fetched from `GET /api/state` once on page load — shown as `Device: Office TV` plain text when `UI_KIDS_ALLOW_DEVICE_SWITCH=false`; shown as a row of tappable device buttons labelled by name when `true` — active device button is highlighted (filled background), tapping another POSTs `{ command: "device", value: "<key>" }` to `/api/command` and updates the highlight; on phone uses short aliases (`K`, `O`, `B`, `TV`) to fit
- Play/Pause is a single static toggle button — always sends `play` command which toggles on the device; label does not change based on session state
- Search row shown only when `UI_KIDS_ALLOW_SEARCH=true` — text input POSTs `{ command: "cast", value: "<text>" }` to `/api/command` (resolves via redirect worker)
- Preset buttons POST `{ command, device, value }` to `/api/command`
- Playback buttons POST fixed commands (`play`, `stop`, `next`, `prev`, `volume up`, `volume down`)
- Loading state on button tap (disabled + visual feedback) until response

### BUTTONS_CONFIG format
```json
[
  { "label": "Bluey",      "command": "cast",    "device": "tv",  "value": "https://youtu.be/..." },
  { "label": "Cocomelon",  "command": "cast",    "device": "tv",  "value": "https://youtu.be/..." },
  { "label": "Sun TV",     "command": "channel", "device": "tv",  "value": "sun" },
  { "label": "Stop",       "command": "stop" }
]
```

| Field | Required | Notes |
|---|---|---|
| `label` | yes | Button text |
| `command` | yes | `cast`, `channel`, `stop`, `play`, `volume`, etc. |
| `device` | no | Target device key; if omitted, uses active kv device |
| `value` | no | URL, channel key, volume level — omitted for commands like `stop` |

The Pages Function serves `BUTTONS_CONFIG` as JSON at `GET /api/config` (kids cookie required) — the kids view fetches it on load to render preset buttons.

---

## Admin View (`/admin/app`)

### Layout
```
┌─────────────────────────────────────────────────┐
│ Active device: Office TV                         │  ← prominent device display
│ State: [session] [app] [channel]                 │  ← live state bar (polls /api/admin/state)
│ Sleep: [sleep_at]   Alarm: [alarm]               │
├─────────────────────────────────────────────────┤
│ Device: [k][o][b][zbk][tv][otv]                  │  ← device switcher
│ Channel: [up][down] or [name input]              │
├─────────────────────────────────────────────────┤
│ Cast: [url/search input]          [Cast]         │  ← cast input
│ TTS:  [text input]                [Speak]        │
├─────────────────────────────────────────────────┤
│ [Prev] [Play/Pause] [Next] [Stop] [Clear][Reset] │  ← playback controls
│ [Rewind] [FFwd]  seconds: [__]                   │
├─────────────────────────────────────────────────┤
│ Volume: [Down] [Up]  Set: [___] [Set]            │  ← volume
│ [Mute]  [Unmute]                                 │
├─────────────────────────────────────────────────┤
│ Sleep: [mins: ___] [Set] [Cancel]                │  ← sleep timer
├─────────────────────────────────────────────────┤
│ Queue:                                           │  ← queue list
│  1. https://...                                  │
│  2. https://...                                  │
├─────────────────────────────────────────────────┤
│ History (last 10):                               │  ← history list
│  • https://...                                   │
└─────────────────────────────────────────────────┘
```

- Colour scheme follows system preference via `prefers-color-scheme` — same palette as kids view
- State bar polls `GET /api/admin/state` every 30 seconds when tab is visible; polling pauses when tab is hidden (Page Visibility API) and resumes with an immediate fetch when tab becomes visible again
- State also refreshed immediately after every command
- All controls POST to `/api/admin/command`
- Queue and history rendered from state response

---

## Pages Functions

### `functions/api/auth.ts`
- `POST /api/auth` — reads `pin` from form body, validates exactly 6 digits, checks against `UI_PIN`, sets kids cookie on success

### `functions/api/command.ts`
- `POST /api/command` — validates kids cookie, reads `{ command, device, value }` from JSON body, forwards to `catt_bff` POST `/catt` with `X-API-Key` header; enforces 60 req/min rate limit per IP

### `functions/api/state.ts`
- `GET /api/state` — validates kids cookie, proxies `GET /device/box/state` from `catt_bff`, returns `{ device, session }` — used by kids view to display active device on load

### `functions/api/devices.ts`
- `GET /api/devices` — validates kids cookie, proxies `GET /devices` from `catt_bff`, returns device list (`[{ key, name }]`) — fetched once on page load by both kids and admin views; single source of truth from `devices.ts`

### `functions/api/admin/auth.ts`
- `POST /api/admin/auth` — reads `password` from form body, validates against `UI_ADMIN_PASSWORD`, sets admin cookie on success

### `functions/api/admin/command.ts`
- `POST /api/admin/command` — validates admin cookie, forwards `{ command, device, value }` to `catt_bff`; enforces 60 req/min rate limit per IP

### `functions/api/admin/state.ts`
- `GET /api/admin/state` — validates admin cookie, proxies `GET /device/box/state` and `GET /device/box/history` from `catt_bff`, returns combined JSON

### `functions/api/admin/logout.ts`
- `POST /api/admin/logout` — clears `__Secure-catt_session` cookie, redirects to `/admin`

---

## Security

| Control | Implementation |
|---|---|
| Secrets never reach browser | `CATT_API_KEY`, `CATT_BFF_URL`, `UI_COOKIE_SECRET` only in Pages Functions |
| Cookie flags | `__Secure-catt_session` name prefix + `HttpOnly; Secure; SameSite=Strict` — browser enforces HTTPS-only delivery |
| Cookie lifetime | `Max-Age` from `UI_COOKIE_MAX_AGE_DAYS` (default 7 days) |
| Cookie signing | HMAC-SHA256 — tampered cookies rejected |
| Role isolation | Kids cookie rejected by admin endpoints; admin cookie accepted by kids endpoints |
| Brute force | Handled by Cloudflare WAF rate limiting at the edge — no application-level KV needed |
| Input validation | PIN must be exactly 6 digits; command/device validated against known values before proxying |
| CSP headers | All Pages responses include `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'` — no inline scripts, no external resources |
| No sensitive data in logs | PIN, password, cookie values must never appear in Pages Function log output — log errors by type only |
| Logout | Admin view has a logout button — clears `__Secure-catt_session` cookie and redirects to `/admin` |
| DDoS | Cloudflare edge absorbs volumetric attacks automatically; WAF rate limiting on auth endpoints recommended |
| `BUTTONS_CONFIG` | Treated as non-sensitive — served to browser; do not include secrets |

### Request timeout
All Pages Functions set a 10-second timeout on proxied requests to `catt_bff`. If the request times out, the Function returns a 504 with a plain error message — the browser never hangs indefinitely.

### Button debounce
All buttons on kids and admin views are disabled for 500ms after a tap, and re-enabled when the response returns (or on timeout). Prevents duplicate commands from rapid tapping.

---

## Secrets and Variables

### Secrets (encrypted — set via Cloudflare Pages dashboard)

| Secret | Purpose |
|---|---|
| `UI_PIN` | 6-digit numeric PIN for kids login |
| `UI_ADMIN_PASSWORD` | Admin login password |
| `UI_COOKIE_SECRET` | HMAC signing key for session cookies (shared between kids and admin) |
| `CATT_BFF_URL` | Base URL of `catt_bff` (e.g. `https://ghc.manojbaba.com`) |
| `CATT_API_KEY` | Forwarded as `X-API-Key` on all proxied requests to `catt_bff` |
| `BUTTONS_CONFIG` | JSON array of kids preset buttons |

### Variables (plain — set via Cloudflare Pages dashboard)

| Variable | Default | Purpose |
|---|---|---|
| `UI_COOKIE_MAX_AGE_DAYS` | `7` | Cookie lifetime in days |
| `UI_KIDS_ALLOW_SEARCH` | `true` | Show search box on kids view; set to `false` to hide |
| `UI_KIDS_ALLOW_DEVICE_SWITCH` | `true` | Show device switcher on kids view; set to `false` to hide |

---

## GitHub Actions (`catt-frontend.yml`)

| Trigger | Steps |
|---|---|
| PR touching `catt_frontend/**` | `npm install` → `npx tsc --noEmit` → `npm test` → `wrangler pages deploy --dry-run` |
| Merge to `main` | `npm install` → `npx tsc --noEmit` → `npm test` → `wrangler pages deploy` |

Required GitHub secrets: `CLOUDFLARE_API_TOKEN`

---

## Stages

### Stage 1: Project scaffold
**Goal**: Repo structure, package.json, tsconfig, wrangler.toml, vitest config
**Success Criteria**: `npm install`, `npm test`, `npx tsc --noEmit` all pass on empty project
**Status**: Complete

### Stage 2: Auth (kids + admin)
**Goal**: PIN and password auth, cookie sign/verify, lockout
**Success Criteria**: Auth tests pass; invalid PIN/password returns 401; lockout after 5 attempts; valid auth sets correct cookie
**Tests**: `src/tests/auth.test.ts`
**Status**: Complete

### Stage 3: Command proxy
**Goal**: Kids and admin command Functions — validate cookie, proxy to catt_bff
**Success Criteria**: Missing/tampered cookie returns 401; valid cookie forwards request with correct headers; role isolation enforced
**Tests**: `src/tests/command.test.ts`
**Status**: Complete

### Stage 4: Kids UI
**Goal**: Login page + kids view (preset buttons + playback controls)
**Success Criteria**: Renders on iPad (Safari), phone, desktop; buttons post to `/api/command`; loading state on tap
**Status**: Complete

### Stage 5: Admin UI
**Goal**: Admin login + full admin view (all controls, state polling, queue/history)
**Success Criteria**: State bar polls and updates; all commands reachable; responsive on all screen sizes
**Status**: Complete

### Stage 6: GitHub Actions + README
**Goal**: CI/CD workflow, README with setup and config docs
**Success Criteria**: PR workflow runs on push; deploy workflow deploys on merge
**Status**: Complete

### Stage 7: App switcher
**Goal**: Allow admin to switch the active app (e.g. `youtube`, `default`) from the admin UI
**Implementation**: `POST /api/admin/command` with `{ command: "app", value: "youtube" }` — `catt_bff` already supports this via `cattHandler.ts` (`app` command routes to `set/app/:key` on the DO); admin UI shows toggle buttons for available apps (`default`, `youtube`) with active app highlighted, tapping another posts the command and refreshes state
**Success Criteria**: Admin can switch app from the UI; state bar reflects the new app after switching
**Status**: Not Started

### Stage 8: Admin-managed favourites
**Goal**: Allow admin to edit kids favourite buttons from the admin UI instead of Cloudflare dashboard
**Implementation**: Add a Cloudflare KV namespace (`GHA_BUTTONS`); `GET /api/config` reads KV first, falls back to `BUTTONS_CONFIG` env var; admin UI gets a JSON textarea + save button that writes to KV via a new `POST /api/admin/buttons` endpoint
**Success Criteria**: Admin can edit and save buttons without touching Cloudflare dashboard; changes take effect immediately; fallback to env var when KV is empty
**Status**: Not Started
