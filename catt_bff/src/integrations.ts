import { castCommand } from "./catt";
import { resolveDevice, INPUT_TO_DEVICE, getChannelKey, getDeviceList, getChannelListWithSynonyms, DEVICE_ID } from "./devices";

const DO_COMMANDS = new Set(["play", "stop", "prev", "next", "unmute", "clear", "reset"]);

const HELP_TEXT = `Commands: <command> [device] [value]
cast [device] [url]   – cast URL (omit for next)
tts/speak/talk [text] – speak text
volume [device] <n>   – set volume 0–100
volume up/down        – step volume
mute / unmute         – mute toggle
play                  – toggle play/pause
stop                  – stop and clear queue
clear                 – reset state to defaults (keeps device and app)
reset                 – full reset including device and app
prev                  – replay previous
next                  – skip to next
rewind [seconds]      – rewind (default 30s)
ffwd [seconds]        – fast-forward (default 30s)
sleep <minutes>       – sleep timer
sleep cancel          – cancel sleep timer
channel up/down       – next/previous channel
channel <name>        – switch to named channel
device <key>          – set active device
state                 – show device state
help                  – show this message`;

function parseTokens(tokens: string[]): { device: string; rawValue: string } {
  const [second = "", ...rest] = tokens;
  const secondLower = second.toLowerCase();
  if (secondLower in INPUT_TO_DEVICE) {
    return { device: secondLower, rawValue: rest.join(" ") };
  }
  return { device: "", rawValue: [second, ...rest].join(" ").trim() };
}


async function dispatchCommand(
  command: string,
  device: string,
  rawValue: string,
  env: Env,
  doStub: DurableObjectStub,
): Promise<string> {
  if (DO_COMMANDS.has(command)) {
    await doStub.fetch(new Request(`https://do/device/box/${command}`));
    return command;
  }
  if (command === "rewind" || command === "ffwd") {
    const seconds = rawValue.trim() || device;
    await doStub.fetch(new Request(`https://do/device/box/${command}/${encodeURIComponent(seconds)}`));
    return command;
  }
  if (command === "sleep") {
    const arg = rawValue.trim() || device;
    await doStub.fetch(new Request(`https://do/device/box/sleep/${encodeURIComponent(arg)}`));
    return "sleep";
  }
  if (command === "tts" || command === "speak" || command === "talk") {
    await doStub.fetch(new Request(`https://do/device/box/site/${encodeURIComponent(rawValue)}`));
    return "tts";
  }
  if (command === "volume") {
    const val = rawValue.trim();
    if (val === "up" || val === "down") {
      const device_ = resolveDevice(device);
      await castCommand(env.CATT_BACKEND_URL, device_, `volume${val}`, undefined, undefined, env.CATT_BACKEND_SECRET);
    } else {
      await castCommand(env.CATT_BACKEND_URL, resolveDevice(device), "volume", Number(val), undefined, env.CATT_BACKEND_SECRET);
    }
    return "volume";
  }
  if (command === "device") {
    const key = rawValue.trim() || device;
    await doStub.fetch(new Request(`https://do/device/box/set/device/${encodeURIComponent(key)}`));
    return "device";
  }
  if (command === "channel") {
    const arg = rawValue.trim() || device;
    await doStub.fetch(new Request(`https://do/device/box/channel/${encodeURIComponent(arg)}`));
    return "channel";
  }
  if (command === "mute") {
    const muted = (rawValue.trim() || "true") !== "false";
    await doStub.fetch(new Request(`https://do/device/box/mute/${muted}`));
    return "mute";
  }
  const val = rawValue.trim();
  const channelKey = val && !val.startsWith("http") ? getChannelKey(DEVICE_ID, val) : null;
  if (channelKey) {
    await doStub.fetch(new Request(`https://do/device/box/channel/${encodeURIComponent(channelKey)}`));
    return "channel";
  }
  await doStub.fetch(new Request("https://do/device/box/catt", {
    method: "POST",
    body: JSON.stringify({ command: "cast", device, value: val }),
  }));
  return "cast";
}

