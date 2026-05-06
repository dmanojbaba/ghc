import { getDefaultPrev } from "./devices";

const BASE_YOUTUBE = "https://www.youtube.com/watch?v=";

export function getParsedUrl(url: string, redirectUrl: string, ytVideoId = false, ytPlaylist = false): string {
  if (ytVideoId) {
    return BASE_YOUTUBE + url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // not a valid URL — treat as KV key or search query
    return redirectUrl + "/r/" + encodeURIComponent(url);
  }

  const redirectHost = new URL(redirectUrl).hostname;
  if (parsed.hostname === redirectHost) {
    return url;
  }

  if (parsed.hostname === "youtu.be") {
    return BASE_YOUTUBE + parsed.pathname.slice(1);
  }

  if (["www.youtube.com", "youtube.com", "music.youtube.com"].includes(parsed.hostname)) {
    if (parsed.pathname === "/watch") {
      const v = parsed.searchParams.get("v");
      if (v) return BASE_YOUTUBE + v;
    }
    if (parsed.pathname.startsWith("/watch/")) {
      return BASE_YOUTUBE + parsed.pathname.split("/")[2];
    }
    if (parsed.pathname.startsWith("/embed/")) {
      return BASE_YOUTUBE + parsed.pathname.split("/")[2];
    }
    if (parsed.pathname.startsWith("/v/")) {
      return BASE_YOUTUBE + parsed.pathname.split("/")[2];
    }
    if (ytPlaylist) {
      const list = parsed.searchParams.get("list");
      if (list) return list;
    }
  }

  if (url.startsWith("http")) {
    return url;
  }

  return redirectUrl + "/r/" + encodeURIComponent(url);
}

export function extractYouTubePlaylistId(url: string): { playlistId: string; videoId: string | null } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["www.youtube.com", "youtube.com", "music.youtube.com"].includes(parsed.hostname)) return null;
  const playlistId = parsed.searchParams.get("list");
  if (!playlistId) return null;
  const videoId = parsed.searchParams.get("v");
  return { playlistId, videoId };
}

export async function getPlaylistItems(
  apiKey: string,
  playlistId: string,
  redirectUrl: string,
  maxResults = 50,
  startVideoId?: string,
  deviceKey = "",
): Promise<{ first: string; firstTitle: string | null; rest: Array<{ url: string; title: string | null }> }> {
  const url =
    `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?part=snippet&key=${apiKey}&maxResults=${maxResults}&playlistId=${playlistId}`;

  const res  = await fetch(url);
  const data = await res.json() as { items?: Array<{ snippet: { resourceId: { videoId: string }; title: string } }> };

  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    if (startVideoId) return { first: BASE_YOUTUBE + startVideoId, firstTitle: null, rest: [] };
    return { first: getParsedUrl(getDefaultPrev(deviceKey), redirectUrl), firstTitle: null, rest: [] };
  }

  const items = data.items.map((item) => ({
    url:   getParsedUrl(item.snippet.resourceId.videoId, redirectUrl, true),
    title: item.snippet.title ? item.snippet.title.slice(0, 40) : null,
  }));
  const urls = items.map((i) => i.url);

  if (startVideoId) {
    const startUrl = BASE_YOUTUBE + startVideoId;
    const idx = urls.indexOf(startUrl);
    if (idx === -1) {
      return { first: startUrl, firstTitle: null, rest: items };
    }
    const from = items.slice(idx);
    return { first: from[0].url, firstTitle: from[0].title, rest: from.slice(1) };
  }

  return { first: items[0].url, firstTitle: items[0].title, rest: items.slice(1) };
}
