# Plan: Per-Device Durable Objects with Unified KV Session

## Goal

Each physical Chromecast device gets its own isolated Durable Object instance — its own queue, history, alarm, sleep timer, and playback state. All callers (Telegram, Slack, Google Home, Kids UI, Admin UI, HTTP POST) store their active device in a single Cloudflare KV namespace (`catt-bff-kv`) and route to the correct per-device DO. All callers sharing the same physical device see the same queue.

---

## Background

### Current model

All callers share a single Durable Object keyed `"box"`. The active device is stored as a `device` KV entry inside that DO. All callers compete on the same state — switching devices in Telegram affects what Google Home controls next, and vice versa. Two users managing different devices step on each other's queue and playback state.

### Target model

```
Caller              Active device source              DO instance
──────────────────  ──────────────────────────────    ───────────
Telegram (chatId)   catt-bff-kv: telegram:<chatId>   "k", "o", "b", etc.
Slack               catt-bff-kv: slack:all            "k", "o", "b", etc.
Google Home         catt-bff-kv: googlehome:all           "k", "o", "b", etc.
Kids UI             catt-bff-kv: ui:kids              "k", "o", "b", etc.
Admin UI            catt-bff-kv: ui:admin             "k", "o", "b", etc.
HTTP POST (raw)     body.device (stateless) OR        "k", "o", "b", etc.
                    catt-bff-kv: http:<caller>
scheduled handler   all known device keys             one reset per DO
```

`catt-bff-kv` is the single source of truth for session device across all callers. Per-device DOs (`"k"`, `"o"`, `"b"`, `"zbk"`, `"tv"`, `"otv"`) are the single source of truth for queue, history, and playback state. The `"box"` DO is retired.

### Key benefit: shared queue across callers

Because all callers route to the same per-device DO, if Google Home switches to kitchen and the Kids UI enqueues a video to kitchen, they both hit the `"k"` DO and share the same queue, history, and alarm. There is no separate "Google Home queue" vs "Kids UI queue" for the same physical device.

### Known limitation: physical device contention

Two callers targeting the same physical Chromecast simultaneously (e.g. Telegram casting to kitchen while the Kids UI is also casting to kitchen) will interrupt each other at the hardware level. The software state in the DO remains consistent, but the physical device can only play one thing. This is an accepted limitation — the same reality exists today.

---

## What changes and what doesn't

### Unchanged

- `catt.ts`, `urlHelper.ts`, `oauth.ts` — unchanged
- Auth logic in `index.ts` — unchanged
- `/echo` route — unchanged
- All Telegram and Slack command parsing and dispatch logic — unchanged
- All device/channel name resolution (`getInputKey`, `INPUT_TO_DEVICE`, etc.) — unchanged
- Google Home's external device ID (`DEVICE_ID = "box"`) — unchanged, this is Google's identifier and cannot change

### The `device` KV inside each DO

With one DO per physical device, the `device` KV is fully vestigial — the routing layer always selects the correct DO via `idFromName(deviceKey)`, and `deviceKey` is derived from the request URL (`parts[1]`) inside the DO for all `castCommand` calls. `_deviceKey` is persisted in kv once per request solely for use by `alarm()`, which runs without a request URL. The `device` KV key has been removed from `DeviceQueue.ts`. The `device` command has also been removed from all integrations — the bare device alias (e.g. `k`) is the sole mechanism for switching sessions. All DO internal URLs use `/device/<key>/<action>` instead of the old `/device/box/<action>`.

### `catt-bff-kv` session reset behaviour

On `reset`, each caller's KV session entry is reset to `DEFAULT_DEVICE` (`"o"`). Only the sending caller's entry is affected — all other callers are completely isolated.

| Command | Caller | DO effect | KV effect |
|---|---|---|---|
| `reset` | Telegram | full DO state wipe | `telegram:<chatId>` → `DEFAULT_DEVICE` |
| `reset` | Slack | full DO state wipe | `slack:all` → `DEFAULT_DEVICE` |
| `reset` | HTTP POST | full DO state wipe | `http:<caller>` → `DEFAULT_DEVICE` |
| `reset` | Kids UI | full DO state wipe | `ui:kids` → `DEFAULT_DEVICE` |
| `reset` | Admin UI | full DO state wipe | `ui:admin` → `DEFAULT_DEVICE` |
| GH `On` | Google Home | `/reset` — full DO state wipe | `googlehome:all` → `DEFAULT_DEVICE` |
| GH `Off` | Google Home | `/off` — stop + full DO state wipe | KV session **unchanged** |
| `clear` | any | clears queue/state, keeps device+app | KV session **unchanged** |

