# Test Plan: catt_frontend

Tests use Vitest. No integration tests — all outbound HTTP (to `catt_bff`) and Cloudflare KV are mocked via `vi.stubGlobal` and stub objects.

Test files live in `src/tests/`.

---

## `src/tests/auth.test.ts`

### Cookie signing and verification

| Test | Description |
|---|---|
| Signs a kids cookie with correct role and timestamp | `signCookie("kids", secret, ts)` returns a string with two `.`-separated base64 segments |
| Verifies a valid kids cookie | `verifyCookie(cookie, "kids", secret)` returns `true` for a freshly signed cookie |
| Rejects a tampered cookie | Mutating any byte of the HMAC segment returns `false` |
| Rejects a cookie with wrong role | Cookie signed as `admin` rejected by kids verifier and vice versa |
| Rejects an expired cookie | Cookie with timestamp older than `Max-Age` returns `false` |
| Rejects a missing cookie | `undefined` or empty string returns `false` |

### Kids PIN auth (`POST /api/auth`)

| Test | Description |
|---|---|
| Returns 401 for wrong PIN | PIN not matching `UI_PIN` secret → 401 |
| Returns 401 for non-numeric PIN | Letters or symbols → 401 |
| Returns 401 for PIN shorter than 6 digits | 5-digit input → 401 |
| Returns 401 for PIN longer than 6 digits | 7-digit input → 401 |
| Returns 302 redirect on correct PIN | Valid PIN → redirect to `/app` with `Set-Cookie` header |
| Cookie has correct flags | Response `Set-Cookie` includes `__Secure-` prefix, `HttpOnly`, `Secure`, `SameSite=Strict`, `Max-Age` |
| Cookie value never logged | No PIN or cookie value appears in any log output |
| Returns 429 after 5 failed attempts | 5 wrong PINs → 6th attempt returns 429 |
| Lockout resets after successful auth | Correct PIN after 4 failures clears the counter |
| Lockout is per IP | Different IP not affected by another IP's failures |

### Admin password auth (`POST /api/admin/auth`)

| Test | Description |
|---|---|
| Returns 401 for wrong password | Password not matching `UI_ADMIN_PASSWORD` → 401 |
| Returns 302 redirect on correct password | Valid password → redirect to `/admin/app` with `Set-Cookie` header |
| Admin cookie has `admin` role | Cookie payload contains `admin` role, not `kids` |
| Returns 429 after 5 failed attempts | Same lockout behaviour as kids auth |

---

## `src/tests/command.test.ts`

### Kids command proxy (`POST /api/command`)

| Test | Description |
|---|---|
| Returns 401 with no cookie | Missing `__Secure-catt_session` cookie → 401 |
| Returns 401 with tampered cookie | Mutated HMAC segment → 401 |
| Returns 401 with admin cookie on kids endpoint | Admin cookie rejected by `/api/command` |
| Returns 401 with expired cookie | Cookie past `Max-Age` → 401 |
| Proxies valid command to catt_bff | Valid kids cookie + `{ command: "stop" }` → forwards to `CATT_BFF_URL/catt` with `X-API-Key` header |
| Attaches X-API-Key header | Proxied request includes `X-API-Key: <CATT_API_KEY>` |
| Forwards command body unchanged | `{ command, device, value }` forwarded as-is |
| Returns 504 when catt_bff times out | Request exceeding 10s timeout → 504 with plain error message |
| Returns catt_bff response status | If catt_bff returns 500, proxy returns 500 |
| Returns 429 after 60 requests/min | 61st request within 60s from same IP → 429 |

### Admin command proxy (`POST /api/admin/command`)

| Test | Description |
|---|---|
| Returns 401 with no cookie | Missing cookie → 401 |
| Returns 401 with kids cookie on admin endpoint | Kids cookie rejected by `/api/admin/command` |
| Returns 401 with tampered admin cookie | Mutated HMAC → 401 |
| Proxies valid command to catt_bff | Valid admin cookie → forwards to `CATT_BFF_URL/catt` |
| Attaches X-API-Key header | Same as kids proxy |
| Returns 504 on timeout | Same timeout behaviour as kids proxy |
| Returns 429 after 60 requests/min | Same rate limit as kids proxy |

