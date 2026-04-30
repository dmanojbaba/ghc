import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSlack, handleTelegram } from "../integrations";

const SIGNING_SECRET = "test-signing-secret";
const TIMESTAMP = "1234567890";

async function makeSlackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const baseString = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(baseString));
  return "v0=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CATT_API_KEY: "api-key",
    CATT_BACKEND_SECRET: "server-secret",
    CATT_BACKEND_URL: "https://catt.example.com",
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    TELEGRAM_ALLOWED_CHAT_IDS: "",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_SECRET_TOKEN: "",
    YOUTUBE_API_KEY: "",
    DEVICE_QUEUE: {} as DurableObjectNamespace,
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
}

function makeDoStub(): DurableObjectStub {
  return { fetch: vi.fn(async () => new Response("ok")) } as unknown as DurableObjectStub;
}

async function makeSlackRequest(text: string, env: Env): Promise<Request> {
  const body = new URLSearchParams({ text }).toString();
  const sig = await makeSlackSignature(env.SLACK_SIGNING_SECRET, TIMESTAMP, body);
  return new Request("https://ghc.manojbaba.com/slack", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": TIMESTAMP,
      "X-Slack-Signature": sig,
    },
    body,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  vi.restoreAllMocks();
});

describe("handleSlack — signature verification", () => {
  it("returns 401 for invalid signature", async () => {
    const body = new URLSearchParams({ text: "play" }).toString();
    const request = new Request("https://ghc.manojbaba.com/slack", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": TIMESTAMP,
        "X-Slack-Signature": "v0=invalidsignature",
      },
      body,
    });
    const res = await handleSlack(request, makeEnv(), makeCtx(), makeDoStub());
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing signature", async () => {
    const body = new URLSearchParams({ text: "play" }).toString();
    const request = new Request("https://ghc.manojbaba.com/slack", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const res = await handleSlack(request, makeEnv(), makeCtx(), makeDoStub());
    expect(res.status).toBe(401);
  });

  it("passes through when SLACK_SIGNING_SECRET is not set", async () => {
    const body = new URLSearchParams({ text: "play" }).toString();
    const request = new Request("https://ghc.manojbaba.com/slack", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const res = await handleSlack(request, makeEnv({ SLACK_SIGNING_SECRET: "" }), makeCtx(), makeDoStub());
    expect(res.status).toBe(200);
  });

  it("accepts valid signature", async () => {
    const env = makeEnv();
    const request = await makeSlackRequest("play", env);
    const res = await handleSlack(request, env, makeCtx(), makeDoStub());
    expect(res.status).toBe(200);
  });
});

describe("handleSlack — response", () => {
  it("returns 200 immediately without awaiting command", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const request = await makeSlackRequest("cast believer", env);
    const res = await handleSlack(request, env, ctx, makeDoStub());
    expect(res.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });

  it("state returns DO state JSON synchronously", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const state = { session: "idle", app: "default", device: "otv" };
    const stub = { fetch: vi.fn(async () => new Response(JSON.stringify(state))) } as unknown as DurableObjectStub;
    const request = await makeSlackRequest("state", env);
    const res = await handleSlack(request, env, ctx, stub);
    expect(res.status).toBe(200);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    const text = await res.text();
    expect(text).toContain("```");
    expect(text).toContain('"session"');
    expect(text).toContain('"idle"');
    expect(text).toContain('"device"');
    expect(text).toContain('"otv"');
  });

  it("returns usage message when no command given", async () => {
    const env = makeEnv();
    const request = await makeSlackRequest("", env);
    const res = await handleSlack(request, env, makeCtx(), makeDoStub());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("command");
  });
});

async function getDoBody(stub: DurableObjectStub): Promise<Record<string, unknown>> {
  const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => (c[0] as Request).url.includes("/catt"),
  );
  return JSON.parse(await (call![0] as Request).text());
}

describe("handleSlack — device token parsing", () => {
  it("treats known alias as device", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("cast k believer", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = await getDoBody(stub);
    expect(body.device).toBe("k");
  });

  it("treats unknown second token as part of value", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("cast oh maria", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = await getDoBody(stub);
    expect(body.value).toBe("oh maria");
  });

  it("treats full name as device", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("cast kitchen believer", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = await getDoBody(stub);
    expect(body.device).toBe("kitchen");
  });
});

function makeTelegramRequest(text: string, chatId: number): Request {
  return new Request("https://ghc.manojbaba.com/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { text, chat: { id: chatId } } }),
  });
}

describe("handleTelegram — chat ID allowlist", () => {
  it("allows any chat when TELEGRAM_ALLOWED_CHAT_IDS is not set", async () => {
    const env = makeEnv({ TELEGRAM_ALLOWED_CHAT_IDS: "" });
    const stub = makeDoStub();
    const res = await handleTelegram(makeTelegramRequest("play", 111), env, stub);
    expect(res.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalled();
  });

  it("allows a chat ID in the allowlist", async () => {
    const env = makeEnv({ TELEGRAM_ALLOWED_CHAT_IDS: "111,222" });
    const stub = makeDoStub();
    const res = await handleTelegram(makeTelegramRequest("play", 111), env, stub);
    expect(res.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalled();
  });

  it("silently ignores a chat ID not in the allowlist", async () => {
    const env = makeEnv({ TELEGRAM_ALLOWED_CHAT_IDS: "111,222" });
    const stub = makeDoStub();
    const res = await handleTelegram(makeTelegramRequest("play", 999), env, stub);
    expect(res.status).toBe(200);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("handleTelegram — command parsing", () => {
  it("handles slash-prefixed command", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("/play", 111), env, stub);
    expect(stub.fetch).toHaveBeenCalled();
  });

  it("handles uppercase command", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("PLAY", 111), env, stub);
    expect(stub.fetch).toHaveBeenCalled();
  });

  it("handles uppercase device token", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("cast OTV believer", 111), env, stub);
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => (c[0] as Request).url.includes("/catt"),
    );
    const body = JSON.parse(await (call![0] as Request).text());
    expect(body.device).toBe("otv");
  });
});

describe("handleSlack — command parsing", () => {
  it("handles uppercase command", async () => {
    const env = makeEnv();
    const request = await makeSlackRequest("PLAY", env);
    const res = await handleSlack(request, env, makeCtx(), makeDoStub());
    expect(res.status).toBe(200);
  });

  it("handles uppercase device token", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("cast OTV believer", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const body = await getDoBody(stub);
    expect(body.device).toBe("otv");
  });
});

describe("handleSlack — clear and reset commands", () => {
  it("routes clear to DO", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("clear", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[0] as Request).url).toContain("/clear");
  });

  it("routes reset to DO", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("reset", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[0] as Request).url).toContain("/reset");
  });
});

describe("handleTelegram — clear and reset send state reply", () => {
  it("sends state after clear", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const state = { session: "idle", device: "o" };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const env = makeEnv();
    await handleTelegram(makeTelegramRequest("clear", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain('"session"');
  });

  it("sends state after reset", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const state = { session: "idle", device: "o" };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const env = makeEnv();
    await handleTelegram(makeTelegramRequest("reset", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain('"session"');
  });
});
