import { describe, it, expect, vi, beforeEach } from "vitest";
import { signCookie, setCookieHeader, COOKIE_NAME, DEFAULT_COOKIE_MAX_AGE_DAYS, DAYS_TO_MS } from "../lib/cookie";
import { PROXY_TIMEOUT_MS } from "../lib/proxy";
import type { Env } from "../lib/env";

const SECRET = "test-secret";
const MAX_AGE_MS = DEFAULT_COOKIE_MAX_AGE_DAYS * DAYS_TO_MS;
const BFF_URL = "https://bff.example.com";
const API_KEY = "test-api-key";

const BASE_ENV: Env = {
  UI_COOKIE_SECRET: SECRET,
  CATT_BFF_URL: BFF_URL,
  CATT_API_KEY: API_KEY,
};

async function kidsCookieHeader() {
  const val = await signCookie("kids", SECRET, Date.now());
  return setCookieHeader(val, DEFAULT_COOKIE_MAX_AGE_DAYS);
}

async function adminCookieHeader() {
  const val = await signCookie("admin", SECRET, Date.now());
  return setCookieHeader(val, DEFAULT_COOKIE_MAX_AGE_DAYS);
}

function extractCookieValue(setCookieStr: string) {
  const eqIdx = setCookieStr.indexOf("=");
  const semiIdx = setCookieStr.indexOf(";");
  return setCookieStr.slice(eqIdx + 1, semiIdx === -1 ? undefined : semiIdx);
}

function makeCtx(request: Request, env: Env) {
  return { request, env, params: {}, waitUntil: vi.fn(), passThroughOnException: vi.fn(), next: vi.fn(), data: {} } as unknown as EventContext<Env, string, Record<string, unknown>>;
}

function postRequest(cookieVal?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookieVal) headers["Cookie"] = `${COOKIE_NAME}=${cookieVal}`;
  return new Request("https://gha.manojbaba.com/api/command", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? { command: "stop" }),
  });
}

function getRequest(cookieVal?: string, path = "/api/devices") {
  const headers: Record<string, string> = {};
  if (cookieVal) headers["Cookie"] = `${COOKIE_NAME}=${cookieVal}`;
  return new Request(`https://gha.manojbaba.com${path}`, { method: "GET", headers });
}

// ── kids command proxy ─────────────────────────────────────────────────────