const KNOWN_COMMANDS = new Set([
  "cast", "tts", "speak", "talk", "volume", "mute", "unmute", "play", "stop",
  "clear", "reset", "prev", "next", "rewind", "ffwd", "sleep", "channel", "device", "state", "help",
]);

type ParsedCommand = { command: string; device?: string; value?: string };

async function parseWithAI(text: string, env: Env): Promise<ParsedCommand | null> {
  if (!env.CATT_AI) return null;

  const devices = getDeviceList(DEVICE_ID).map((d) => `${d.key}=${d.name}`).join(", ");
  const channels = getChannelListWithSynonyms(DEVICE_ID)
    .map((c) => `${c.key}=${c.names.join("|")}`)
    .join(", ");

  const systemPrompt = `You are a command parser for a Chromecast controller.
Return ONLY valid JSON with this shape: {"command":"...","device":"...","value":"..."}
device and value are optional strings.

Valid commands: cast, tts, volume, mute, unmute, play, stop, clear, reset, prev, next, rewind, ffwd, sleep, channel, device, state, help

Valid device keys (use the key, not the name): ${devices}

Valid channel keys and all their names (use the key as value): ${channels}

Examples:
  "put on some jazz"            -> {"command":"cast","value":"jazz music"}
  "set kitchen volume to 50"   -> {"command":"volume","device":"k","value":"50"}
  "put kitchen on"             -> {"command":"device","value":"k"}
  "turn off in 20 minutes"     -> {"command":"sleep","value":"20"}
  "louder"                     -> {"command":"volume","value":"up"}
  "switch to the news channel" -> {"command":"channel","value":"news"}
  "speak hello"                -> {"command":"tts","value":"hello"}
  "Radio Rahman"               -> {"command":"channel","value":"arr"}
  "Radio Lime"                 -> {"command":"channel","value":"lime"}

If you cannot map the message to a valid command, return {"command":"unknown"}.`;

  try {
    const result = await env.CATT_AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
    }) as { response?: string };

    const raw = result.response?.trim() ?? "";
    const parsed = JSON.parse(raw) as ParsedCommand;
    if (!parsed.command || parsed.command === "unknown" || !KNOWN_COMMANDS.has(parsed.command)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function verifySlackSignature(request: Request, env: Env, body: string): Promise<boolean> {
  const secret = env.SLACK_SIGNING_SECRET;
  if (!secret) return true;
  const timestamp = request.headers.get("X-Slack-Request-Timestamp") ?? "";
  const signature = request.headers.get("X-Slack-Signature") ?? "";
  const baseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  const computed = "v0=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return computed === signature;
}

export async function handleSlack(request: Request, env: Env, ctx: ExecutionContext, doStub: DurableObjectStub): Promise<Response> {
  const body   = await request.text();
  if (!await verifySlackSignature(request, env, body)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const form   = new URLSearchParams(body);
  const text   = (form.get("text") ?? "").trim();
  const tokens = text.split(/\s+/);

  const [rawCommand, ...rest] = tokens;
  const command = rawCommand.toLowerCase();
  if (!command) return new Response("Usage: <command> [device] [value]", { status: 200 });

  if (command === "help") {
    return new Response("```\n" + HELP_TEXT + "\n```", { status: 200 });
  }

  if (command === "state") {
    const res  = await doStub.fetch(new Request("https://do/device/box/state"));
    const json = truncateStateQueue(await res.json() as Record<string, unknown>);
    return new Response("```\n" + JSON.stringify(json, null, 2) + "\n```", { status: 200 });
  }

  if (command in INPUT_TO_DEVICE) {
    await doStub.fetch(new Request(`https://do/device/box/set/device/${encodeURIComponent(command)}`));
    const res  = await doStub.fetch(new Request("https://do/device/box/state"));
    const json = truncateStateQueue(await res.json() as Record<string, unknown>);
    return new Response("```\n" + JSON.stringify(json, null, 2) + "\n```", { status: 200 });
  }

  const { device, rawValue } = parseTokens(rest);

  if (command === "device" || command === "clear" || command === "reset") {
    await dispatchCommand(command, device, rawValue, env, doStub);
    const res  = await doStub.fetch(new Request("https://do/device/box/state"));
    const json = truncateStateQueue(await res.json() as Record<string, unknown>);
    return new Response("```\n" + JSON.stringify(json, null, 2) + "\n```", { status: 200 });
  }

  ctx.waitUntil(dispatchCommand(command, device, rawValue, env, doStub));
  return new Response(command, { status: 200 });
}

function verifyTelegramSecret(request: Request, env: Env): boolean {
  const secret = env.TELEGRAM_SECRET_TOKEN;
  if (!secret) return true;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
}

function truncateStateQueue(json: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(json.queue) && json.queue.length > 5) {
    return { ...json, queue: [...json.queue.slice(0, 5), `… ${json.queue.length - 5} more`] };
  }
  return json;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramMessage(token: string, chatId: number, text: string, pre = false): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pre
      ? { chat_id: chatId, text: `<pre>${escapeHtml(text)}</pre>`, parse_mode: "HTML" }
      : { chat_id: chatId, text }),
  });
}