`clear` leaves the KV session alone because the intent is to clear playback state while staying on the current device. `reset` is a full reset — it resets both the DO state and the routing session back to defaults, consistent with each other.

Note: KV entries are written with `DEFAULT_DEVICE` on reset (not deleted) — an explicit value is easier to debug in the KV dashboard than a missing key.

---

## New infrastructure

### Cloudflare KV namespace: `catt-bff-kv`

Stores the active device key for every session-based caller. Must be created in the Cloudflare dashboard before deploying.

| KV key | Example key | Example value | Set when | First-time fallback |
|---|---|---|---|---|
| `telegram:<chatId>` | `telegram:12345` | `"k"` | Telegram user sends a bare device alias | `DEFAULT_DEVICE` |
| `slack:all` | `slack:all` | `"o"` | Slack user sends a bare device alias | `DEFAULT_DEVICE` |
| `googlehome:all` | `googlehome:all` | `"b"` | Google Home executes `SetInput`, `NextInput`, or `PreviousInput` | `DEFAULT_DEVICE` |
| `ui:kids` | `ui:kids` | `"k"` | Kids UI sends `{ command: "device", value: "k" }` | `DEFAULT_DEVICE` |
| `ui:admin` | `ui:admin` | `"otv"` | Admin UI sends `{ command: "device", value: "otv" }` | `DEFAULT_DEVICE` |
| `http:<caller>` | `http:api-client-1` | `"zbk"` | Raw HTTP POST sends `{ command: "device", value: "zbk", caller: "api-client-1" }` | `DEFAULT_DEVICE` |

TTL: none (persists until overwritten). All KV entries are created lazily on first device selection — until then every caller falls back to `DEFAULT_DEVICE` (`"o"`).

Slack uses a single shared key because Slack slash commands have no per-user session — all Slack users share one active device, consistent with current behaviour.

Raw HTTP POST callers may include a `caller` string in the request body. If `caller` is absent, it defaults to `"default"`, mapping to KV key `http:default`. Each named caller (e.g. `"api-client-1"`) gets its own session stored at KV key `http:<caller>`. Sending `{ command: "device", value: "k", caller: "api-client-1" }` persists `"k"` for that caller; subsequent requests with the same `caller` route to `"k"` without needing to repeat `device`. Callerless requests all share the `http:default` session — if two distinct callerless clients run simultaneously they will clobber each other's device session, which is an accepted trade-off for a personal project.

When `body.device` is present on a `cast` command alongside `caller`, the device is resolved and the KV session is updated — matching current behaviour where `cast` with a device implicitly sets the active device. `device: "queue"` is treated as a reserved value that bypasses device resolution and queues to the caller's current session device.

---

## Caller identification for UI callers

The Kids UI and Admin UI both call `POST /catt` through Cloudflare Pages Functions. Since `index.ts` cannot distinguish them by route alone (both hit the same BFF endpoint with the same API key), the Pages Function proxies add a caller header:

- Kids UI Pages Function adds `X-Caller: kids`
- Admin UI Pages Function adds `X-Caller: admin`

`index.ts` reads this header to determine which KV key to use for routing and for updating the session device on a `device` command.

Raw HTTP POST callers (no `X-Caller` header) may include a `caller` field in the body. If absent, `caller` defaults to `"default"`, routing to the `http:default` shared session.

### Role guard decision for `functions/api/command.ts`

Currently `functions/api/command.ts` guards with `["kids", "admin"]` — both roles can call it. Since it will now add `X-Caller: kids`, an admin user hitting this endpoint would be routed to the `kids` DO. This is incorrect.

**Decision:** Change the guard to `["kids"]` only. Admin users must use `functions/api/admin/command.ts`. This is also a security improvement — it removes the ability for an admin session to silently mutate the kids DO's device via the wrong endpoint.

---

## File-by-file changes

### `catt_bff/wrangler.toml`

Add KV namespace binding:

