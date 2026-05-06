import { DeviceQueue } from "./DeviceQueue";
import { handleFulfillment, handleSync, handleQuery } from "./googleHome";
import { handleOAuthAuth, handleOAuthToken } from "./oauth";
import { handleSlack, handleTelegram } from "./integrations";
import { handleCatt } from "./cattHandler";
import { DEVICE_ID, DEFAULT_DEVICE, getAllDeviceKeys, getDeviceList, getChannelList, getInputKey } from "./devices";

export { DeviceQueue };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getDoStub(env: Env, deviceId: string): DurableObjectStub {
  const id = env.DEVICE_QUEUE.idFromName(deviceId);
  return env.DEVICE_QUEUE.get(id);
}

async function getSessionDeviceKey(env: Env, sessionKey: string): Promise<string> {
  return (await env.CALLER_KV.get(sessionKey)) ?? DEFAULT_DEVICE;
}

function resolveSessionKey(request: Request, body: { caller?: string }): string {
  const xcaller = request.headers.get("X-Caller");
  if (xcaller === "kids") return "ui:kids";
  if (xcaller === "admin") return "ui:admin";
  return `http:${body.caller ?? "default"}`;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    // Auth check for all routes except Google Home and OAuth
    const isPublicPath = path === "/fulfillment" || path.startsWith("/oauth/") || path === "/echo" || path === "/slack" || path === "/telegram";
    if (!isPublicPath) {
      const apiKey = env.CATT_API_KEY;
      if (apiKey && request.headers.get("X-API-Key") !== apiKey) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // Google Home fulfillment
    if (path === "/fulfillment" && method === "POST") {
      const deviceKey = await getSessionDeviceKey(env, "googlehome:all");
      return handleFulfillment(request, env, getDoStub(env, deviceKey), deviceKey);
    }

    // Debug: verify SYNC response without going through Google
    if (path === "/gsync" && method === "GET") {
      return new Response(JSON.stringify(await handleSync("debug"), null, 2), { headers: { "content-type": "application/json" } });
    }

    // Debug: verify QUERY response without going through Google
    if (path === "/gquery" && method === "GET") {
      return new Response(JSON.stringify(await handleQuery("debug", { devices: [{ id: DEVICE_ID }] }, getDoStub(env, DEVICE_ID)), null, 2), { headers: { "content-type": "application/json" } });
    }

    // OAuth
    if (path === "/oauth/auth") {
      return handleOAuthAuth(request);
    }
    if (path === "/oauth/token" && method === "POST") {
      return handleOAuthToken();
    }

    // Device list
    if (path === "/devices" && method === "GET") {
      return Response.json(getDeviceList(DEVICE_ID));
    }

    // Channel list
    if (path === "/channels" && method === "GET") {
      return Response.json(getChannelList(DEVICE_ID));
    }

    // Ad-hoc POST endpoint
    if (path === "/catt" && method === "POST") {
      const body = await request.clone().json() as { command?: string; value?: string; device?: string; caller?: string };
      const sessionKey = resolveSessionKey(request, body);
      let deviceKey = await getSessionDeviceKey(env, sessionKey);

      if (body.command === "device") {
        const resolvedKey = getInputKey(DEVICE_ID, body.value ?? "", null);
        if (resolvedKey) {
          await env.CALLER_KV.put(sessionKey, resolvedKey);
          deviceKey = resolvedKey;
        }
        const stub = getDoStub(env, deviceKey);
        const stateRes = await stub.fetch(new Request(`https://do/device/${deviceKey}/state`));
        const state = await stateRes.json() as Record<string, unknown>;
        return Response.json({ device: deviceKey, ...state }, { headers: { "cache-control": "no-store" } });
      }

      const isQueueDevice = body.device === "queue";
      const resolvedKey = isQueueDevice ? null : getInputKey(DEVICE_ID, body.device ?? "", null);
      if (resolvedKey && body.command === "cast" && body.device) {
        await env.CALLER_KV.put(sessionKey, resolvedKey);
        deviceKey = resolvedKey;
      }

      const doStub = getDoStub(env, deviceKey);
      const res = await handleCatt(request, env, doStub, deviceKey);

      if (body.command === "reset") {
        await env.CALLER_KV.put(sessionKey, DEFAULT_DEVICE);
      }

      return res;
    }

    // Slack
    if (path === "/slack" && method === "POST") {
      const deviceKey = await getSessionDeviceKey(env, "slack:all");
      return handleSlack(request, env, ctx, getDoStub(env, deviceKey), deviceKey);
    }

    // Telegram
    if (path === "/telegram" && method === "POST") {
      return handleTelegram(request, env);
    }

    // Echo — renders TTS text as HTML for cast_site
    if (path === "/echo") {
      let text = url.searchParams.get("text") ?? "";
      if (method === "POST") {
        const ct = request.headers.get("content-type") ?? "";
        if (ct.includes("application/json")) {
          const body = await request.json() as { text?: string };
          text = body.text ?? text;
        } else {
          const form = await request.formData();
          text = (form.get("text") as string) ?? text;
        }
      }

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body{background-color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
    h1{color:#000;border:2px solid #000;padding:20px}
  </style>
</head>
<body><h1>${escapeHtml(text)}</h1></body>
</html>`;

      return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }

    // Device routes — delegate to per-device DO based on caller session
    if (path.startsWith("/device/")) {
      const xcaller = request.headers.get("X-Caller");
      const sessionKey = xcaller === "kids" ? "ui:kids" : "ui:admin";
      const deviceKey = await getSessionDeviceKey(env, sessionKey);
      const stub = getDoStub(env, deviceKey);
      // Rewrite /device/<any>/<action> → /device/<deviceKey>/<action> (frontend uses /device/box/ as a fixed placeholder)
      const action = path.replace(/^\/device\/[^/]+/, "");
      const doUrl = `https://do/device/${deviceKey}${action}`;
      const doReq = new Request(doUrl, { method: request.method, headers: request.headers, body: request.body });
      const res = await stub.fetch(doReq);
      if (path.endsWith("/state") && res.ok) {
        const state = await res.json() as Record<string, unknown>;
        return Response.json({ device: deviceKey, ...state }, { headers: { "cache-control": "no-store" } });
      }
      return res;
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    for (const key of getAllDeviceKeys(DEVICE_ID)) {
      const stub = getDoStub(env, key);
      await stub.fetch(new Request(`https://do/device/${key}/reset`));
    }
    let cursor: string | undefined;
    do {
      const result = await env.CALLER_KV.list({ cursor });
      await Promise.all(result.keys.map((k) => env.CALLER_KV.put(k.name, DEFAULT_DEVICE)));
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
  },
};
