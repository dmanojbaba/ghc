# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run start   # wrangler dev (local)
npm run deploy  # wrangler deploy
```

```bash
npm test            # vitest run (once)
npm run test:watch  # vitest watch
```

Run a single test file:
```bash
npx vitest run src/tests/index.test.js
```

## Architecture

Single-file Cloudflare Worker (`src/index.js`). URL shortener and redirect service deployed at `r.manojbaba.com`.

### Routes (GET)

| Path | Behaviour |
|---|---|
| `/ip` | Returns the caller's IP (`CF-Connecting-IP`) |
| `/kv` | Lists all KV keys |
| `/kv/<key>` | Returns KV value for key (add `?output=json` for JSON) |
| `/r/<key>` | Redirects (302) to KV value; if key not found, falls back to YouTube search |
| `/r2/<key>` | Streams file from R2 bucket `md24` |
| `/y/<key>` | Returns raw YouTube search result as JSON |

### Routes (POST)

| Path | Behaviour |
|---|---|
| `/_raw` | Echoes request body |
| `/kv` | Returns KV value for key from JSON body (`{text: "<key>"}`) |

### Scheduled jobs (cron)

- **`0 6-22 * * *`** (hourly, 6am–10pm): Searches YouTube for latest Puthiyathalaimurai and Sun News headlines and updates `pttv` and `sun` KV keys.
- **`3 3 * * *`** (3:03am daily): No-op placeholder.

### Bindings

- **`kv`** — KV namespace (id: `be6bd0ccbf1148c9a1c90a38598697cb`) for link shortcodes
- **`r2bkt`** — R2 bucket `md24` for file storage
- **`YOUTUBE_API_KEY`** — YouTube Data API v3 key (secret, set via `wrangler secret put YOUTUBE_API_KEY`).

### YouTube search logic (`searchYoutube`)

- Single-word input (no spaces), `raw=false` → returns `youtube.com/watch?v=<id>` directly without an API call
- Single-word input (no spaces), `raw=true` → looks up the video ID via the YouTube `/videos` API and returns result JSON
- Multi-word input → calls YouTube Search API, iterates results looking for a title match (exact or `altMatchText` prefix); falls back to first result
- `raw=false` → returns a YouTube URL string
- `raw=true` → returns JSON with `result`, `videoUrl`, `videoTitle`; `result` is `"N/total"` (match position) or `"0/total"` (no match found, fell back to first result)
