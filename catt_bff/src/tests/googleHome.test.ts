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

describe("handleFulfillment — KV session", () => {
  it("SetInput writes new device key to CALLER_KV", async () => {
    const kvPut = vi.fn();
    const env = { ...makeEnv(), CALLER_KV: { get: vi.fn(async () => null), put: kvPut } as unknown as KVNamespace };
    const stub = makeDoStub();
    await handleFulfillment(makeExecuteRequest("action.devices.commands.SetInput", { newInput: "k" }), env, stub, "o");
    expect(kvPut).toHaveBeenCalledWith("googlehome:all", "k");
  });

  it("NextInput writes adjacent device key to CALLER_KV", async () => {
    const kvPut = vi.fn();
    const env = { ...makeEnv(), CALLER_KV: { get: vi.fn(async () => null), put: kvPut } as unknown as KVNamespace };
    const stub = makeDoStub();
    await handleFulfillment(makeExecuteRequest("action.devices.commands.NextInput"), env, stub, "k");
    expect(kvPut).toHaveBeenCalledWith("googlehome:all", expect.any(String));
  });

  it("PreviousInput writes adjacent device key to CALLER_KV", async () => {
    const kvPut = vi.fn();
    const env = { ...makeEnv(), CALLER_KV: { get: vi.fn(async () => null), put: kvPut } as unknown as KVNamespace };
    const stub = makeDoStub();
    await handleFulfillment(makeExecuteRequest("action.devices.commands.PreviousInput"), env, stub, "k");
    expect(kvPut).toHaveBeenCalledWith("googlehome:all", expect.any(String));
  });

  it("OnOff on writes DEFAULT_DEVICE to CALLER_KV", async () => {
    const kvPut = vi.fn();
    const env = { ...makeEnv(), CALLER_KV: { get: vi.fn(async () => null), put: kvPut } as unknown as KVNamespace };
    const stub = makeDoStub();
    await handleFulfillment(makeExecuteRequest("action.devices.commands.OnOff", { on: true }), env, stub, "k");
    expect(kvPut).toHaveBeenCalledWith("googlehome:all", "o");
  });

  it("OnOff off does NOT write to CALLER_KV", async () => {
    const kvPut = vi.fn();
    const env = { ...makeEnv(), CALLER_KV: { get: vi.fn(async () => null), put: kvPut } as unknown as KVNamespace };
    const stub = makeDoStub();
    await handleFulfillment(makeExecuteRequest("action.devices.commands.OnOff", { on: false }), env, stub, "k");
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("handleQuery uses passed deviceKey not DO state", async () => {
    const stub = makeDoStub();
    const req = new Request("https://bff.example.com/fulfillment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "test-req",
        inputs: [{ intent: "action.devices.QUERY", payload: { devices: [{ id: "box" }] } }],
      }),
    });
    const res = await handleFulfillment(req, makeEnv(), stub, "otv");
    const body = await res.json() as Record<string, unknown>;
    const states = (body.payload as Record<string, unknown>).devices as Record<string, unknown>;
    expect((states["box"] as Record<string, unknown>).currentInput).toBe("otv");
  });
});
