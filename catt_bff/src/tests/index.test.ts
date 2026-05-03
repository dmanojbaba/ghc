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
