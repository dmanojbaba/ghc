import { getChannelKey, resolveDevice, DEVICE_ID } from "./devices";
import { castCommand } from "./catt";

const DO_COMMANDS = new Set(["play", "stop", "prev", "next", "unmute", "clear", "reset"]);
const DO_VALUE_COMMANDS = new Set(["rewind", "ffwd", "sleep", "mute"]);

export async function handleCatt(request: Request, env: Env, doStub: DurableObjectStub): Promise<Response> {
  const body = await request.json() as { command?: string; value?: string; device?: string };
  if (!body.command) return new Response("'command' is required", { status: 400 });

  if (DO_COMMANDS.has(body.command)) {
    return doStub.fetch(new Request(`https://do/device/box/${body.command}`));
  }

  if (DO_VALUE_COMMANDS.has(body.command)) {
    const arg = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(`https://do/device/box/${body.command}/${arg}`));
  }

  if (body.command === "device") {
    const key = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(`https://do/device/box/set/device/${key}`));
  }
  if (body.command === "app") {
    const key = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(`https://do/device/box/set/app/${key}`));
  }
  if (body.command === "channel") {
    const arg = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(`https://do/device/box/channel/${arg}`));
  }

  if (body.command === "playlist") {
    if (body.device) {
      await doStub.fetch(new Request(`https://do/device/box/set/device/${encodeURIComponent(body.device)}`));
    }
    if (body.value) {
      return doStub.fetch(new Request("https://do/device/box/catt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "cast", device: body.device ?? "", value: body.value }),
      }));
    }
    return doStub.fetch(new Request("https://do/device/box/shuffle"));
  }

  if (body.command === "volume") {
    const val = body.value ?? "";
    const device = resolveDevice(body.device ?? "");
    if (val === "up" || val === "down") {
      await castCommand(env.CATT_BACKEND_URL, device, `volume${val}`, undefined, undefined, env.CATT_BACKEND_SECRET);
    } else {
      await castCommand(env.CATT_BACKEND_URL, device, "volume", Number(val), undefined, env.CATT_BACKEND_SECRET);
    }
    return new Response("ok");
  }

  if (body.command === "state") {
    return doStub.fetch(new Request("https://do/device/box/state"));
  }

  if (body.command === "history") {
    return doStub.fetch(new Request("https://do/device/box/history"));
  }

  if (body.command === "jump") {
    const pos = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(`https://do/device/box/jump/${pos}`));
  }

  if (body.command === "tts" || body.command === "speak" || body.command === "talk") {
    const arg = encodeURIComponent(body.value ?? "");
    return doStub.fetch(new Request(`https://do/device/box/site/${arg}`));
  }

  if (body.command === "cast") {
    const val = body.value ?? "";
    const channelKey = val && !val.startsWith("http") ? getChannelKey(DEVICE_ID, val) : null;
    if (channelKey) {
      return doStub.fetch(new Request(`https://do/device/box/channel/${encodeURIComponent(channelKey)}`));
    }
  }

  return doStub.fetch(new Request("https://do/device/box/catt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}
