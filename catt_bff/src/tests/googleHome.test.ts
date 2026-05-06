import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleFulfillment } from "../googleHome";

function makeEnv(): Env {
  return {
    CATT_API_KEY: "api-key",
    CATT_BACKEND_SECRET: "server-secret",
    CATT_BACKEND_URL: "https://catt.example.com",
    CATT_AI: {} as Ai,
    SLACK_SIGNING_SECRET: "",
    TELEGRAM_ALLOWED_CHAT_IDS: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_SECRET_TOKEN: "",
    YOUTUBE_API_KEY: "",
    REDIRECT_URL: process.env.REDIRECT_URL!,
    DEVICE_QUEUE: {} as DurableObjectNamespace,
    CALLER_KV: { get: vi.fn(async () => null), put: vi.fn() } as unknown as KVNamespace,
  };
}

function makeDoStub() {
  return {
    fetch: vi.fn(async (req: Request | string) => {
      const url = typeof req === "string" ? req : req.url;
      if (url.includes("/state")) return new Response(JSON.stringify({ session: "idle", device: "o", app: "default", queue: [] }));
      return new Response("ok");
    }),
  } as unknown as DurableObjectStub;
}

function makeExecuteRequest(command: string, params: Record<string, unknown> = {}) {
  return new Request("https://bff.example.com/fulfillment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "test-req",
      inputs: [{
        intent: "action.devices.EXECUTE",
        payload: {
          commands: [{
            devices: [{ id: "box" }],
            execution: [{ command, params }],
          }],
        },
      }],
    }),
  });
}

beforeEach(() => vi.restoreAllMocks());

function getUrls(stub: DurableObjectStub): string[] {
  return (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as string);
}

describe("handleFulfillment — OnOff", () => {
  it("OnOff off routes to /off (full wipe)", async () => {
    const stub = makeDoStub();
    await handleFulfillment(makeExecuteRequest("action.devices.commands.OnOff", { on: false }), makeEnv(), stub);
    expect(getUrls(stub).some(u => u.includes("/off"))).toBe(true);
  });

  it("OnOff on routes to /reset (not /off or /stop)", async () => {
    const stub = makeDoStub();
    await handleFulfillment(makeExecuteRequest("action.devices.commands.OnOff", { on: true }), makeEnv(), stub);
    const urls = getUrls(stub);
    expect(urls.some(u => u.includes("/reset"))).toBe(true);
    expect(urls.some(u => u.includes("/off"))).toBe(false);
    expect(urls.some(u => u.includes("/stop"))).toBe(false);
  });
});

describe("handleFulfillment — mediaStop", () => {
  it("mediaStop routes to /stop (preserve queue, not /off)", async () => {
    const stub = makeDoStub();
    await handleFulfillment(makeExecuteRequest("action.devices.commands.mediaStop"), makeEnv(), stub);
    const urls = getUrls(stub);
    expect(urls.some(u => u.includes("/stop"))).toBe(true);
    expect(urls.some(u => u.includes("/off"))).toBe(false);
  });
});
