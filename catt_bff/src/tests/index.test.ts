import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../index";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CATT_API_KEY: "secret-key",
    CATT_BACKEND_SECRET: "server-secret",
    CATT_BACKEND_URL: "https://catt.example.com",
    CATT_AI: {} as Ai,
    SLACK_SIGNING_SECRET: "slack-secret",
    TELEGRAM_ALLOWED_CHAT_IDS: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_SECRET_TOKEN: "",
    YOUTUBE_API_KEY: "",
    REDIRECT_URL: process.env.REDIRECT_URL!,
    DEVICE_QUEUE: {
      idFromName: () => ({} as DurableObjectId),
      get: () => ({ fetch: vi.fn(async () => new Response("ok")) } as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace,
    CALLER_KV: { get: vi.fn(async () => null), put: vi.fn() } as unknown as KVNamespace,
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  vi.restoreAllMocks();
});

describe("auth middleware — API key enforcement", () => {
  it("returns 401 for /catt without X-API-Key", async () => {
    const req = new Request("https://bff.example.com/catt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "play" }),
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).toBe(401);
  });

  it("returns 401 for /catt with wrong X-API-Key", async () => {
    const req = new Request("https://bff.example.com/catt", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "wrong-key" },
      body: JSON.stringify({ command: "play" }),
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).toBe(401);
  });

  it("passes /catt with correct X-API-Key", async () => {
    const req = new Request("https://bff.example.com/catt", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "secret-key" },
      body: JSON.stringify({ command: "play" }),
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).not.toBe(401);
  });
});

function makeEnvWithKv(kvGet: (key: string) => Promise<string | null> = async () => null): Env {
  const kvPut = vi.fn();
  return makeEnv({
    CALLER_KV: { get: vi.fn(kvGet), put: kvPut } as unknown as KVNamespace,
  });
}

describe("auth middleware — public paths", () => {
  it("/fulfillment is exempt from API key check", async () => {
    const req = new Request("https://bff.example.com/fulfillment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "x", inputs: [] }),
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).not.toBe(401);
  });

  it("/echo is exempt from API key check", async () => {
    const req = new Request("https://bff.example.com/echo?text=hello");
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).not.toBe(401);
  });


  it("/telegram is exempt from API key check", async () => {
    const req = new Request("https://bff.example.com/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: { text: "play", chat: { id: 123 } } }),
    });
    const res = await worker.fetch(req, makeEnv(), makeCtx());
    expect(res.status).not.toBe(401);
  });
});

