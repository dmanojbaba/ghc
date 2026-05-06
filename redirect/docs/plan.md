# Plan: redirect — URL Shortener & YouTube Search Worker

## Context

Single-file Cloudflare Worker (`src/index.js`) deployed at `redirect.example.com`. Serves as a URL shortener backed by Cloudflare KV, a YouTube search proxy, and a scheduled job that keeps shortcodes for daily news streams up to date.

Used by `catt_bff` — shortcodes like `pttv`, `sun`, `ping`, `pingmp3`, `pingmp4` are stored in KV here and resolved by appending `https://redirect.example.com/r/<key>` before sending to `catt_backend`.

---

## Project Structure

```
redirect/
├── src/
│   ├── index.js          # Worker entrypoint — all routes + scheduled handler
│   └── tests/
│       └── index.test.js
├── docs/
│   ├── plan.md
│   └── test-spec.md
├── wrangler.toml
└── package.json
```

---

## Architecture

```
Client / catt_bff
    │
    ▼
GET/POST redirect.example.com
    │
    ├── /ip          → CF-Connecting-IP header
    ├── /kv[/<key>]  → KV namespace read (GET + POST)
    ├── /r/<key>     → 302 redirect (KV lookup → YouTube search fallback)
    ├── /r2/<key>    → R2 bucket file stream
    └── /y/<key>     → raw YouTube search JSON (debug)

Cron (0 6-22 * * *):
    └── searchYoutube("pttv") + searchYoutube("sun") → kv.put
```

---

## Bindings

| Binding | Type | Purpose |
|---|---|---|
| `kv` | KV namespace | Shortcodes + pre-fetched YouTube URLs |
| `r2bkt` | R2 bucket `md24` | Static file storage |
| `YOUTUBE_API_KEY` | Secret | YouTube Data API v3 |

---

## Routes (GET)

| Path | Behaviour |
|---|---|
| `/ip` | Returns `CF-Connecting-IP` header value as plain text |
| `/kv` | Lists all KV keys (excluding `status`) as space-separated text; `?output=json` returns full key array as JSON |
| `/kv/<key>` | Returns KV value for key (lowercased); returns `"null"` string if missing; `?output=json` wraps as `{"key": ..., "value": ...}` |
| `/r/<key>` | 302 redirect to KV value if found; falls back to `searchYoutube(key)` if not; returns `"null"` if no key segment |
| `/r2/<key>` | Streams R2 object body with `Content-Type` and `ETag` headers; returns `"null"` if not found or no key segment; lowercases key |
| `/y/<key>` | Returns raw `searchYoutube(key, raw=true)` JSON; passes extra query params to YouTube API; returns `"null"` if no key segment |

---

## Routes (POST)

| Path | Behaviour |
|---|---|
| `/_raw` | Echoes request body as plain text |
| `/kv` | Returns KV value for `body.text` key (lowercased); returns `"null"` if missing; returns key list if body has no `text` field |

---

## Scheduled Jobs (cron)

| Schedule | Trigger | Action |
|---|---|---|
| `0 6-22 * * *` | Hourly, 6am–10pm UTC | Search YouTube for latest Puthiyathalaimurai and Sun News headlines; write URLs to `pttv` and `sun` KV keys if valid YouTube watch URLs are returned |
| `3 3 * * *` | 3:03am UTC daily | No-op placeholder |

The cron guard (`isVideoUrl`) ensures only `https://www.youtube.com/watch?v=` URLs are written to KV — if `searchYoutube` returns a fallback URL (e.g. `https://www.youtube.com`), the key is not updated and an error is logged.

---

## `searchYoutube(env, searchText, raw, extraParams, altMatchText)`

Core function used by `/r`, `/y`, and the cron.

| Input | Behaviour |
|---|---|
| Single word, `raw=false` | Returns `youtube.com/watch?v=<searchText>` directly — no API call |
| Single word, `raw=true` | Calls YouTube `/videos` API by ID; returns JSON with `videoUrl` + `videoTitle` |
| Multi-word, any `raw` | Calls YouTube Search API; iterates results for title match (exact substring or `altMatchText` prefix); falls back to first result if no match |

Return value:
- `raw=false` → YouTube URL string (or `https://www.youtube.com` on error)
- `raw=true` → JSON string with `{ result, videoUrl, videoTitle }` where `result` is `"N/total"` (match position) or `"0/total"` (no match, fell back)

---

## Key Decisions

| Decision | Rationale |
|---|---|
| Single-file worker | No routing framework needed — worker is small and unlikely to grow |
| KV for shortcodes | Persistent, globally distributed, zero infrastructure |
| Cron for news URLs | Avoids hitting YouTube API on every news cast request; pre-fetches during waking hours only |
| `isVideoUrl` guard in cron | Prevents overwriting KV with fallback/error URLs when YouTube API fails or key expires |
| Single-word `/r` shortcut | Bare video IDs (e.g. `abc123`) are redirected without an API call — used by `catt_bff` for channel shortcodes |
| `status` key excluded from `/kv` listing | Internal health-check key; not a user shortcode |

---

## `wrangler.toml`

```toml
name = "redirect"
main = "src/index.js"
compatibility_date = "2022-10-21"

kv_namespaces = [
  { binding = "kv", id = "be6bd0ccbf1148c9a1c90a38598697cb" }
]

[[r2_buckets]]
binding = "r2bkt"
bucket_name = "md24"

[triggers]
crons = ["0 6-22 * * *", "3 3 * * *"]
```

### Worker Secrets (`wrangler secret put`)

| Secret | Description |
|---|---|
| `YOUTUBE_API_KEY` | Google YouTube Data API v3 key |

---

## Deployment

```bash
cd redirect
npm install
wrangler secret put YOUTUBE_API_KEY
npm run deploy
```
