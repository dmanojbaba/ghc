import { describe, it, expect, vi, beforeEach } from "vitest";
import { getParsedUrl, getPlaylistItems, extractYouTubePlaylistId } from "../urlHelper";

const BASE_YOUTUBE  = "https://www.youtube.com/watch?v=";
const REDIRECT_URL  = process.env.REDIRECT_URL!;
const BASE_REDIRECT = REDIRECT_URL + "/r/";

describe("getParsedUrl", () => {
  describe("ytVideoId=true", () => {
    it("prepends BASE_YOUTUBE to bare video id", () => {
      expect(getParsedUrl("dQw4w9WgXcQ", REDIRECT_URL, true)).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("takes priority before URL parsing", () => {
      expect(getParsedUrl("abc123", REDIRECT_URL, true)).toBe(BASE_YOUTUBE + "abc123");
    });
  });

  describe("redirect URLs", () => {
    it("returns redirect URLs as-is", () => {
      const url = REDIRECT_URL + "/r/ping";
      expect(getParsedUrl(url, REDIRECT_URL)).toBe(url);
    });
  });

  describe("youtu.be URLs", () => {
    it("converts short YouTube URL to full URL", () => {
      expect(getParsedUrl("https://youtu.be/dQw4w9WgXcQ", REDIRECT_URL)).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });
  });

  describe("youtube.com URLs", () => {
    it("extracts video id from /watch?v=", () => {
      expect(getParsedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", REDIRECT_URL)).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("extracts video id from /watch/", () => {
      expect(getParsedUrl("https://www.youtube.com/watch/dQw4w9WgXcQ", REDIRECT_URL)).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("extracts video id from /embed/", () => {
      expect(getParsedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ", REDIRECT_URL)).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("extracts video id from /v/", () => {
      expect(getParsedUrl("https://www.youtube.com/v/dQw4w9WgXcQ", REDIRECT_URL)).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });

    it("extracts playlist id when ytPlaylist=true", () => {
      expect(getParsedUrl("https://www.youtube.com/playlist?list=PLtest123", REDIRECT_URL, false, true)).toBe("PLtest123");
    });

    it("returns full URL for youtube.com without ytPlaylist flag", () => {
      const url = "https://www.youtube.com/playlist?list=PLtest123";
      expect(getParsedUrl(url, REDIRECT_URL)).toBe(url);
    });

    it("handles music.youtube.com", () => {
      expect(getParsedUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ", REDIRECT_URL)).toBe(BASE_YOUTUBE + "dQw4w9WgXcQ");
    });
  });

  describe("other http URLs", () => {
    it("returns http URLs as-is", () => {
      const url = "https://example.com/video.mp4";
      expect(getParsedUrl(url, REDIRECT_URL)).toBe(url);
    });

    it("returns http URLs as-is for http scheme", () => {
      const url = "http://example.com/stream";
      expect(getParsedUrl(url, REDIRECT_URL)).toBe(url);
    });
  });

  describe("bare strings (KV keys)", () => {
    it("prepends BASE_REDIRECT for bare strings", () => {
      expect(getParsedUrl("ping", REDIRECT_URL)).toBe(BASE_REDIRECT + "ping");
    });

    it("prepends BASE_REDIRECT for pingr2", () => {
      expect(getParsedUrl("pingr2", REDIRECT_URL)).toBe(BASE_REDIRECT + "pingr2");
    });

    it("prepends BASE_REDIRECT for unknown shortcodes", () => {
      expect(getParsedUrl("pttv", REDIRECT_URL)).toBe(BASE_REDIRECT + "pttv");
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
          { snippet: { resourceId: { videoId: "vid1" }, title: "Video One" } },
          { snippet: { resourceId: { videoId: "vid2" }, title: "Video Two" } },
          { snippet: { resourceId: { videoId: "vid3" }, title: "Video Three" } },
        ],
      }),
    }));

    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL);
    expect(result.first).toBe(BASE_YOUTUBE + "vid1");
    expect(result.firstTitle).toBe("Video One");
    expect(result.rest).toEqual([
      { url: BASE_YOUTUBE + "vid2", title: "Video Two" },
      { url: BASE_YOUTUBE + "vid3", title: "Video Three" },
    ]);
  });

  it("returns only first when playlist has one item", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        items: [{ snippet: { resourceId: { videoId: "vid1" }, title: "Video One" } }],
      }),
    }));

    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL);
    expect(result.first).toBe(BASE_YOUTUBE + "vid1");
    expect(result.firstTitle).toBe("Video One");
    expect(result.rest).toEqual([]);
  });

  it("returns DEFAULT_PREV fallback when items is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ items: [] }),
    }));

    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL);
    expect(result.first).toBe(BASE_REDIRECT + "pingr2");
    expect(result.firstTitle).toBeNull();
    expect(result.rest).toEqual([]);
  });

  it("returns DEFAULT_PREV fallback when items is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    }));

    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL);
    expect(result.first).toBe(BASE_REDIRECT + "pingr2");
    expect(result.firstTitle).toBeNull();
    expect(result.rest).toEqual([]);
  });

  it("throws when fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    await expect(getPlaylistItems("apikey", "PLtest", REDIRECT_URL)).rejects.toThrow("network error");
  });

  it("reorders from startVideoId when found in playlist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        items: [
          { snippet: { resourceId: { videoId: "vid1" }, title: "Video One" } },
          { snippet: { resourceId: { videoId: "vid2" }, title: "Video Two" } },
          { snippet: { resourceId: { videoId: "vid3" }, title: "Video Three" } },
        ],
      }),
    }));
    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL, 50, "vid2");
    expect(result.first).toBe(BASE_YOUTUBE + "vid2");
    expect(result.firstTitle).toBe("Video Two");
    expect(result.rest).toEqual([{ url: BASE_YOUTUBE + "vid3", title: "Video Three" }]);
  });

  it("plays startVideoId directly and queues full playlist when not found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        items: [
          { snippet: { resourceId: { videoId: "vid1" }, title: "Video One" } },
          { snippet: { resourceId: { videoId: "vid2" }, title: "Video Two" } },
        ],
      }),
    }));
    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL, 50, "vid99");
    expect(result.first).toBe(BASE_YOUTUBE + "vid99");
    expect(result.firstTitle).toBeNull();
    expect(result.rest).toEqual([
      { url: BASE_YOUTUBE + "vid1", title: "Video One" },
      { url: BASE_YOUTUBE + "vid2", title: "Video Two" },
    ]);
  });

  it("plays startVideoId directly when playlist is empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ items: [] }),
    }));
    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL, 50, "vid99");
    expect(result.first).toBe(BASE_YOUTUBE + "vid99");
    expect(result.firstTitle).toBeNull();
    expect(result.rest).toEqual([]);
  });

  it("truncates title to 40 characters", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        items: [{ snippet: { resourceId: { videoId: "vid1" }, title: "A".repeat(60) } }],
      }),
    }));
    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL);
    expect(result.firstTitle).toBe("A".repeat(40));
  });

  it("sets title to null when title is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        items: [{ snippet: { resourceId: { videoId: "vid1" } } }],
      }),
    }));
    const result = await getPlaylistItems("apikey", "PLtest", REDIRECT_URL);
    expect(result.firstTitle).toBeNull();
  });

  it("calls YouTube API with correct params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ items: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await getPlaylistItems("mykey", "PLtest123", REDIRECT_URL, 5);
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

describe("extractYouTubePlaylistId", () => {
  it("extracts list param from youtube.com playlist URL", () => {
    expect(extractYouTubePlaylistId("https://www.youtube.com/playlist?list=PLtest123")).toEqual({ playlistId: "PLtest123", videoId: null });
  });

  it("extracts list and video param from youtube.com watch URL with list", () => {
    expect(extractYouTubePlaylistId("https://www.youtube.com/watch?v=abc&list=PLtest123")).toEqual({ playlistId: "PLtest123", videoId: "abc" });
  });

  it("returns null for youtube.com URL without list param", () => {
    expect(extractYouTubePlaylistId("https://www.youtube.com/watch?v=abc")).toBeNull();
  });

  it("returns null for non-YouTube URL", () => {
    expect(extractYouTubePlaylistId("https://vimeo.com/123")).toBeNull();
  });

  it("returns null for bare string", () => {
    expect(extractYouTubePlaylistId("believer song")).toBeNull();
  });

  it("returns null for youtu.be URL (no playlist support)", () => {
    expect(extractYouTubePlaylistId("https://youtu.be/abc")).toBeNull();
  });
});
