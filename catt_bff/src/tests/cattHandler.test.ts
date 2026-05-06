import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCatt } from "../cattHandler";

function makeDoStub() {
  return { fetch: vi.fn(async () => new Response("ok")) } as unknown as DurableObjectStub;
}

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

function makeRequest(body: Record<string, unknown>) {
  return new Request("https://bff.example.com/catt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  vi.restoreAllMocks();
});

describe("handleCatt — jump command", () => {
  it("routes jump to /device/<key>/jump/:position", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "jump", value: "42" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//jump/42");
  });
});

describe("handleCatt — tts command", () => {
  it("routes tts to /device/<key>/site/:value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "tts", value: "hello world" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//site/");
    expect(decodeURIComponent(url)).toContain("hello world");
  });

  it("routes broadcast to /device/<key>/site/:value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "broadcast", value: "hello world" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//site/");
    expect(decodeURIComponent(url)).toContain("hello world");
  });

  it("routes tts with empty value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "tts", value: "" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//site/");
  });
});

describe("handleCatt — cast channel redirect", () => {
  it("redirects cast of a known channel key to /device/<key>/channel/:key", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", value: "ping" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//channel/ping");
  });

  it("redirects cast of a channel name (case-insensitive) to /device/<key>/channel/:key", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", value: "Ping" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//channel/ping");
  });

  it("does not redirect cast of a URL to channel route", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", value: "https://example.com/video" }), makeEnv(), stub);
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as Request;
    expect(call.url).toContain("/device//catt");
  });

  it("does not redirect cast of an unknown value to channel route", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", value: "some random search" }), makeEnv(), stub);
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as Request;
    expect(call.url).toContain("/device//catt");
  });
});

describe("handleCatt — playlist command", () => {
  it("routes playlist with no value to /device/<key>/shuffle", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "playlist" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//shuffle");
  });

  it("routes playlist with no value to shuffle (device token ignored)", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "playlist", device: "k" }), makeEnv(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/device//shuffle");
  });

  it("routes playlist with value to /catt (cast) route", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "playlist", value: "https://www.youtube.com/playlist?list=PLabc" }), makeEnv(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const cattCall = calls.find((c: unknown[]) => (c[0] as Request).url.includes("/catt"));
    expect(cattCall).toBeDefined();
    const body = JSON.parse(await (cattCall![0] as Request).clone().text());
    expect(body.command).toBe("cast");
    expect(body.value).toBe("https://www.youtube.com/playlist?list=PLabc");
  });

  it("routes playlist with value directly to /catt (device token ignored)", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "playlist", device: "k", value: "https://www.youtube.com/playlist?list=PLabc" }), makeEnv(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const cattCall = calls.find((c: unknown[]) => (c[0] as Request).url.includes("/catt"));
    expect(cattCall).toBeDefined();
  });
});

describe("handleCatt — state command", () => {
  it("routes state to /device/<key>/state", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "state" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//state");
  });
});

describe("handleCatt — history command", () => {
  it("routes history to /device/<key>/history", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "history" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//history");
  });
});

describe("handleCatt — volume command", () => {
  it("calls catt_backend volumeup for value=up using passed deviceKey", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "volume", value: "up" }), makeEnv(), stub, "o");
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("https://catt.example.com");
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe("volumeup");
    expect(body.device).toBe("Mini Office");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("calls catt_backend volumedown for value=down using passed deviceKey", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "volume", value: "down" }), makeEnv(), stub, "o");
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe("volumedown");
    expect(body.device).toBe("Mini Office");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("calls catt_backend volume with numeric level using passed deviceKey", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "volume", value: "50" }), makeEnv(), stub, "o");
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe("volume");
    expect(body.value).toBe(50);
    expect(body.device).toBe("Mini Office");
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("body.device overrides passed deviceKey", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "volume", value: "up", device: "k" }), makeEnv(), stub, "o");
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.device).toBe("Mini Kitchen");
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("handleCatt — stop command", () => {
  it("routes stop to /device/<key>/stop (not /off)", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "stop" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device//stop");
    expect(url).not.toContain("/off");
  });
});

describe("handleCatt — app command", () => {
  it("routes app command to /device/<key>/set/app/:key", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "app", value: "youtube" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/set/app/youtube");
  });

  it("routes app command with default value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "app", value: "default" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/set/app/default");
  });
});

describe("handleCatt — error handling", () => {
  it("returns 500 JSON when command throws", async () => {
    const stub = {
      fetch: vi.fn(async () => { throw new Error("backend unavailable"); }),
    } as unknown as DurableObjectStub;
    const res = await handleCatt(makeRequest({ command: "play" }), makeEnv(), stub);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("backend unavailable");
  });
});