describe("/catt — KV session routing", () => {
  function makeCattRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return new Request("https://bff.example.com/catt", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "secret-key", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("X-Caller: kids reads from ui:kids KV key", async () => {
    const env = makeEnvWithKv(async (key) => key === "ui:kids" ? "k" : null);
    let doName = "";
    env.DEVICE_QUEUE = {
      idFromName: (name: string) => { doName = name; return {} as DurableObjectId; },
      get: () => ({ fetch: vi.fn(async () => new Response("ok")) } as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    await worker.fetch(makeCattRequest({ command: "play" }, { "X-Caller": "kids" }), env, makeCtx());
    expect(doName).toBe("k");
  });

  it("X-Caller: admin reads from ui:admin KV key", async () => {
    const env = makeEnvWithKv(async (key) => key === "ui:admin" ? "otv" : null);
    let doName = "";
    env.DEVICE_QUEUE = {
      idFromName: (name: string) => { doName = name; return {} as DurableObjectId; },
      get: () => ({ fetch: vi.fn(async () => new Response("ok")) } as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    await worker.fetch(makeCattRequest({ command: "play" }, { "X-Caller": "admin" }), env, makeCtx());
    expect(doName).toBe("otv");
  });

  it("no X-Caller and no body.caller falls back to http:default session", async () => {
    const env = makeEnvWithKv(async (key) => key === "http:default" ? "b" : null);
    let doName = "";
    env.DEVICE_QUEUE = {
      idFromName: (name: string) => { doName = name; return {} as DurableObjectId; },
      get: () => ({ fetch: vi.fn(async () => new Response("ok")) } as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    await worker.fetch(makeCattRequest({ command: "play" }), env, makeCtx());
    expect(doName).toBe("b");
  });

  it("no X-Caller with body.caller reads from http:<caller> KV key", async () => {
    const env = makeEnvWithKv(async (key) => key === "http:api-client-1" ? "k" : null);
    let doName = "";
    env.DEVICE_QUEUE = {
      idFromName: (name: string) => { doName = name; return {} as DurableObjectId; },
      get: () => ({ fetch: vi.fn(async () => new Response("ok")) } as unknown as DurableObjectStub),
    } as unknown as DurableObjectNamespace;
    await worker.fetch(makeCattRequest({ command: "play", caller: "api-client-1" }), env, makeCtx());
    expect(doName).toBe("k");
  });

  it("device command writes resolved key to KV and returns state", async () => {
    const kvPut = vi.fn();
    const env = makeEnv({
      CALLER_KV: { get: vi.fn(async () => null), put: kvPut } as unknown as KVNamespace,
      DEVICE_QUEUE: {
        idFromName: () => ({} as DurableObjectId),
        get: () => ({ fetch: vi.fn(async () => new Response(JSON.stringify({ session: "idle" }), { headers: { "content-type": "application/json" } })) } as unknown as DurableObjectStub),
      } as unknown as DurableObjectNamespace,
    });
    const res = await worker.fetch(makeCattRequest({ command: "device", value: "k" }, { "X-Caller": "kids" }), env, makeCtx());
    expect(kvPut).toHaveBeenCalledWith("ui:kids", "k");
    const body = await res.json() as Record<string, unknown>;
    expect(body.device).toBe("k");
  });

  it("cast with body.device updates KV session", async () => {
    const kvPut = vi.fn();
    const env = makeEnv({
      CALLER_KV: { get: vi.fn(async () => null), put: kvPut } as unknown as KVNamespace,
    });
    await worker.fetch(makeCattRequest({ command: "cast", device: "k", value: "https://example.com" }, { "X-Caller": "kids" }), env, makeCtx());
    expect(kvPut).toHaveBeenCalledWith("ui:kids", "k");
  });

  it("cast with device=queue does not update KV session", async () => {
    const kvPut = vi.fn();
    const env = makeEnv({
      CALLER_KV: { get: vi.fn(async () => null), put: kvPut } as unknown as KVNamespace,
    });
    await worker.fetch(makeCattRequest({ command: "cast", device: "queue", value: "https://example.com" }, { "X-Caller": "kids" }), env, makeCtx());
    expect(kvPut).not.toHaveBeenCalled();
  });

  it("reset command writes DEFAULT_DEVICE to KV after dispatch", async () => {
    const kvPut = vi.fn();
    const env = makeEnv({
      CALLER_KV: { get: vi.fn(async () => "k"), put: kvPut } as unknown as KVNamespace,
    });
    await worker.fetch(makeCattRequest({ command: "reset" }, { "X-Caller": "kids" }), env, makeCtx());
    expect(kvPut).toHaveBeenCalledWith("ui:kids", "o");
  });
});

describe("/device/*/state — device injection", () => {
  it("injects device from KV into state response for X-Caller: kids", async () => {
    const stateBody = JSON.stringify({ app: "default", session: "idle", queue: [] });
    const env = makeEnv({
      CALLER_KV: { get: vi.fn(async (key: string) => key === "ui:kids" ? "k" : null), put: vi.fn() } as unknown as KVNamespace,
      DEVICE_QUEUE: {
        idFromName: () => ({} as DurableObjectId),
        get: () => ({ fetch: vi.fn(async () => new Response(stateBody, { headers: { "content-type": "application/json" } })) } as unknown as DurableObjectStub),
      } as unknown as DurableObjectNamespace,
    });
    const req = new Request("https://bff.example.com/device/box/state", {
      headers: { "X-API-Key": "secret-key", "X-Caller": "kids" },
    });
    const res = await worker.fetch(req, env, makeCtx());
    const body = await res.json() as Record<string, unknown>;
    expect(body.device).toBe("k");
    expect(body.app).toBe("default");
  });
});
