# Copilot Instructions

## Big Picture

- This repo controls Chromecast devices through four deployable components: `catt_backend` (Flask on the LAN), `catt_bff` (Cloudflare Worker BFF), `catt_frontend` (Cloudflare Pages UI), and `redirect` (Cloudflare Worker for shortlinks and YouTube lookup). Start with `README.md` and then the component `CLAUDE.md` files.
- The main request path is: frontend / Google Home / Slack / Telegram -> `catt_bff` -> Cloudflare Tunnel -> `catt_backend` -> Chromecast. Do not bypass the BFF from the frontend.
- `catt_bff/src/DeviceQueue.ts` is the control center for playback state. It keeps one Durable Object per physical device key, with SQLite tables for `queue`, `kv`, and `history`.
- Device identity lives in the Durable Object name (`idFromName(deviceKey)`), not in mutable state. Avoid reintroducing a stored `device` field inside DO state.

## Component Boundaries

- `catt_backend/app.py` is a single-endpoint Flask API: `POST /catt`. Command handlers live in `ACTION_HANDLERS`; responses must keep the `{"status":"success","data":...}` or `{"status":"error",...}` shape.
- `catt_backend/pychromecast_workarounds.py` is intentional. The backend must disconnect Chromecast sessions after each request to avoid pychromecast reconnect-thread issues.
- `catt_bff/src/index.ts` owns auth, routing, scheduled resets, and caller-session KV updates. Preserve its distinction between session-changing commands and one-shot device overrides.
- `catt_bff/src/cattHandler.ts` and `catt_bff/src/integrations.ts` both treat `cast <device> ...` and `volume <device> ...` as one-shot commands. Only `device <key>` updates the caller session.
- `catt_frontend/functions/api/*.ts` proxies to `catt_bff` only. Kids/admin auth is cookie-based in `src/lib/cookie.ts` and `src/lib/guard.ts`; outbound fetches go through `src/lib/proxy.ts` with a 10s timeout.
- `redirect/src/index.js` is the shared redirect and YouTube-search helper used by the BFF. `catt_bff/src/urlHelper.ts` expects a configurable `REDIRECT_URL`; do not hardcode the redirect host.

## Repo-Specific Patterns

- Queueing is append-only through the BFF DO `/enqueue` path. `command: "queue"` must not switch the active session device or interrupt current playback.
- In the BFF, channel names and device aliases resolve through `src/devices.ts`. Reuse `INPUT_TO_DEVICE`, `getChannelKey`, `getAppKey`, and related helpers instead of duplicating lookup tables.
- `cast` values that match a known channel should route to channel-changing logic instead of being treated as search queries. This behavior exists in both `cattHandler.ts` and chat integrations.
- The nightly reset at `03:03 UTC` is meaningful: it clears DO queue/state/history and resets caller sessions to `DEFAULT_DEVICE`. Keep new stateful features compatible with that reset model.
- Mini/audio-only devices force app selection back to `default`. Preserve that behavior when changing input or app logic.
- The backend Docker image copies all root-level `*.py` files. Do not add unrelated Python scripts at `catt_backend/` root unless they belong in the runtime image.

## Developer Workflows

- Backend: `cd catt_backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest && .venv/bin/pytest tests/`
- BFF: `cd catt_bff && npm install && npm test && npx tsc --noEmit`
- Frontend: `cd catt_frontend && npm install && npm test && npm run build`
- Redirect: `cd redirect && npm install && npm test`
- For narrow checks, prefer single-file tests such as `catt_backend/.venv/bin/pytest tests/test_validation.py::test_missing_command` or `cd catt_bff && npx vitest run src/tests/cattHandler.test.ts`.

## Testing And Change Guidance

- Backend tests monkeypatch `app.setup_cast`; they do not use a real Chromecast. Follow the existing fixture pattern in `catt_backend/tests/conftest.py`.
- BFF tests use Vitest with mocked `fetch`. Most logic is unit-tested in `catt_bff/src/tests/`; `DeviceQueue.ts` alarm behavior is documented but not fully unit-tested because it depends on the Durable Object runtime.
- Frontend changes should usually touch both static HTML in `public/` and Pages Functions in `functions/api/` only when the API contract changes. Keep the UI talking to `/api/...`, not directly to the Worker URL.
- When changing auth, preserve the current split: `X-API-Key` for most BFF routes, Slack signature verification for `/slack`, Telegram secret token for `/telegram`, and `X-Catt-Secret` between BFF and backend.
