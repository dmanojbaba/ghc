import { castCommand } from "./catt";
import { getParsedUrl } from "./urlHelper";
import { resolveDevice } from "./devices";

const DO_COMMANDS = new Set(["play", "stop", "prev", "next"]);

function resolveValue(value: string): string {
  return getParsedUrl(value);
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
  if (command === "tts") {
    await doStub.fetch(new Request(`https://do/device/box/site/${encodeURIComponent(rawValue)}`));
    return "tts";
  }
  if (command === "volume") {
    await castCommand(env.CATT_SERVER_URL, resolveDevice(device), "volume", Number(rawValue));
    return "volume";
  }
  await castCommand(env.CATT_SERVER_URL, resolveDevice(device), "cast", resolveValue(rawValue), {
    force_default: true,
  });
  return "cast";
}

export async function handleSlack(request: Request, env: Env, doStub: DurableObjectStub): Promise<Response> {
  const form   = await request.formData();
  const text   = (form.get("text") as string ?? "").trim();
  const tokens = text.split(/\s+/);

  const [command, device = "", ...rest] = tokens;
  if (!command) return new Response("Usage: <cast|volume|tts|play|stop|prev|next> [device] [url_or_value]", { status: 200 });

  const rawValue = rest.join(" ");
  const result = await dispatchCommand(command, device, rawValue, env, doStub);
  return new Response(result, { status: 200 });
}

function verifyTelegramSecret(request: Request, env: Env): boolean {
  const secret = env.TELEGRAM_SECRET_TOKEN;
  if (!secret) return true;
  return request.headers.get("X-Telegram-Bot-Api-Secret-Token") === secret;
}

export async function handleTelegram(request: Request, env: Env, doStub: DurableObjectStub): Promise<Response> {
  if (!verifyTelegramSecret(request, env)) return Response.json({}, { status: 401 });

  const body   = await request.json() as { message?: { text?: string } };
  const text   = (body.message?.text ?? "").trim();
  const tokens = text.split(/\s+/);

  const [command, device = "", ...rest] = tokens;
  if (!command) return Response.json({});

  const rawValue = rest.join(" ");
  await dispatchCommand(command, device, rawValue, env, doStub);
  return Response.json({});
}
