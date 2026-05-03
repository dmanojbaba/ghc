# Plan: Natural Language Commands for Telegram via Workers AI

## Background

Telegram commands currently require strict positional syntax: `cast kitchen jazz`, `sleep 30`, `channel sun`.
Users must remember exact command names, device aliases, and token order. A typo or unrecognised first token silently falls through as an unknown cast.

Workers AI (available as a first-party Cloudflare binding — no new Worker needed) can parse free-form messages into the structured commands that `dispatchCommand` already expects. The existing command path is unchanged; AI is only invoked when the first token is not a known command.

## Scope

- **In scope**: `handleTelegram` in `src/integrations.ts`
- **Out of scope**: `handleSlack` (Slack is primarily slash commands — strict syntax works well there)
- **Not required**: new Worker, new routes, changes to `DeviceQueue.ts`, `cattHandler.ts`, or `googleHome.ts`

## How it fits in

```
Telegram message
      │
      ▼
known command? ──yes──► existing parseTokens → dispatchCommand  (unchanged)
      │
      no
      │
      ▼
parseWithAI(text, env)   ← Workers AI binding on env.CATT_AI
      │
      ├── parsed ok  ──► dispatchCommand (unchanged)
      └── null       ──► sendTelegramMessage("I didn't understand that")
```

## Infrastructure change

Add to `wrangler.toml` (no new Worker, no new secret):

```toml
[ai]
binding = "CATT_AI"
```

Add to `worker-configuration.d.ts` (or regenerate via `npm run cf-typegen`):

```ts
CATT_AI: Ai;
```

## Stages

### Stage 1: Workers AI binding
**Goal**: `env.AI` is available at runtime.
**Tasks**:
- Add `[ai]` binding to `wrangler.toml`
- Add `AI: Ai` to `worker-configuration.d.ts`
- Verify `wrangler deploy --dry-run` succeeds

---

### Stage 2: `parseWithAI()` in `integrations.ts`
**Goal**: Function that maps a free-form message to `{ command, device?, value? }` or `null`.

**Model**: `@cf/meta/llama-3.1-8b-instruct-fast`
(fast enough for Telegram — ~1–2 s p99; Telegram has no hard response deadline unlike Slack's 3 s limit)

**System prompt** (built at call time with live device + channel lists):

```
You are a command parser for a Chromecast controller.
Return ONLY valid JSON: {"command":"...","device":"...","value":"..."}
device and value are optional.

Valid commands: cast, tts, volume, mute, unmute, play, stop, clear, reset,
prev, next, rewind, ffwd, sleep, channel, device, state, help

Valid device keys: k=Kitchen, o=Office, b=Bedroom, zbk=ZBK, tv=TV, otv=Office TV

Valid channel keys: <injected from getChannelList() at call time>

Examples:
  "play some jazz"              → {"command":"cast","value":"jazz music"}
  "put kitchen on"              → {"command":"device","value":"k"}
  "turn off in 20 minutes"      → {"command":"sleep","value":"20"}
  "louder"                      → {"command":"volume","value":"up"}
  "switch to the news channel"  → {"command":"channel","value":"news"}

If you cannot map the message to a valid command, return {"command":"unknown"}.
```

**Error handling**:
- AI returns `{"command":"unknown"}` → return `null`
- AI returns malformed JSON → catch + return `null`
- AI call throws (network, quota) → catch + return `null`
- All `null` paths → send "I didn't understand that" to Telegram

---

### Stage 3: Wire into `handleTelegram`
**Goal**: Free-form messages that fail the existing parser are retried via `parseWithAI`.

**Change**: after the known-command checks and before `dispatchCommand`, add:

```ts
if (!KNOWN_COMMANDS.has(command) && !(command in INPUT_TO_DEVICE)) {
  const parsed = await parseWithAI(text, env);
  if (!parsed) {
    if (chatId && env.TELEGRAM_BOT_TOKEN) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "I didn't understand that");
    }
    return Response.json({});
  }
  // use parsed.command / parsed.device / parsed.value
}
```

Confirmation message sent back to Telegram shows the interpreted command so the user can see what was understood (e.g. "cast: jazz music").

---

### Stage 4: Tests
**Goal**: Full coverage of the AI fallback path in `integrations.test.ts`.

**Setup**: `env.AI = { run: vi.fn() }` in `makeEnv()`.

| Test | Expected behaviour |
|---|---|
| Natural language → valid parse | `AI.run` called; correct DO fetch made |
| AI returns `{"command":"unknown"}` | `sendMessage` called with "I didn't understand that" |
| AI returns malformed JSON | graceful null path; no crash |
| AI throws | graceful null path; no crash |
| Known command (`cast kitchen jazz`) | `AI.run` NOT called |

---

## Trade-offs

| Concern | Detail |
|---|---|
| **Cost** | Workers AI billed per neuron; negligible for personal use |
| **Latency** | 8B model adds ~1–2 s; fine for Telegram (no hard deadline) |
| **Accuracy** | Structured prompt + JSON schema keeps output deterministic enough |
| **Safety** | AI path never triggered for known commands — zero regression risk |
| **Fallback** | `null` → explicit error message, not a silent no-op |
