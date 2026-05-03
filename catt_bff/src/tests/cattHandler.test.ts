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
  it("routes jump to /device/box/jump/:position", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "jump", value: "42" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/jump/42");
  });
});

describe("handleCatt — tts command", () => {
  it("routes tts to /device/box/site/:value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "tts", value: "hello world" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/site/");
    expect(decodeURIComponent(url)).toContain("hello world");
  });

  it("routes speak to /device/box/site/:value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "speak", value: "hello world" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/site/");
    expect(decodeURIComponent(url)).toContain("hello world");
  });

  it("routes talk to /device/box/site/:value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "talk", value: "hello world" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/site/");
    expect(decodeURIComponent(url)).toContain("hello world");
  });

  it("routes tts with empty value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "tts", value: "" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/site/");
  });
});

describe("handleCatt — cast channel redirect", () => {
  it("redirects cast of a known channel key to /device/box/channel/:key", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", value: "ping" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/channel/ping");
  });

  it("redirects cast of a channel name (case-insensitive) to /device/box/channel/:key", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", value: "Ping" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/channel/ping");
  });

  it("redirects cast with device=queue of a known channel key to /device/box/channel/:key", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", device: "queue", value: "ping" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/channel/ping");
  });

  it("redirects cast with device=queue of a channel name (case-insensitive) to /device/box/channel/:key", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", device: "queue", value: "Ping" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/channel/ping");
  });

  it("does not redirect cast of a URL to channel route", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", value: "https://example.com/video" }), makeEnv(), stub);
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as Request;
    expect(call.url).toContain("/device/box/catt");
  });

  it("does not redirect cast of an unknown value to channel route", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "cast", value: "some random search" }), makeEnv(), stub);
    const call = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as Request;
    expect(call.url).toContain("/device/box/catt");
  });
});

describe("handleCatt — playlist command", () => {
  it("routes playlist with no value to /device/box/shuffle", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "playlist" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/shuffle");
  });

  it("sets device before shuffle when device is passed and no value", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "playlist", device: "k" }), makeEnv(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    expect(calls[0]).toContain("/set/device/k");
    expect(calls[1]).toContain("/device/box/shuffle");
  });

  it("skips set/device when no device passed", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "playlist" }), makeEnv(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => (c[0] as Request).url);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/device/box/shuffle");
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

  it("sets device then routes to /catt when both device and value passed", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "playlist", device: "k", value: "https://www.youtube.com/playlist?list=PLabc" }), makeEnv(), stub);
    const calls = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].url).toContain("/set/device/k");
    const cattCall = calls.find((c: unknown[]) => (c[0] as Request).url.includes("/catt"));
    expect(cattCall).toBeDefined();
  });
});

describe("handleCatt — state command", () => {
  it("routes state to /device/box/state", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "state" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/state");
  });
});

describe("handleCatt — history command", () => {
  it("routes history to /device/box/history", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "history" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/history");
  });
});

function makeStateStub(device: string): DurableObjectStub {
  return {
    fetch: vi.fn(async (req: Request) => {
      if (req.url.includes("/state")) return new Response(JSON.stringify({ device }));
      return new Response("ok");
    }),
  } as unknown as DurableObjectStub;
}

describe("handleCatt — volume command", () => {
  it("calls catt_backend volumeup for value=up using active device from state", async () => {
    const stub = makeStateStub("o");
    await handleCatt(makeRequest({ command: "volume", value: "up" }), makeEnv(), stub);
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("https://catt.example.com");
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe("volumeup");
    expect(body.device).toBe("Mini Office");
  });

  it("calls catt_backend volumedown for value=down using active device from state", async () => {
    const stub = makeStateStub("o");
    await handleCatt(makeRequest({ command: "volume", value: "down" }), makeEnv(), stub);
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe("volumedown");
    expect(body.device).toBe("Mini Office");
  });

  it("calls catt_backend volume with numeric level using active device from state", async () => {
    const stub = makeStateStub("o");
    await handleCatt(makeRequest({ command: "volume", value: "50" }), makeEnv(), stub);
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.command).toBe("volume");
    expect(body.value).toBe(50);
    expect(body.device).toBe("Mini Office");
  });

  it("uses device from request body when provided", async () => {
    const stub = makeStateStub("o");
    await handleCatt(makeRequest({ command: "volume", value: "up", device: "k" }), makeEnv(), stub);
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.device).toBe("Mini Kitchen");
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("handleCatt — stop command", () => {
  it("routes stop to /device/box/stop (not /off)", async () => {
    const stub = makeDoStub();
    await handleCatt(makeRequest({ command: "stop" }), makeEnv(), stub);
    const url = (stub.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0].url;
    expect(url).toContain("/device/box/stop");
    expect(url).not.toContain("/off");
  });
});

describe("handleCatt — app command", () => {
  it("routes app command to /device/box/set/app/:key", async () => {
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
