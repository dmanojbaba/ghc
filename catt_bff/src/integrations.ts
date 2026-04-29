import { castCommand } from "./catt";
import { resolveDevice, INPUT_TO_DEVICE } from "./devices";

const DO_COMMANDS = new Set(["play", "stop", "prev", "next", "unmute"]);

function parseTokens(tokens: string[]): { device: string; rawValue: string } {
  const [second = "", ...rest] = tokens;
  if (second in INPUT_TO_DEVICE) {
    return { device: second, rawValue: rest.join(" ") };
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
  if (command === "tts") {
    await doStub.fetch(new Request(`https://do/device/box/site/${encodeURIComponent(rawValue)}`));
    return "tts";
  }
  if (command === "volume") {
    const val = rawValue.trim();
    if (val === "up" || val === "down") {
      const device_ = resolveDevice(device);
      await castCommand(env.CATT_SERVER_URL, device_, `volume${val}`, undefined, undefined, env.CATT_SERVER_SECRET);
    } else {
      await castCommand(env.CATT_SERVER_URL, resolveDevice(device), "volume", Number(val), undefined, env.CATT_SERVER_SECRET);
    }
    return "volume";
  }
  if (command === "mute") {
    const muted = (rawValue.trim() || "true") !== "false";
    await doStub.fetch(new Request(`https://do/device/box/mute/${muted}`));
    return "mute";
  }
  await doStub.fetch(new Request("https://do/device/box/catt", {
    method: "POST",
    body: JSON.stringify({ command: "cast", device, value: rawValue.trim() }),
  }));
  return "cast";
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

  const [command, ...rest] = tokens;
  if (!command) return new Response("Usage: <command> [device] [value]", { status: 200 });

  if (command === "state") {
    const res  = await doStub.fetch(new Request("https://do/device/box/state"));
    const json = await res.json();
    return new Response("```\n" + JSON.stringify(json, null, 2) + "\n```", { status: 200 });
  }

  const { device, rawValue } = parseTokens(rest);
  ctx.waitUntil(dispatchCommand(command, device, rawValue, env, doStub));
  return new Response(command, { status: 200 });
}

function verifyTelegramSecret(request: Request, env: Env): boolean {
  const secret = env.TELEGRAM_SECRET_TOKEN;
  if (!secret) return true;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
}

async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function handleTelegram(request: Request, env: Env, doStub: DurableObjectStub): Promise<Response> {
  if (!verifyTelegramSecret(request, env)) return Response.json({}, { status: 401 });

  const body    = await request.json() as { message?: { text?: string; chat?: { id: number } } };
  const text    = (body.message?.text ?? "").trim();
  const chatId  = body.message?.chat?.id;
  const tokens  = text.split(/\s+/);

  const [command, ...rest] = tokens;
  if (!command) return Response.json({});

  if (command === "state" && chatId && env.TELEGRAM_BOT_TOKEN) {
    const res   = await doStub.fetch(new Request("https://do/device/box/state"));
    const json  = await res.json();
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, JSON.stringify(json, null, 2));
    return Response.json({});
  }

  const { device, rawValue } = parseTokens(rest);
  await dispatchCommand(command, device, rawValue, env, doStub);
  return Response.json({});
}