```toml
[[kv_namespaces]]
binding = "CALLER_KV"
id = "<kv-namespace-id>"
preview_id = "<kv-namespace-preview-id>"
```

### `catt_bff/worker-configuration.d.ts` (auto-generated via `npm run cf-typegen`)

After adding the binding above, regenerate to get `CALLER_KV: KVNamespace` in the `Env` interface.

### `catt_bff/src/devices.ts`

Add a helper that returns all known device keys — used by the `scheduled` handler to reset every DO:

```ts
export function getAllDeviceKeys(deviceId: string): string[] {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    return (d.attributes.availableInputs as Array<{ key: string }>).map(i => i.key);
  }
  return [];
}
```

### `catt_bff/src/index.ts`

**Helper: resolve device key from KV session**

```ts
async function getSessionDeviceKey(env: Env, sessionKey: string): Promise<string> {
  return await env.CALLER_KV.get(sessionKey) ?? DEFAULT_DEVICE;
}

function getDoStubForDevice(env: Env, deviceKey: string): DurableObjectStub {
  return getDoStub(env, deviceKey);
}
```

**`/catt` route** — caller-aware DO resolution:

```
X-Caller: kids  → deviceKey = await getSessionDeviceKey(env, "ui:kids")
X-Caller: admin → deviceKey = await getSessionDeviceKey(env, "ui:admin")
no X-Caller, body.caller present → deviceKey = await getSessionDeviceKey(env, "http:<caller>")
no X-Caller, no body.caller     → deviceKey = await getSessionDeviceKey(env, "http:default")
```

For all paths, `doStub = getDoStubForDevice(env, deviceKey)`.

**Device resolution for all session callers (`ui:kids`, `ui:admin`, `http:<caller>`):**

- `command: "device"` — resolve `body.value` via `getInputKey`; write to KV; return state from new DO (handled directly in `index.ts`, does not go to `cattHandler`).
- `command: "cast"` with `body.device` present and not `"queue"` — resolve `body.device` via `getInputKey`; if valid, update KV session and use as `deviceKey`.
- `body.device = "queue"` — skip device resolution; use current KV session device; pass `device: "queue"` through to `cattHandler` unchanged so it queues without casting immediately.
- `command: "reset"` — after routing to DO, reset KV session: `await env.CALLER_KV.put(sessionKey, DEFAULT_DEVICE)`.
- `command: "clear"` — KV session unchanged.
- All other inline device tokens (e.g. `volume k 50`) are one-shot — they do not update the KV session.

**`/slack` route:**
```
POST /slack
  → deviceKey = await getSessionDeviceKey(env, "slack:all")
  → doStub = getDoStubForDevice(env, deviceKey)
  → pass doStub + env.CALLER_KV to handleSlack
```

**`/telegram` route:**
```
POST /telegram
  → pass env + env.CALLER_KV to handleTelegram (do NOT parse body here)
  → handleTelegram parses body once, reads chatId, calls
    env.CALLER_KV.get("telegram:<chatId>") to get deviceKey,
    then constructs its own doStub via getDoStub(env, deviceKey)
```

`handleTelegram` must import `getDoStub` or receive a factory — the DO stub is resolved internally after the body is parsed, not passed in from `index.ts`. This avoids parsing the body twice.

**`/fulfillment` (Google Home) route:**
```
POST /fulfillment
  → deviceKey = await getSessionDeviceKey(env, "googlehome:all")
  → doStub = getDoStubForDevice(env, deviceKey)
  → pass doStub + deviceKey + env to handleFulfillment
```

`deviceKey` is passed explicitly so `handleFulfillment` can forward it to `handleQuery` and `handleExecute` without re-reading KV.

**`/device/*` route:**
```
GET /device/box/state  (frontend always sends /device/box/<action>)
  → xcaller = request.headers.get("X-Caller") ?? "admin"
  → sessionKey = xcaller === "kids" ? "ui:kids" : "ui:admin"
  → deviceKey = await getSessionDeviceKey(env, sessionKey)
  → stub = getDoStubForDevice(env, deviceKey)
  → URL rewritten to /device/<deviceKey>/<action> before forwarding to DO
```
The frontend always sends `/device/box/<action>` — the `box` segment is replaced with the real device key by `index.ts` before forwarding.

