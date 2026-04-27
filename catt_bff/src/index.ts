import { DeviceQueue } from "./DeviceQueue";
import { handleFulfillment, handleSync, handleQuery } from "./googleHome";
import { handleOAuthAuth, handleOAuthToken } from "./oauth";
import { handleSlack, handleTelegram } from "./integrations";
import { handleCatt } from "./cattHandler";
import { DEVICE_ID } from "./devices";

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    // Google Home fulfillment
    if (path === "/fulfillment" && method === "POST") {
      return handleFulfillment(request, env, getDoStub(env, DEVICE_ID));
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

    // Ad-hoc POST endpoint
    if (path === "/catt" && method === "POST") {
      return handleCatt(request, env, getDoStub(env, DEVICE_ID));
    }

    // Slack
    if (path === "/slack" && method === "POST") {
      return handleSlack(request, env, getDoStub(env, DEVICE_ID));
    }

    // Telegram
    if (path === "/telegram" && method === "POST") {
      return handleTelegram(request, env, getDoStub(env, DEVICE_ID));
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

    // Device routes — delegate to DeviceQueue DO
    // /device/:name/*  or legacy /g* paths
    if (path.startsWith("/device/")) {
      const stub = getDoStub(env, DEVICE_ID);
      return stub.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const stub = getDoStub(env, DEVICE_ID);
    await stub.fetch(new Request("https://do/device/box/stop"));
  },
};