### Admin logout (`POST /api/admin/logout`)

| Test | Description |
|---|---|
| Clears cookie on logout | Response sets `__Secure-catt_session` with `Max-Age=0` |
| Redirects to `/admin` after logout | Response is a 302 to `/admin` |
| Returns 401 with no cookie | Missing cookie → 401 (can't logout if not logged in) |

### Admin state proxy (`GET /api/admin/state`)

| Test | Description |
|---|---|
| Returns 401 with no cookie | Missing cookie → 401 |
| Returns 401 with kids cookie | Kids cookie rejected |
| Returns combined state and history | Valid admin cookie → fetches `/device/box/state` and `/device/box/history`, returns merged JSON |
| Active device prominent in response | Response includes `device` field from state |
| Passes through catt_bff error | If state fetch fails, returns appropriate error status |

### Kids state proxy (`GET /api/state`)

| Test | Description |
|---|---|
| Returns 401 with no cookie | Missing cookie → 401 |
| Returns 401 with admin cookie | Admin cookie rejected by kids state endpoint |
| Returns device and session | Valid kids cookie → returns `{ device, session }` from catt_bff state |

### Devices proxy (`GET /api/devices`)

| Test | Description |
|---|---|
| Returns 401 with no cookie | Missing cookie → 401 |
| Returns 401 with invalid cookie | Tampered HMAC → 401 |
| Returns device list for valid kids cookie | Valid kids cookie → proxies `GET /devices` from catt_bff, returns `[{ key, name }]` |
| Returns device list for valid admin cookie | Valid admin cookie also accepted |
| Passes through catt_bff error | If catt_bff returns error, proxy returns same status |

### Admin state polling behaviour

| Test | Description |
|---|---|
| Polls immediately on load | `GET /api/admin/state` called on page init |
| Polls again after 30 seconds | Timer fires a second call after 30s |
| Pauses when tab hidden | `visibilitychange` → `hidden` stops the interval |
| Resumes and fetches immediately when tab visible | `visibilitychange` → `visible` triggers fetch + restarts interval |
| Refreshes after every command | State fetch triggered after each `POST /api/admin/command` response |

### `UI_KIDS_ALLOW_SEARCH` variable

| Test | Description |
|---|---|
| Search row absent when `UI_KIDS_ALLOW_SEARCH` is `false` | Pages Function returns `allowSearch: false` in config response |
| Search row present when `UI_KIDS_ALLOW_SEARCH` is `true` | Pages Function returns `allowSearch: true` in config response |
| Search command proxied correctly | `{ command: "cast", value: "believer song" }` forwarded to catt_bff when search enabled |

### `UI_KIDS_ALLOW_DEVICE_SWITCH` variable

| Test | Description |
|---|---|
| Device shown as plain text when `UI_KIDS_ALLOW_DEVICE_SWITCH` is `false` | Pages Function returns `allowDeviceSwitch: false` in config response |
| Device switcher enabled when `UI_KIDS_ALLOW_DEVICE_SWITCH` is `true` | Pages Function returns `allowDeviceSwitch: true` in config response |
| Device switch command proxied correctly | `{ command: "device", value: "k" }` forwarded to catt_bff when device switch enabled |

---

## Coverage summary

| File | Covers |
|---|---|
| `auth.test.ts` | Cookie signing/verification, PIN validation (length, type, correctness), password validation, lockout (5 attempts, reset, per-IP), `__Secure-` cookie prefix and flags, no sensitive data in logs, role isolation |
| `command.test.ts` | Auth guard (missing/tampered/expired/wrong-role cookie), command proxying (kids and admin), header forwarding, 10s timeout → 504, rate limiting (60 req/min → 429), state+history merge, kids state proxy, devices proxy (kids + admin cookie, error passthrough), admin logout (cookie clear + redirect), admin state polling (visibility API, 30s interval, post-command refresh), `UI_KIDS_ALLOW_SEARCH` config, `UI_KIDS_ALLOW_DEVICE_SWITCH` config |