export async function handleTelegram(request: Request, env: Env, doStub: DurableObjectStub): Promise<Response> {
  if (!verifyTelegramSecret(request, env)) return Response.json({}, { status: 401 });

  const body    = await request.json() as { message?: { text?: string; chat?: { id: number } } };
  const text    = (body.message?.text ?? "").trim();
  const chatId  = body.message?.chat?.id;

  if (env.TELEGRAM_ALLOWED_CHAT_IDS) {
    const allowed = env.TELEGRAM_ALLOWED_CHAT_IDS.split(",").map((s) => s.trim());
    if (!chatId || !allowed.includes(String(chatId))) return Response.json({});
  }

  const tokens  = text.split(/\s+/);

  const [rawCommand, ...rest] = tokens;
  const command = (rawCommand.startsWith("/") ? rawCommand.slice(1) : rawCommand).toLowerCase();
  if (!command) return Response.json({});

  if (chatId && env.TELEGRAM_BOT_TOKEN) {
    if (command === "help") {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, HELP_TEXT, true);
      return Response.json({});
    }
    if (command === "state") {
      const res   = await doStub.fetch(new Request("https://do/device/box/state"));
      const json  = truncateStateQueue(await res.json() as Record<string, unknown>);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, JSON.stringify(json, null, 2), true);
      return Response.json({});
    }
  }

  if (command in INPUT_TO_DEVICE) {
    await doStub.fetch(new Request(`https://do/device/box/set/device/${encodeURIComponent(command)}`));
    if (chatId && env.TELEGRAM_BOT_TOKEN) {
      const res  = await doStub.fetch(new Request("https://do/device/box/state"));
      const json = truncateStateQueue(await res.json() as Record<string, unknown>);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, JSON.stringify(json, null, 2), true);
    }
    return Response.json({});
  }

  const { device, rawValue } = parseTokens(rest);

  if (!KNOWN_COMMANDS.has(command)) {
    const parsed = await parseWithAI(text, env);
    if (!parsed) {
      if (chatId && env.TELEGRAM_BOT_TOKEN) {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "I didn't understand that");
      }
      return Response.json({});
    }
    if (parsed.device && parsed.device in INPUT_TO_DEVICE) {
      await doStub.fetch(new Request(`https://do/device/box/set/device/${encodeURIComponent(parsed.device)}`));
    }
    const dispatched = await dispatchCommand(parsed.command, parsed.device ?? "", parsed.value ?? "", env, doStub);
    if (chatId && env.TELEGRAM_BOT_TOKEN) {
      const lines = [`${dispatched}: ${parsed.value ?? ""}`.trim()];
      if (parsed.device) lines.push(`device: ${parsed.device}`);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, lines.join("\n"));
    }
    return Response.json({});
  }

  await dispatchCommand(command, device, rawValue, env, doStub);

  if (chatId && env.TELEGRAM_BOT_TOKEN && (command === "clear" || command === "reset" || command === "device")) {
    const res  = await doStub.fetch(new Request("https://do/device/box/state"));
    const json = truncateStateQueue(await res.json() as Record<string, unknown>);
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, JSON.stringify(json, null, 2), true);
  }

  return Response.json({});
}
