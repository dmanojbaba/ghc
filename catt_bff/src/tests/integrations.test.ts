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

function makeAi(response: string | null): Ai {
  return {
    run: vi.fn(async () => response === null ? Promise.reject(new Error("AI error")) : { response }),
  } as unknown as Ai;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CATT_API_KEY: "api-key",
    CATT_BACKEND_SECRET: "server-secret",
    CATT_BACKEND_URL: "https://catt.example.com",
    CATT_AI: makeAi("{}"),
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    TELEGRAM_ALLOWED_CHAT_IDS: "",
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_SECRET_TOKEN: "",
    YOUTUBE_API_KEY: "",
    REDIRECT_URL: process.env.REDIRECT_URL!,
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
  return new Request("https://bff.example.com/slack", {
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
    const request = new Request("https://bff.example.com/slack", {
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
    const request = new Request("https://bff.example.com/slack", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const res = await handleSlack(request, makeEnv(), makeCtx(), makeDoStub());
    expect(res.status).toBe(401);
  });

  it("passes through when SLACK_SIGNING_SECRET is not set", async () => {
    const body = new URLSearchParams({ text: "play" }).toString();
    const request = new Request("https://bff.example.com/slack", {
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
  return new Request("https://bff.example.com/telegram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { text, chat: { id: chatId } } }),
  });
}

describe("handleSlack — state queue truncation", () => {
  it("truncates queue to 5 items with a count suffix when queue has more than 5 items", async () => {
    const env = makeEnv();
    const queue = Array.from({ length: 10 }, (_, i) => ({ position: i, url: `https://example.com/${i}` }));
    const state = { session: "idle", device: "o", queue };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const request = await makeSlackRequest("state", env);
    const res = await handleSlack(request, env, makeCtx(), stub);
    const text = await res.text();
    const json = JSON.parse(text.replace(/```\n?/g, ""));
    expect(json.queue).toHaveLength(6);
    expect(json.queue[5]).toBe("… 5 more");
  });

  it("does not truncate queue when 5 or fewer items", async () => {
    const env = makeEnv();
    const queue = Array.from({ length: 5 }, (_, i) => ({ position: i, url: `https://example.com/${i}` }));
    const state = { session: "idle", device: "o", queue };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const request = await makeSlackRequest("state", env);
    const res = await handleSlack(request, env, makeCtx(), stub);
    const text = await res.text();
    const json = JSON.parse(text.replace(/```\n?/g, ""));
    expect(json.queue).toHaveLength(5);
  });
});

describe("handleTelegram — state queue truncation", () => {
  it("truncates queue to 5 items with a count suffix when queue has more than 5 items", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const queue = Array.from({ length: 10 }, (_, i) => ({ position: i, url: `https://example.com/${i}` }));
    const state = { session: "idle", device: "o", queue };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const env = makeEnv();
    await handleTelegram(makeTelegramRequest("state", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    const sent = JSON.parse(body.text.replace(/<\/?pre>/g, ""));
    expect(sent.queue).toHaveLength(6);
    expect(sent.queue[5]).toBe("… 5 more");
  });

  it("does not truncate queue when 5 or fewer items", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const queue = Array.from({ length: 5 }, (_, i) => ({ position: i, url: `https://example.com/${i}` }));
    const state = { session: "idle", device: "o", queue };
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify(state));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const env = makeEnv();
    await handleTelegram(makeTelegramRequest("state", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    const sent = JSON.parse(body.text.replace(/<\/?pre>/g, ""));
    expect(sent.queue).toHaveLength(5);
  });
});

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

describe("handleTelegram — history command", () => {
  it("sends history JSON as pre-formatted message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const history = [{ url: "https://youtu.be/abc", title: "Song", played_at: "2026-05-03T10:00:00Z" }];
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/history")) return new Response(JSON.stringify(history));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const env = makeEnv();
    await handleTelegram(makeTelegramRequest("history", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain("youtu.be/abc");
    expect(body.parse_mode).toBe("HTML");
  });

  it("truncates history to 5 items with a count suffix", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const history = Array.from({ length: 8 }, (_, i) => ({ url: `https://youtu.be/${i}`, title: `Song ${i}` }));
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/history")) return new Response(JSON.stringify(history));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const env = makeEnv();
    await handleTelegram(makeTelegramRequest("history", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    const items = JSON.parse(body.text.replace(/<\/?pre>/g, ""));
    expect(items).toHaveLength(6);
    expect(items[5]).toBe("… 3 more");
  });
});

describe("handleSlack — history command", () => {
  it("returns history JSON as pre-formatted response", async () => {
    const env = makeEnv();
    const history = [{ url: "https://youtu.be/abc", title: "Song", played_at: "2026-05-03T10:00:00Z" }];
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/history")) return new Response(JSON.stringify(history));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const request = await makeSlackRequest("history", env);
    const res = await handleSlack(request, env, makeCtx(), stub);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("youtu.be/abc");
    expect(text).toContain("```");
  });

  it("truncates history to 5 items with a count suffix", async () => {
    const env = makeEnv();
    const history = Array.from({ length: 8 }, (_, i) => ({ url: `https://youtu.be/${i}`, title: `Song ${i}` }));
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/history")) return new Response(JSON.stringify(history));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const request = await makeSlackRequest("history", env);
    const res = await handleSlack(request, env, makeCtx(), stub);
    const text = await res.text();
    const items = JSON.parse(text.replace(/```\n?/g, ""));
    expect(items).toHaveLength(6);
    expect(items[5]).toBe("… 3 more");
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

describe("handleSlack — cast with channel key routes to channel", () => {
  it("routes cast with known channel key to channel", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const request = await makeSlackRequest("cast ping", env);
    await handleSlack(request, env, makeCtx(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/channel/ping");
  });

  it("routes cast with URL directly to catt (not channel)", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const request = await makeSlackRequest("cast https://youtu.be/abc", env);
    await handleSlack(request, env, makeCtx(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/catt");
  });

  it("routes cast with free text to catt (not channel)", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const request = await makeSlackRequest("cast believer song", env);
    await handleSlack(request, env, makeCtx(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/catt");
  });
});

describe("handleSlack — tts aliases", () => {
  it("speak routes to DO /site/ with encoded text", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const request = await makeSlackRequest("speak hello world", env);
    const res = await handleSlack(request, env, makeCtx(), stub);
    expect(res.status).toBe(200);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/site/");
    expect(decodeURIComponent(calls[0][0].url.split("/site/")[1])).toBe("hello world");
  });

  it("talk routes to DO /site/ with encoded text", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    const request = await makeSlackRequest("talk hello world", env);
    const res = await handleSlack(request, env, makeCtx(), stub);
    expect(res.status).toBe(200);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/site/");
    expect(decodeURIComponent(calls[0][0].url.split("/site/")[1])).toBe("hello world");
  });
});

describe("handleSlack — volume command", () => {
  it("fetches active device from state when no device token given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const env = makeEnv();
    const ctx = makeCtx();
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify({ device: "o" }));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    const request = await makeSlackRequest("volume up", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe("volumeup");
    expect(body.device).toBe("Mini Office");
  });

  it("uses parsed device token when given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const env = makeEnv();
    const ctx = makeCtx();
    const stub = makeDoStub();
    const request = await makeSlackRequest("volume k 50", env);
    await handleSlack(request, env, ctx, stub);
    await (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe("volume");
    expect(body.device).toBe("Mini Kitchen");
  });
});

describe("handleTelegram — playlist command", () => {
  it("routes playlist to DO /shuffle", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("playlist", 111), env, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/device/box/shuffle");
  });

  it("sets device before shuffle when device token is provided", async () => {
    const env = makeEnv();
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("playlist k", 111), env, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    expect(calls[0]).toContain("/set/device/k");
    expect(calls[1]).toContain("/device/box/shuffle");
  });
});

describe("handleTelegram — AI fallback", () => {
  it("calls AI for unrecognised command and dispatches result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "cast", value: "jazz music" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify({ device: "o" }));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("put on some jazz", 111), env, stub);
    expect(ai.run).toHaveBeenCalledOnce();
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const cattCall = calls.find((c: unknown[]) => (c[0] as Request).url.includes("/catt"));
    expect(cattCall).toBeDefined();
    const body = JSON.parse(await (cattCall![0] as Request).text());
    expect(body.command).toBe("cast");
    expect(body.value).toBe("jazz music");
  });

  it("parses device from AI response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "volume", device: "k", value: "50" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify({ device: "k" }));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("set kitchen volume to 50", 111), env, stub);
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it("sets device in KV before dispatching when AI returns a device", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "channel", device: "o", value: "lime" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify({ device: "o" }));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("Radio Lime on mini office", 111), env, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    const deviceSetCall = calls.find(u => u.includes("/set/device/o"));
    const channelCall = calls.find(u => u.includes("/channel/lime"));
    expect(deviceSetCall).toBeDefined();
    expect(channelCall).toBeDefined();
    expect(calls.indexOf(deviceSetCall!)).toBeLessThan(calls.indexOf(channelCall!));
  });

  it("sends 'Unknown command' when AI returns unknown command", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "unknown" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("blah blah blah", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain("Unknown command");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("sends AI error when AI returns malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi("not valid json");
    const env = makeEnv({ CATT_AI: ai });
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("do the thing", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain("AI error:");
  });

  it("sends AI error when AI throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(null);
    const env = makeEnv({ CATT_AI: ai });
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("do something weird", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain("AI error:");
  });

  it("does NOT call AI for a known command", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "cast", value: "jazz" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("cast jazz", 111), env, stub);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("AI system prompt includes channel synonyms and numbers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "channel", value: "arr" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify({ device: "o" }));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("Radio Rahman", 111), env, stub);
    expect(ai.run).toHaveBeenCalledOnce();
    const prompt = (ai.run as ReturnType<typeof vi.fn>).mock.calls[0][1].messages[0].content as string;
    expect(prompt).toContain("arr=Radio ARR|Radio Rahman|8");
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((c: unknown[]) => (c[0] as Request).url.includes("/channel/arr"))).toBe(true);
  });

  it("sends confirmation with command, value, and active device from state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "cast", value: "jazz music" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify({ device: "k" }));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("put on some jazz", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toBe("command: cast\nvalue: jazz music\ndevice: k");
  });

  it("sends confirmation with command, value, and device from state (device set by AI)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "channel", device: "o", value: "lime" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify({ device: "o" }));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("Radio Lime on mini office", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toBe("command: channel\nvalue: lime\ndevice: o");
  });

  it("does not set device in KV when AI returns unknown device key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "cast", device: "notadevice", value: "jazz" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("play jazz on notadevice", 111), env, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    expect(calls.every(u => !u.includes("/set/device/notadevice"))).toBe(true);
  });

  it("sends 'Backend error' when dispatchCommand throws (AI path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "cast", value: "jazz" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = {
      fetch: vi.fn(async () => { throw new Error("backend unavailable"); }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("put on some jazz", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toBe("Backend error");
  });

  it("dispatches compound commands and sends combined confirmation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify([
      { command: "channel", value: "lime" },
      { command: "sleep", value: "30" },
    ]));
    const env = makeEnv({ CATT_AI: ai });
    const stub = {
      fetch: vi.fn(async (req: Request) => {
        if (req.url.includes("/state")) return new Response(JSON.stringify({ device: "o" }));
        return new Response("ok");
      }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("stream radio lime for 30 minutes", 111), env, stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    expect(calls.some(u => u.includes("channel") && u.includes("lime"))).toBe(true);
    expect(calls.some(u => u.includes("sleep") && u.includes("30"))).toBe(true);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toBe("command: channel\nvalue: lime\ncommand: sleep\nvalue: 30\ndevice: o");
  });
});

describe("handleTelegram — /start command", () => {
  it("sends HELP_TEXT for /start", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const env = makeEnv();
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("/start", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toContain("Commands:");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("does NOT call AI for /start", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const ai = makeAi(JSON.stringify({ command: "cast", value: "jazz" }));
    const env = makeEnv({ CATT_AI: ai });
    const stub = makeDoStub();
    await handleTelegram(makeTelegramRequest("/start", 111), env, stub);
    expect(ai.run).not.toHaveBeenCalled();
  });
});

describe("handleTelegram — error handling", () => {
  it("sends 'Backend error' when dispatchCommand throws (known command path)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const env = makeEnv();
    const stub = {
      fetch: vi.fn(async () => { throw new Error("backend unavailable"); }),
    } as unknown as DurableObjectStub;
    await handleTelegram(makeTelegramRequest("volume up", 111), env, stub);
    const telegramCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(telegramCall[1].body);
    expect(body.text).toBe("Backend error");
  });
});
