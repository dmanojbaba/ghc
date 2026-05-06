import { getChannelKey, resolveDevice, DEVICE_ID } from "./devices";
import { castCommand } from "./catt";

const DO_COMMANDS = new Set(["play", "stop", "prev", "next", "unmute", "clear", "reset"]);
const DO_VALUE_COMMANDS = new Set(["rewind", "ffwd", "sleep", "mute"]);

function doUrl(deviceKey: string, path: string): string {
  return `https://do/device/${deviceKey}${path}`;
}

export async function handleCatt(request: Request, env: Env, doStub: DurableObjectStub, deviceKey = ""): Promise<Response> {
  const body = await request.json() as { command?: string; value?: string; device?: string };
  if (!body.command) return new Response("'command' is required", { status: 400 });
  try {
    return await handleCattInner(body as { command: string; value?: string; device?: string }, env, doStub, deviceKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Command failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleCattInner(body: { command: string; value?: string; device?: string }, env: Env, doStub: DurableObjectStub, deviceKey: string): Promise<Response> {

  if (DO_COMMANDS.has(body.command)) {
    return doStub.fetch(new Request(doUrl(deviceKey, `/${body.command}`)));
  }

  if (DO_VALUE_COMMANDS.has(body.command)) {
    const arg = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(doUrl(deviceKey, `/${body.command}/${arg}`)));
  }

  if (body.command === "app") {
    const key = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(doUrl(deviceKey, `/set/app/${key}`)));
  }
  if (body.command === "channel") {
    const arg = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(doUrl(deviceKey, `/channel/${arg}`)));
  }

  if (body.command === "playlist") {
    if (body.value) {
      return doStub.fetch(new Request(doUrl(deviceKey, "/catt"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "cast", value: body.value }),
      }));
    }
    return doStub.fetch(new Request(doUrl(deviceKey, "/shuffle")));
  }

  if (body.command === "volume") {
    const val = body.value ?? "";
    const device = resolveDevice(body.device ?? deviceKey);
    if (val === "up" || val === "down") {
      await castCommand(env.CATT_BACKEND_URL, device, `volume${val}`, undefined, undefined, env.CATT_BACKEND_SECRET);
    } else {
      await castCommand(env.CATT_BACKEND_URL, device, "volume", Number(val), undefined, env.CATT_BACKEND_SECRET);
    }
    return new Response("ok");
  }

  if (body.command === "state") {
    const res = await doStub.fetch(new Request(doUrl(deviceKey, "/state")));
    if (!res.ok) return res;
    const state = await res.json() as Record<string, unknown>;
    return Response.json({ device: deviceKey, ...state }, { headers: { "cache-control": "no-store" } });
  }

  if (body.command === "history") {
    return doStub.fetch(new Request(doUrl(deviceKey, "/history")));
  }

  if (body.command === "jump") {
    const pos = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(doUrl(deviceKey, `/jump/${pos}`)));
  }

  if (body.command === "tts" || body.command === "broadcast" || body.command === "speak" || body.command === "talk") {
    const arg = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(doUrl(deviceKey, `/site/${arg}`)));
  }

  if (body.command === "cast") {
    const val = body.value ?? "";
    const channelKey = val && !val.startsWith("http") ? getChannelKey(DEVICE_ID, val) : null;
    if (channelKey) {
      return doStub.fetch(new Request(doUrl(deviceKey, `/channel/${encodeURIComponent(channelKey)}`)));
    }
  }

  return doStub.fetch(new Request(doUrl(deviceKey, "/catt"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}
