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

describe("handleSlack — device command", () => {
  it("routes device to DO set/device and returns state", async () => {
    const env = makeEnv();
    const state = { session: "idle", device: "otv" };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const ctx = makeCtx();
    const request = await makeSlackRequest("device otv", env);
    const res = await handleSlack(request, env, ctx, stub);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/set/device/otv");
    const text = await res.text();
    expect(text).toContain('"device"');
    expect(text).toContain('"otv"');
  });

  it("uses device token as key when no explicit value given", async () => {
    const env = makeEnv();
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response("{}");
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const ctx = makeCtx();
    const request = await makeSlackRequest("device k", env);
    await handleSlack(request, env, ctx, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/set/device/k");
  });
});

describe("handleSlack — channel command", () => {
  it("routes channel up to DO", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("channel up", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[0] as Request).url).toContain("/channel/up");
  });

  it("routes channel down to DO", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("channel down", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[0] as Request).url).toContain("/channel/down");
  });

  it("routes channel by name to DO", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const ctx = makeCtx();
    const request = await makeSlackRequest("channel sun", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((call[0] as Request).url).toContain("/channel/sun");
  });
});

describe("handleSlack — clear and reset commands", () => {
  it("routes clear to DO and returns state synchronously", async () => {
    const env = makeEnv();
    const state = { session: "idle", device: "o" };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const ctx = makeCtx();
    const request = await makeSlackRequest("clear", env);
    const res = await handleSlack(request, env, ctx, stub);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/clear");
    const text = await res.text();
    expect(text).toContain('"session"');
  });

  it("routes reset to DO and returns state synchronously", async () => {
    const env = makeEnv();
    const state = { session: "idle", device: "o" };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const ctx = makeCtx();
    const request = await makeSlackRequest("reset", env);
    const res = await handleSlack(request, env, ctx, stub);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/reset");
    const text = await res.text();
    expect(text).toContain('"session"');
  });
});

describe("handleTelegram — device sends state reply", () => {
  it("sends state after device command", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const state = { session: "idle", device: "otv" };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const env = makeEnv();
    await handleTelegram(makeTelegramRequest("device otv", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain('"device"');
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

describe("handleSlack — bare device alias shorthand", () => {
  it("treats bare known alias as device command and returns state", async () => {
    const env = makeEnv();
    const state = { session: "idle", device: "k" };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const ctx = makeCtx();
    const request = await makeSlackRequest("k", env);
    const res = await handleSlack(request, env, ctx, stub);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/set/device/k");
    const text = await res.text();
    expect(text).toContain('"device"');
    expect(text).toContain('"k"');
  });

  it("treats bare full device name as device command", async () => {
    const env = makeEnv();
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response("{}");
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const ctx = makeCtx();
    const request = await makeSlackRequest("otv", env);
    await handleSlack(request, env, ctx, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/set/device/otv");
  });
});

describe("handleTelegram — bare device alias shorthand", () => {
  it("sets device and sends state reply for bare alias", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const state = { session: "idle", device: "otv" };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if ((req as Request).url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const env = makeEnv();
    await handleTelegram(makeTelegramRequest("otv", 111), env, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/set/device/otv");
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain('"device"');
  });

  it("does not call set/device for unknown alias", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("unknowncmd", 111), env, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every((c: unknown[]) => !(c[0] as Request).url.includes("/set/device"))).toBe(true);
  });
});