**`scheduled` handler** — reset all device DOs:

```ts
async scheduled(_event, env) {
  for (const key of getAllDeviceKeys(DEVICE_ID)) {
    const stub = getDoStub(env, key);
    await stub.fetch(new Request(`https://do/device/${key}/clear`));
    await stub.fetch(new Request(`https://do/device/${key}/set/app/` + DEFAULT_APP));
  }
}
```

### `catt_bff/src/googleHome.ts`

**Call chain change:** `handleFulfillment` receives `deviceKey: string` and `env: Env` as additional parameters (both passed from `index.ts`). It forwards `deviceKey` to both `handleQuery` and `handleExecute`.

**`handleQuery`** — use `deviceKey` param instead of reading from DO state:

```ts
const inputKey = deviceKey; // passed down from handleFulfillment
```

**`SetInput`** — write to KV (no DO `set/device` call):

```ts
await env.CALLER_KV.put("googlehome:all", key);
```

**`NextInput` / `PreviousInput`** — use `deviceKey` param, write result to KV:

```ts
const key = getAdjacentInput(DEVICE_ID, deviceKey, delta);
await env.CALLER_KV.put("googlehome:all", key);
```

**`OnOff on`** — reset KV session alongside DO reset:

```ts
// After existing: await doGet(stub, "/reset");
await env.CALLER_KV.put("googlehome:all", DEFAULT_DEVICE);
```

**`OnOff off`** — KV session unchanged; only the DO state is wiped:

All other GH commands (`play`, `stop`, `volume`, `channel`, `shuffle`, etc.) are unaffected — they operate on the stub already resolved at routing time.

### `catt_bff/src/integrations.ts`

**`handleTelegram`** — three changes:

1. Accept `env: Env` (already has it for `CATT_AI`, `CATT_BACKEND_URL`, etc.) — confirm `CALLER_KV` is accessible via `env`.
2. After parsing the body and extracting `chatId`, resolve the DO stub internally:
   ```ts
   const deviceKey = await env.CALLER_KV.get(`telegram:${chatId}`) ?? DEFAULT_DEVICE;
   const doStub = getDoStub(env, deviceKey); // imported from index or a shared helper
   ```
3. On bare device alias (`command in INPUT_TO_DEVICE`) or `device <key>` command, write canonical input key to KV:
   ```ts
   const inputKey = getInputKey(DEVICE_ID, command, null) ?? command;
   await env.CALLER_KV.put(`telegram:${chatId}`, inputKey);
   ```
   Both paths are equivalent — `device k` and the bare alias `k` produce the same KV write and state reply.
4. On `reset`, reset KV session:
   ```ts
   await env.CALLER_KV.put(`telegram:${chatId}`, DEFAULT_DEVICE);
   ```

`handleTelegram` signature changes from receiving a pre-built `doStub` to building its own stub after body parse. `index.ts` no longer calls `getDoStub` before `handleTelegram` — it just passes `env`.

**`handleSlack`** — three changes:

1. Accept `deviceSession: KVNamespace` as an additional parameter (or use `env.CALLER_KV` if `env` is passed).
2. On bare device alias, write to KV:
   ```ts
   await deviceSession.put("slack:all", resolvedKey);
   ```
3. On `reset`, reset KV session:
   ```ts
   await deviceSession.put("slack:all", DEFAULT_DEVICE);
   ```

The `doStub` for Slack is still resolved in `index.ts` before calling `handleSlack` (Slack body is a URL-encoded form, not JSON — no double-parse concern).

### `catt_frontend/functions/api/command.ts` (Kids UI)

Two changes:

1. Change cookie guard from `["kids", "admin"]` to `["kids"]` only.
2. Add `X-Caller: kids` header:

```ts
headers: { "Content-Type": "application/json", "X-API-Key": env.CATT_API_KEY, "X-Caller": "kids" }
```

### `catt_frontend/functions/api/admin/command.ts` (Admin UI)

Add `X-Caller: admin` header:

```ts
headers: { "Content-Type": "application/json", "X-API-Key": env.CATT_API_KEY, "X-Caller": "admin" }
```

### `catt_frontend/functions/api/state.ts` (Kids UI state polling)

Add `X-Caller: kids` header:

```ts
headers: { "X-API-Key": env.CATT_API_KEY, "X-Caller": "kids" }
```

### `catt_frontend/functions/api/admin/state.ts` (Admin UI state polling)

Add `X-Caller: admin` header to both BFF calls:

```ts
headers: { "X-API-Key": env.CATT_API_KEY, "X-Caller": "admin" }
```

### `catt_bff/src/index.ts` — `device` field in state response

`getState()` in `DeviceQueue.ts` returns `device: this.get("device")` which is vestigial after this change. The `device` field in the state response will always hold the stale default, not the true active device. The Kids UI (`app.html:217`) and Admin UI (`admin/app.html:179`) both read `state.device` to highlight the active device button.

**Fix:** In the `/device/*` handler in `index.ts`, after receiving the state response from the DO, inject the correct `device` key before returning:

```ts
const state = await res.json() as Record<string, unknown>;
return Response.json({ device: deviceKey, ...state });
```

Since `device` is removed from `DeviceQueue.ts` as part of this plan, `getState()` will no longer return a `device` field at all — making the injection in `index.ts` the sole source of the `device` field in all state responses.

### `catt_bff/src/cattHandler.ts`

Accepts `deviceKey: string` as an additional parameter alongside `doStub`. Uses it directly for `volume` — no DO state read. All DO request URLs use `/device/<deviceKey>/<action>` instead of the old `/device/box/<action>`.

### `catt_bff/src/DeviceQueue.ts`

`device` KV key removed. `deviceKey` comes from `parts[1]` of the request URL in every route. `_deviceKey` is stored in kv once per request for use by `alarm()`. All method signatures that previously read `this.get("device")` now receive `deviceKey` as an explicit parameter. The `set/device` route and `device` command are removed. The `device` command is also removed from all integrations — bare alias is the sole session-switching mechanism.

---

## Device name resolution

All forms resolve to the same DO:

```
"Mini Kitchen"  →  getInputKey → "k"   →  getDoStub(env, "k")
"kitchen"       →  getInputKey → "k"   →  getDoStub(env, "k")
"k"             →  getInputKey → "k"   →  getDoStub(env, "k")
"OTV"           →  getInputKey → "otv" →  getDoStub(env, "otv")
```

If `body.device` is absent or unresolvable (raw HTTP POST path), falls back to `DEFAULT_DEVICE` (`"o"`).

---

## Session flow after change

### Telegram

```
User sends: "kitchen"
  → handleTelegram parses body, chatId = 12345
  → CALLER_KV.get("telegram:12345") = null → DEFAULT_DEVICE = "o" (first time)
  → command in INPUT_TO_DEVICE → resolvedKey = "k"
  → CALLER_KV.put("telegram:12345", "k")
  → doStub = getDoStub(env, "k") → dispatch

User sends: "channel up"
  → handleTelegram parses body, chatId = 12345
  → CALLER_KV.get("telegram:12345") = "k" → doStub = getDoStub(env, "k")
  → channel up dispatched to "k" DO
```

### Google Home

```
User says: "switch to kitchen"
  → index.ts: deviceKey = "o" (from KV), doStub = getDoStub(env, "o")
  → SetInput → resolvedKey = "k"
  → CALLER_KV.put("googlehome:all", "k")
  (note: current request still uses "o" stub — next request picks up "k")

User says: "play"
  → index.ts: CALLER_KV.get("googlehome:all") = "k" → doStub = getDoStub(env, "k")
  → play dispatched to "k" DO
```

### Kids UI

```
User taps "Kitchen" device button
  → POST /catt { command: "cast", device: "k", value: "..." } with X-Caller: kids
  → index.ts: CALLER_KV.put("ui:kids", "k"), route command to "k" DO

User taps "Play"
  → POST /catt { command: "play" } with X-Caller: kids
  → index.ts: CALLER_KV.get("ui:kids") = "k" → getDoStub(env, "k")
  → play dispatched to "k" DO

State poll (GET /device/box/state with X-Caller: kids)
  → index.ts: CALLER_KV.get("ui:kids") = "k" → getDoStub(env, "k")
  → state returned with device: "k" injected
  → UI highlights Kitchen button correctly
```

### Shared queue example

```
Google Home: "switch to kitchen" → CALLER_KV: googlehome:all = "k"
Kids UI: taps Kitchen → CALLER_KV: kids = "k"
Kids UI: enqueues video → "k" DO queue
Google Home: "next" → "k" DO advances — plays the Kids UI's queued item
```

---

## The `"box"` DO

Retired. No code routes to `getDoStub(env, "box")` after this change. Any existing data in `"box"` (queue, history, kv) is abandoned — acceptable since queue data is ephemeral. The `DEVICE_ID = "box"` constant is kept as Google Home's external identifier only.

---

## Migration / rollout notes

- Create `catt-bff-kv` namespace in Cloudflare dashboard. Add its ID and preview ID to `wrangler.toml` before deploying.
- At rollout, all per-device DOs start fresh (empty queue, default state). No data migration from `"box"`.
- `CALLER_KV` KV entries are written on first device switch — until then, all callers default to `DEFAULT_DEVICE` (`"o"`).

---

## Test changes required

### `catt_bff` tests

**`src/tests/index.test.ts`**
- Add `CALLER_KV: { get: vi.fn(async () => null), put: vi.fn() }` to `makeEnv()`
- Add tests: `/catt` with `X-Caller: kids` routes to `ui:kids` session; `/catt` with `X-Caller: admin` routes to `ui:admin` session; `/catt` with no `X-Caller` and no `body.caller` falls back to `http:default` session; `/catt` with no `X-Caller` and `body.caller` reads from `http:<caller>` KV key; `device` command with `body.caller` writes to `http:<caller>` KV key; `cast` with `body.device` and `body.caller` updates KV session; `cast` with `body.device: "queue"` uses session device without updating KV; `/device/box/state` with `X-Caller: kids` reads `ui:kids` session; state response has `device` field injected from KV not DO

**`src/tests/integrations.test.ts`**
- Add `CALLER_KV: { get: vi.fn(async () => null), put: vi.fn() }` to `makeEnv()`
- `handleTelegram` no longer receives a pre-built `doStub` — update all test call sites
- Add tests: Telegram device alias writes to `CALLER_KV`; subsequent command reads from `CALLER_KV`; Slack device alias writes to `CALLER_KV`

**`src/tests/googleHome.test.ts`**
- `handleFulfillment` signature gains `deviceKey` and updated `env` — update all test call sites
- Add tests: `SetInput` writes to `CALLER_KV` not DO; `NextInput`/`PreviousInput` write to `CALLER_KV`; `handleQuery` uses passed `deviceKey` not `doSt.device`

### `catt_frontend` tests

**`src/tests/command.test.ts`**
- `POST /api/command` — add test asserting `X-Caller: kids` header is sent to BFF
- `POST /api/command` — add test asserting admin cookie now returns 401 (role guard tightened to kids-only)
- `POST /api/admin/command` — add test asserting `X-Caller: admin` header is sent to BFF
- `GET /api/state` — add test asserting `X-Caller: kids` header is sent to BFF
- `GET /api/admin/state` — add test asserting `X-Caller: admin` header is sent to both BFF calls

---

## Summary of files changed

### `catt_bff`

| File | Nature of change |
|---|---|
| `wrangler.toml` | Add `CALLER_KV` KV binding |
| `worker-configuration.d.ts` | Regenerate to add `CALLER_KV: KVNamespace` to `Env` |
| `src/devices.ts` | Add `getAllDeviceKeys()` helper |
| `src/index.ts` | Per-route DO resolution via KV or body.device; X-Caller handling; device injection in state response; update `scheduled` handler |
| `src/googleHome.ts` | Accept `deviceKey` + `env` params; read/write device via KV |
| `src/integrations.ts` | `handleTelegram` resolves own DO stub after body parse; both handlers write to KV on device alias |
| `src/cattHandler.ts` | Accept `deviceKey` param; use it directly for volume; all DO URLs use `/device/<key>/<action>` |
| `src/DeviceQueue.ts` | Remove `device` KV key; `deviceKey` from URL `parts[1]`; `_deviceKey` stored for `alarm()`; remove `set/device` route and `device` command |
| `src/catt.ts` | No changes |
| `src/urlHelper.ts` | No changes |
| `src/oauth.ts` | No changes |

### `catt_frontend`

| File | Nature of change |
|---|---|
| `functions/api/command.ts` | Tighten guard to `["kids"]`; add `X-Caller: kids` header |
| `functions/api/admin/command.ts` | Add `X-Caller: admin` header |
| `functions/api/state.ts` | Add `X-Caller: kids` header |
| `functions/api/admin/state.ts` | Add `X-Caller: admin` header to both BFF calls |

---

## Implementation stages

### Stage 1: Infrastructure + DO cleanup
**Goal**: KV namespace wired up, `device` key removed from DO, baseline tests still passing.
**Files**: `wrangler.toml`, `worker-configuration.d.ts`, `src/devices.ts`, `src/DeviceQueue.ts`
**Steps**:
1. Add `CALLER_KV` KV binding to `wrangler.toml`
2. Run `npm run cf-typegen` to regenerate `worker-configuration.d.ts`
3. Add `getAllDeviceKeys()` to `src/devices.ts`
4. Remove `device` KV key from `DeviceQueue.ts` (`defaultFor()`, `clearState()`, `reset` route, `set/device` initialisation call, `getState()` return)
5. Add `CALLER_KV: { get: vi.fn(async () => null), put: vi.fn() }` to `makeEnv()` in all test files
6. Run `npm test` — all existing tests must pass
**Status**: Complete

---

### Stage 2: Core BFF routing
**Goal**: `index.ts` routes to per-device DOs via KV; `cattHandler.ts` uses passed `deviceKey` for volume.
**Files**: `src/index.ts`, `src/cattHandler.ts`
**Steps**:
1. Add `getSessionDeviceKey()` helper to `index.ts`
2. Update `/catt` route — X-Caller handling, `body.caller` fallback to `http:default`, KV session read/write, `device: "queue"` special case, reset KV on `reset` command
3. Update `/device/*` route — X-Caller → session key → DO stub; inject `device` field into state response
4. Update `/slack`, `/telegram`, `/fulfillment` routes to pass `env` / `deviceKey` as needed
5. Update `scheduled` handler to iterate `getAllDeviceKeys()`
6. Update `cattHandler.ts` — accept `deviceKey` param, remove `state.device` DO read for volume
7. Update `src/tests/index.test.ts` and `src/tests/cattHandler.test.ts` with new tests (see test changes section)
8. Run `npm test` — all tests must pass
**Status**: Complete

---

### Stage 3: Integrations + Google Home
**Goal**: Telegram, Slack, and Google Home all read/write device via `catt-bff-kv`.
**Files**: `src/integrations.ts`, `src/googleHome.ts`
**Steps**:
1. Update `handleTelegram` — remove pre-built `doStub` param; resolve DO stub internally after body parse; write KV on device alias; reset KV on `reset`
2. Update `handleSlack` — write KV on device alias; reset KV on `reset`
3. Update `handleFulfillment` — accept `deviceKey` + `env`; forward to `handleQuery` and `handleExecute`
4. Update `handleQuery` — use passed `deviceKey` instead of `doSt.device`
5. Update `SetInput`, `NextInput`, `PreviousInput` — write result to KV instead of DO
6. Update `OnOff on` — reset KV session after DO reset
7. Update `src/tests/integrations.test.ts` and `src/tests/googleHome.test.ts` (see test changes section)
8. Run `npm test` — all tests must pass
**Status**: Complete

---

### Stage 4: Frontend
**Goal**: Pages Functions identify themselves so BFF can route to the correct session.
**Files**: `catt_frontend/functions/api/command.ts`, `catt_frontend/functions/api/admin/command.ts`, `catt_frontend/functions/api/state.ts`, `catt_frontend/functions/api/admin/state.ts`
**Steps**:
1. Add `X-Caller: kids` to `functions/api/command.ts` and tighten role guard to `["kids"]`
2. Add `X-Caller: admin` to `functions/api/admin/command.ts`
3. Add `X-Caller: kids` to `functions/api/state.ts`
4. Add `X-Caller: admin` to `functions/api/admin/state.ts`
5. Update `catt_frontend` tests (see test changes section)
6. Run `npm test` in `catt_frontend` — all tests must pass
**Status**: Complete

---

## What is explicitly out of scope

- Migrating existing `"box"` DO history or queue data
- Per-user Slack sessions (one shared Slack device is consistent with current behaviour)

---

## Future cleanup (post-ship)

No deferred cleanup items — all KV key removals are handled within this plan.