describe("POST /api/command", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns 401 with no cookie", async () => {
    const { onRequestPost } = await import("../../functions/api/command.js");
    const res = await onRequestPost(makeCtx(postRequest(), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("returns 401 with tampered cookie", async () => {
    const { onRequestPost } = await import("../../functions/api/command.js");
    const res = await onRequestPost(makeCtx(postRequest("tampered.XXXX"), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("returns 401 with expired cookie", async () => {
    const { onRequestPost } = await import("../../functions/api/command.js");
    const val = await signCookie("kids", SECRET, Date.now() - MAX_AGE_MS - 1000);
    const res = await onRequestPost(makeCtx(postRequest(val), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("proxies valid command and attaches X-API-Key", async () => {
    const { onRequestPost } = await import("../../functions/api/command.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const res = await onRequestPost(makeCtx(postRequest(cookieVal, { command: "stop" }), BASE_ENV));
    expect(res.status).toBe(200);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BFF_URL}/catt`);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(API_KEY);
  });

  it("forwards command body unchanged", async () => {
    const { onRequestPost } = await import("../../functions/api/command.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const body = { command: "cast", device: "otv", value: "https://youtu.be/abc" };
    await onRequestPost(makeCtx(postRequest(cookieVal, body), BASE_ENV));
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("returns 504 when bff times out", async () => {
    const { onRequestPost } = await import("../../functions/api/command.js");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })
    ));
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const res = await onRequestPost(makeCtx(postRequest(cookieVal), BASE_ENV));
    expect(res.status).toBe(504);
  }, PROXY_TIMEOUT_MS + 5000);
});

// ── admin command proxy ────────────────────────────────────────────────────

describe("POST /api/admin/command", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns 401 with no cookie", async () => {
    const { onRequestPost } = await import("../../functions/api/admin/command.js");
    const res = await onRequestPost(makeCtx(postRequest(), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("returns 401 with kids cookie (role isolation)", async () => {
    const { onRequestPost } = await import("../../functions/api/admin/command.js");
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const res = await onRequestPost(makeCtx(postRequest(cookieVal), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("proxies valid command with admin cookie", async () => {
    const { onRequestPost } = await import("../../functions/api/admin/command.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok", { status: 200 })));
    const cookieVal = extractCookieValue(await adminCookieHeader());
    const res = await onRequestPost(makeCtx(postRequest(cookieVal, { command: "stop" }), BASE_ENV));
    expect(res.status).toBe(200);
  });

  it("returns 504 on timeout", async () => {
    const { onRequestPost } = await import("../../functions/api/admin/command.js");
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })
    ));
    const cookieVal = extractCookieValue(await adminCookieHeader());
    const res = await onRequestPost(makeCtx(postRequest(cookieVal), BASE_ENV));
    expect(res.status).toBe(504);
  }, PROXY_TIMEOUT_MS + 5000);
});

// ── admin logout ───────────────────────────────────────────────────────────

describe("POST /api/admin/logout", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns 401 with no cookie", async () => {
    const { onRequestPost } = await import("../../functions/api/admin/logout.js");
    const res = await onRequestPost(makeCtx(postRequest(), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("redirects to /admin and clears cookie", async () => {
    const { onRequestPost } = await import("../../functions/api/admin/logout.js");
    const cookieVal = extractCookieValue(await adminCookieHeader());
    const res = await onRequestPost(makeCtx(postRequest(cookieVal), BASE_ENV));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/admin");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});

// ── admin state ────────────────────────────────────────────────────────────

describe("GET /api/admin/state", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns 401 with no cookie", async () => {
    const { onRequestGet } = await import("../../functions/api/admin/state.js");
    const res = await onRequestGet(makeCtx(getRequest(undefined, "/api/admin/state"), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("returns 401 with kids cookie", async () => {
    const { onRequestGet } = await import("../../functions/api/admin/state.js");
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const res = await onRequestGet(makeCtx(getRequest(cookieVal, "/api/admin/state"), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("returns merged state and history", async () => {
    const { onRequestGet } = await import("../../functions/api/admin/state.js");
    const statePayload = { device: "otv", session: "active" };
    const historyPayload = [{ url: "https://youtu.be/abc" }];
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(statePayload), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(historyPayload), { status: 200 })),
    );
    const cookieVal = extractCookieValue(await adminCookieHeader());
    const res = await onRequestGet(makeCtx(getRequest(cookieVal, "/api/admin/state"), BASE_ENV));
    expect(res.status).toBe(200);
    const json = await res.json() as { device: string; history: unknown[] };
    expect(json.device).toBe("otv");
    expect(json.history).toEqual(historyPayload);
  });
});

// ── devices proxy ──────────────────────────────────────────────────────────

describe("GET /api/devices", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns 401 with no cookie", async () => {
    const { onRequestGet } = await import("../../functions/api/devices.js");
    const res = await onRequestGet(makeCtx(getRequest(), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("proxies device list with valid kids cookie", async () => {
    const { onRequestGet } = await import("../../functions/api/devices.js");
    const devices = [{ key: "otv", name: "Office TV" }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(devices), { status: 200 })));
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const res = await onRequestGet(makeCtx(getRequest(cookieVal), BASE_ENV));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(devices);
  });

  it("accepts valid admin cookie", async () => {
    const { onRequestGet } = await import("../../functions/api/devices.js");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", { status: 200 })));
    const cookieVal = extractCookieValue(await adminCookieHeader());
    const res = await onRequestGet(makeCtx(getRequest(cookieVal), BASE_ENV));
    expect(res.status).toBe(200);
  });
});

// ── config endpoint ────────────────────────────────────────────────────────

describe("GET /api/config", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns 401 with no cookie", async () => {
    const { onRequestGet } = await import("../../functions/api/config.js");
    const res = await onRequestGet(makeCtx(getRequest(undefined, "/api/config"), BASE_ENV));
    expect(res.status).toBe(401);
  });

  it("returns allowSearch: false when UI_KIDS_ALLOW_SEARCH=false", async () => {
    const { onRequestGet } = await import("../../functions/api/config.js");
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const env = { ...BASE_ENV, UI_KIDS_ALLOW_SEARCH: "false" };
    const res = await onRequestGet(makeCtx(getRequest(cookieVal, "/api/config"), env));
    const json = await res.json() as { allowSearch: boolean };
    expect(json.allowSearch).toBe(false);
  });

  it("returns allowDeviceSwitch: false when UI_KIDS_ALLOW_DEVICE_SWITCH=false", async () => {
    const { onRequestGet } = await import("../../functions/api/config.js");
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const env = { ...BASE_ENV, UI_KIDS_ALLOW_DEVICE_SWITCH: "false" };
    const res = await onRequestGet(makeCtx(getRequest(cookieVal, "/api/config"), env));
    const json = await res.json() as { allowDeviceSwitch: boolean };
    expect(json.allowDeviceSwitch).toBe(false);
  });

  it("returns parsed buttons from BUTTONS_CONFIG", async () => {
    const { onRequestGet } = await import("../../functions/api/config.js");
    const buttons = [{ label: "Bluey", command: "cast", value: "https://youtu.be/abc" }];
    const cookieVal = extractCookieValue(await kidsCookieHeader());
    const env = { ...BASE_ENV, BUTTONS_CONFIG: JSON.stringify(buttons) };
    const res = await onRequestGet(makeCtx(getRequest(cookieVal, "/api/config"), env));
    const json = await res.json() as { buttons: unknown[] };
    expect(json.buttons).toEqual(buttons);
  });
});
