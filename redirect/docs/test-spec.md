# Test Spec: redirect Worker

Tests use Vitest with `vi.stubGlobal("fetch", ...)` to mock YouTube API calls. KV and R2 are mocked via `makeEnv()`. No real network calls or Cloudflare bindings needed.

## Setup

```js
// test helpers in index.test.js

function makeEnv(kvEntries = {}) {
  return {
    YOUTUBE_API_KEY: "test-api-key",
    kv: {
      get: vi.fn(async (key) => kvEntries[key] ?? null),
      put: vi.fn(),
      list: vi.fn(async () => ({
        keys: Object.keys(kvEntries).map((name) => ({ name })),
      })),
    },
    r2bkt: {
      get: vi.fn(async () => null),
    },
  };
}

function makeRequest(path, method = "GET", body = null, headers = {}) { ... }

function mockYoutubeSearch(items) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => ({ items }) })));
}
```

---

## 1. GET /ip

| # | Test | Input | Expected |
|---|---|---|---|
| 1.1 | Returns caller IP | `CF-Connecting-IP: 1.2.3.4` | Response body `"1.2.3.4"` |

---

## 2. GET /kv

| # | Test | Input | Expected |
|---|---|---|---|
| 2.1 | Lists keys as space-separated text | KV has `ping`, `sun`, `status` | Body contains `ping`, `sun`; does NOT contain `status` |
| 2.2 | Lists keys as JSON when `?output=json` | Any KV | `Content-Type: application/json`, body is array |
| 2.3 | Returns value for known key | `ping` → `https://example.com/ping` | Body `"https://example.com/ping"` |
| 2.4 | Returns `"null"` for unknown key | Key not in KV | Body `"null"` |
| 2.5 | Returns value as JSON when `?output=json` | `ping` → `https://example.com/ping` | Body `{"key": "ping", "value": "https://example.com/ping"}` |
| 2.6 | Lowercases key lookup | `/kv/PING` | `kv.get` called with `"ping"` |

---

## 3. GET /r

| # | Test | Input | Expected |
|---|---|---|---|
| 3.1 | Redirects to KV value when key exists | `ping` → `https://example.com/ping` | 302, `location: https://example.com/ping` |
| 3.2 | Falls back to YouTube search when key not in KV | Multi-word key not in KV | 302, `location` contains `youtube.com` |
| 3.3 | Returns `"null"` for empty key segment | `/r/` | Body `"null"` |
| 3.4 | Single-word KV miss → direct YouTube URL, no API call | `/r/abc123`, not in KV | 302 to `youtube.com/watch?v=abc123`; `fetch` not called |

---

## 4. GET /r2

| # | Test | Input | Expected |
|---|---|---|---|
| 4.1 | Returns `"null"` for empty key segment | `/r2/` | Body `"null"` |
| 4.2 | Returns `"null"` when object not found in R2 | Key not in R2 | Body `"null"` |
| 4.3 | Streams object body with headers | R2 object exists | Body equals object body; `etag` and `Content-Type` headers set |
| 4.4 | Lowercases key lookup | `/r2/SONG` | `r2bkt.get` called with `"song"` |

---

## 5. GET /y

| # | Test | Input | Expected |
|---|---|---|---|
| 5.1 | Returns `"null"` for empty key segment | `/y/` | Body `"null"` |
| 5.2 | Returns YouTube search result as JSON | `/y/Sun%20News` | `Content-Type: application/json`, body contains video ID |
| 5.3 | Passes extra query params to YouTube API | `/y/Sun%20News?maxResults=5` | `fetch` called with URL containing `maxResults=5` |
| 5.4 | Does not append `undefined` to API URL when no extra params | `/y/Sun%20News` | `fetch` called URL does not contain `"undefined"` |

---

## 6. Unknown Routes

| # | Test | Input | Expected |
|---|---|---|---|
| 6.1 | 404 for unknown GET path | `GET /unknown` | Status 404 |
| 6.2 | 404 for unknown POST path | `POST /unknown` | Status 404 |

---

## 7. POST /_raw

| # | Test | Input | Expected |
|---|---|---|---|
| 7.1 | Echoes request body | `POST /_raw` body `"hello"` | Response body `"hello"` |

---

## 8. POST /kv

| # | Test | Input | Expected |
|---|---|---|---|
| 8.1 | Returns KV value for key in body | `{"text": "ping"}`, KV has `ping` | Body is the KV value |
| 8.2 | Returns `"null"` for unknown key | `{"text": "missing"}` | Body `"null"` |
| 8.3 | Lists all keys when body has no `text` field | `{}`, KV has `ping`, `sun` | Body contains `ping` and `sun` |
| 8.4 | Lowercases key lookup | `{"text": "PING"}` | `kv.get` called with `"ping"` |

---

## 9. Scheduled (cron)

| # | Test | Input | Expected |
|---|---|---|---|
| 9.1 | Updates `pttv` and `sun` on news cron | `cron: "0 6-22 * * *"`, YouTube returns a match | `kv.put` called with `"pttv"` and `"sun"`, values contain `youtube.com` |
| 9.2 | Does nothing on placeholder cron | `cron: "3 3 * * *"` | `kv.put` not called |
| 9.3 | Does not write to KV when YouTube returns no valid video URL | YouTube returns no matching items (fallback URL) | `kv.put` not called; error logged |

---

## 10. `searchYoutube` — Single-word path

| # | Test | Input | Expected |
|---|---|---|---|
| 10.1 | No API call for single-word KV miss | `/r/abc123`, not in KV | Redirects to `youtube.com/watch?v=abc123` without calling `fetch` |
