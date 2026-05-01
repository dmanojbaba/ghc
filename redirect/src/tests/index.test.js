import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../index.js";

const YOUTUBE_BASE = "https://www.youtube.com/watch?v=";

function makeEnv(kvEntries = {}) {
  return {
    YOUTUBE_API_KEY: "test-api-key",
    kv: {
      get: vi.fn(async (key) => kvEntries[key] ?? null),
      put: vi.fn(),
      list: vi.fn(async () => ({
        keys: Object.keys(kvEntries).map((name) => ({ name })),
      })),
    },
    r2bkt: {
      get: vi.fn(async () => null),
    },
  };
}

function makeRequest(path, method = "GET", body = null, headers = {}) {
  const url = "https://redirect.example.com" + path;
  const init = { method, headers: { "Content-Type": "application/json", ...headers } };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

function mockYoutubeSearch(items) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => ({ items }) }))
  );
}

function mockYoutubeVideos(items) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => ({ items }) }))
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// GET /ip
// ---------------------------------------------------------------------------

describe("GET /ip", () => {
  it("returns CF-Connecting-IP header value", async () => {
    const req = new Request("https://redirect.example.com/ip", {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    const res = await worker.fetch(req, makeEnv());
    expect(await res.text()).toBe("1.2.3.4");
  });
});

// ---------------------------------------------------------------------------
// GET /kv
// ---------------------------------------------------------------------------

describe("GET /kv", () => {
  it("lists all keys except 'status' as space-separated text", async () => {
    const env = makeEnv({ ping: "https://example.com", sun: "https://sun.com", status: "ok" });
    const res = await worker.fetch(makeRequest("/kv"), env);
    const text = await res.text();
    expect(text).toContain("ping");
    expect(text).toContain("sun");
    expect(text).not.toContain("status");
  });

  it("lists keys as JSON when ?output=json", async () => {
    const env = makeEnv({ ping: "https://example.com" });
    const res = await worker.fetch(makeRequest("/kv?output=json"), env);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const json = await res.json();
    expect(Array.isArray(json)).toBe(true);
  });

  it("returns value for a known key", async () => {
    const env = makeEnv({ ping: "https://example.com/ping" });
    const res = await worker.fetch(makeRequest("/kv/ping"), env);
    expect(await res.text()).toBe("https://example.com/ping");
  });

  it("returns 'null' for unknown key", async () => {
    const env = makeEnv({});
    const res = await worker.fetch(makeRequest("/kv/missing"), env);
    expect(await res.text()).toBe("null");
  });

  it("returns value as JSON when ?output=json", async () => {
    const env = makeEnv({ ping: "https://example.com/ping" });
    const res = await worker.fetch(makeRequest("/kv/ping?output=json"), env);
    const json = await res.json();
    expect(json).toEqual({ key: "ping", value: "https://example.com/ping" });
  });

  it("lowercases the key lookup", async () => {
    const env = makeEnv({ ping: "https://example.com/ping" });
    await worker.fetch(makeRequest("/kv/PING"), env);
    expect(env.kv.get).toHaveBeenCalledWith("ping");
  });
});

// ---------------------------------------------------------------------------
// GET /r
// ---------------------------------------------------------------------------

describe("GET /r", () => {
  it("redirects to KV value when key exists", async () => {
    const env = makeEnv({ ping: "https://example.com/ping" });
    const res = await worker.fetch(makeRequest("/r/ping"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/ping");
  });

  it("falls back to YouTube search when key not in KV", async () => {
    mockYoutubeSearch([{ id: { videoId: "abc123" }, snippet: { title: "my search" } }]);
    const env = makeEnv({});
    const res = await worker.fetch(makeRequest("/r/my%20search"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("youtube.com");
  });

  it("returns null response for missing key segment", async () => {
    const res = await worker.fetch(makeRequest("/r/"), makeEnv());
    expect(await res.text()).toBe("null");
  });
});

// ---------------------------------------------------------------------------
// GET /r2
// ---------------------------------------------------------------------------

describe("GET /r2", () => {
  it("returns null for missing key segment", async () => {
    const res = await worker.fetch(makeRequest("/r2/"), makeEnv());
    expect(await res.text()).toBe("null");
  });

  it("returns null when object not found in R2", async () => {
    const res = await worker.fetch(makeRequest("/r2/missing"), makeEnv());
    expect(await res.text()).toBe("null");
  });

  it("streams object body when found in R2", async () => {
    const env = makeEnv();
    env.r2bkt.get = vi.fn(async () => ({
      body: "file-content",
      httpEtag: "etag-123",
      writeHttpMetadata: (h) => h.set("Content-Type", "audio/mpeg"),
    }));
    const res = await worker.fetch(makeRequest("/r2/song"), env);
    expect(res.headers.get("etag")).toBe("etag-123");
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await res.text()).toBe("file-content");
  });

  it("lowercases the key lookup", async () => {
    const env = makeEnv();
    await worker.fetch(makeRequest("/r2/SONG"), env);
    expect(env.r2bkt.get).toHaveBeenCalledWith("song");
  });
});

// ---------------------------------------------------------------------------
// GET /y
// ---------------------------------------------------------------------------

describe("GET /y", () => {
  it("returns null for missing key segment", async () => {
    const res = await worker.fetch(makeRequest("/y/"), makeEnv());
    expect(await res.text()).toBe("null");
  });

  it("returns YouTube search result as JSON", async () => {
    mockYoutubeSearch([{ id: { videoId: "vid1" }, snippet: { title: "Sun News" } }]);
    const res = await worker.fetch(makeRequest("/y/Sun%20News"), makeEnv());
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const body = await res.text();
    expect(body).toContain("vid1");
  });

  it("passes extra query params to YouTube API", async () => {
    const mockFetch = vi.fn(async () => ({
      json: async () => ({ items: [{ id: { videoId: "v1" }, snippet: { title: "t" } }] }),
    }));
    vi.stubGlobal("fetch", mockFetch);
    await worker.fetch(makeRequest("/y/Sun%20News?maxResults=5"), makeEnv());
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("maxResults=5"));
  });

  it("does not append undefined to API URL when no query params", async () => {
    const mockFetch = vi.fn(async () => ({
      json: async () => ({ items: [{ id: { videoId: "v1" }, snippet: { title: "t" } }] }),
    }));
    vi.stubGlobal("fetch", mockFetch);
    await worker.fetch(makeRequest("/y/Sun%20News"), makeEnv());
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("undefined"));
  });
});

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------

describe("unknown routes", () => {
  it("returns 404 for unknown GET path", async () => {
    const res = await worker.fetch(makeRequest("/unknown"), makeEnv());
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown POST path", async () => {
    const res = await worker.fetch(makeRequest("/unknown", "POST"), makeEnv());
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /_raw
// ---------------------------------------------------------------------------

describe("POST /_raw", () => {
  it("echoes the request body", async () => {
    const req = new Request("https://redirect.example.com/_raw", {
      method: "POST",
      body: "hello",
    });
    const res = await worker.fetch(req, makeEnv());
    expect(await res.text()).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// POST /kv
// ---------------------------------------------------------------------------

describe("POST /kv", () => {
  it("returns KV value for key in JSON body", async () => {
    const env = makeEnv({ ping: "https://example.com/ping" });
    const res = await worker.fetch(makeRequest("/kv", "POST", { text: "ping" }), env);
    expect(await res.text()).toBe("https://example.com/ping");
  });

  it("returns 'null' for unknown key", async () => {
    const env = makeEnv({});
    const res = await worker.fetch(makeRequest("/kv", "POST", { text: "missing" }), env);
    expect(await res.text()).toBe("null");
  });

  it("lists all keys when body has no text field", async () => {
    const env = makeEnv({ ping: "https://example.com", sun: "https://sun.com" });
    const res = await worker.fetch(makeRequest("/kv", "POST", {}), env);
    const text = await res.text();
    expect(text).toContain("ping");
    expect(text).toContain("sun");
  });

  it("lowercases the key lookup", async () => {
    const env = makeEnv({ ping: "https://example.com/ping" });
    await worker.fetch(makeRequest("/kv", "POST", { text: "PING" }), env);
    expect(env.kv.get).toHaveBeenCalledWith("ping");
  });
});

// ---------------------------------------------------------------------------
// scheduled — cron jobs
// ---------------------------------------------------------------------------

describe("scheduled", () => {
  it("updates pttv and sun KV keys on the news cron", async () => {
    mockYoutubeSearch([{ id: { videoId: "news123" }, snippet: { title: "Today Headlines" } }]);
    const env = makeEnv();
    await worker.scheduled({ cron: "0 6-22 * * *" }, env, {});
    expect(env.kv.put).toHaveBeenCalledWith("pttv", expect.stringContaining("youtube.com"));
    expect(env.kv.put).toHaveBeenCalledWith("sun", expect.stringContaining("youtube.com"));
  });

  it("does nothing on the placeholder cron", async () => {
    const env = makeEnv();
    await worker.scheduled({ cron: "3 3 * * *" }, env, {});
    expect(env.kv.put).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchYoutube — single-word path (now goes through YouTube /videos API)
// ---------------------------------------------------------------------------

describe("GET /r — single-word YouTube API fallback", () => {
  it("calls YouTube videos API and redirects to result for single-word KV miss", async () => {
    mockYoutubeVideos([{ id: "abc123", snippet: { title: "Some Video" } }]);
    const env = makeEnv({});
    const res = await worker.fetch(makeRequest("/r/abc123"), env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(YOUTUBE_BASE + "abc123");
    expect(fetch).toHaveBeenCalled();
  });
});
