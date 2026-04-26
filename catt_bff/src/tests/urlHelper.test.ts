import { describe, it, expect, vi, beforeEach } from "vitest";
import { getParsedUrl, getPlaylistItems } from "../urlHelper";

const BASE_YOUTUBE  = "https://www.youtube.com/watch?v=";
const BASE_REDIRECT = "https://r.manojbaba.com/r/";

describe("getParsedUrl", () => {
  describe("ytVideoId=true", () => {
    it("prepends BASE_YOUTUBE to bare video id", () => {
      expect(getParsedUrl("dQw4w9WgXcQ", true)).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("takes priority before URL parsing", () => {
      expect(getParsedUrl("abc123", true)).toBe(BASE_YOUTUBE + "abc123");
    });
  });

  describe("r.manojbaba.com URLs", () => {
    it("returns redirect URLs as-is", () => {
      const url = "https://r.manojbaba.com/r/ping";
      expect(getParsedUrl(url)).toBe(url);
    });
  });

  describe("youtu.be URLs", () => {
    it("converts short YouTube URL to full URL", () => {
      expect(getParsedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });
  });

  describe("youtube.com URLs", () => {
    it("extracts video id from /watch?v=", () => {
      expect(getParsedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("extracts video id from /watch/", () => {
      expect(getParsedUrl("https://www.youtube.com/watch/dQw4w9WgXcQ")).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("extracts video id from /embed/", () => {
      expect(getParsedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("extracts video id from /v/", () => {
      expect(getParsedUrl("https://www.youtube.com/v/dQw4w9WgXcQ")).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("extracts playlist id when ytPlaylist=true", () => {
      expect(getParsedUrl("https://www.youtube.com/playlist?list=PLtest123", false, true)).toBe("PLtest123");
    });

    it("returns full URL for youtube.com without ytPlaylist flag", () => {
      const url = "https://www.youtube.com/playlist?list=PLtest123";
      expect(getParsedUrl(url)).toBe(url);
    });

    it("handles music.youtube.com", () => {
      expect(getParsedUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });
  });

  describe("other http URLs", () => {
    it("returns http URLs as-is", () => {
      const url = "https://example.com/video.mp4";
      expect(getParsedUrl(url)).toBe(url);
    });

    it("returns http URLs as-is for http scheme", () => {
      const url = "http://example.com/stream";
      expect(getParsedUrl(url)).toBe(url);
    });
  });

  describe("bare strings (KV keys)", () => {
    it("prepends BASE_REDIRECT for bare strings", () => {
      expect(getParsedUrl("ping")).toBe(BASE_REDIRECT + "ping");
    });

    it("prepends BASE_REDIRECT for pingr2", () => {
      expect(getParsedUrl("pingr2")).toBe(BASE_REDIRECT + "pingr2");
    });

    it("prepends BASE_REDIRECT for unknown shortcodes", () => {
      expect(getParsedUrl("pttv")).toBe(BASE_REDIRECT + "pttv");
    });
  });
});

describe("getPlaylistItems", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns first and rest from playlist items", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        items: [
          { snippet: { resourceId: { videoId: "vid1" } } },
          { snippet: { resourceId: { videoId: "vid2" } } },
          { snippet: { resourceId: { videoId: "vid3" } } },
        ],
      }),
    }));

    const result = await getPlaylistItems("apikey", "PLtest");
    expect(result.first).toBe(BASE_YOUTUBE + "vid1");
    expect(result.rest).toEqual([BASE_YOUTUBE + "vid2", BASE_YOUTUBE + "vid3"]);
  });

  it("returns only first when playlist has one item", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        items: [{ snippet: { resourceId: { videoId: "vid1" } } }],
      }),
    }));

    const result = await getPlaylistItems("apikey", "PLtest");
    expect(result.first).toBe(BASE_YOUTUBE + "vid1");
    expect(result.rest).toEqual([]);
  });

  it("returns DEFAULT_PREV fallback when items is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ items: [] }),
    }));

    const result = await getPlaylistItems("apikey", "PLtest");
    expect(result.first).toBe(BASE_REDIRECT + "pingr2");
    expect(result.rest).toEqual([]);
  });

  it("returns DEFAULT_PREV fallback when items is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    }));

    const result = await getPlaylistItems("apikey", "PLtest");
    expect(result.first).toBe(BASE_REDIRECT + "pingr2");
    expect(result.rest).toEqual([]);
  });

  it("throws when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    await expect(getPlaylistItems("apikey", "PLtest")).rejects.toThrow("network error");
  });

  it("calls YouTube API with correct params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ items: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getPlaylistItems("mykey", "PLtest123", 5);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("key=mykey"),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("playlistId=PLtest123"),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("maxResults=5"),
    );
  });
});
