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

beforeEach(() => vi.restoreAllMocks());

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
