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
