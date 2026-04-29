import { DEFAULT_PREV } from "./devices";

const BASE_YOUTUBE  = "https://www.youtube.com/watch?v=";
const BASE_REDIRECT = "https://r.manojbaba.com/r/";

export function getParsedUrl(url: string, ytVideoId = false, ytPlaylist = false): string {
  if (ytVideoId) {
    return BASE_YOUTUBE + url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // not a valid URL — treat as KV key or search query
    return BASE_REDIRECT + encodeURIComponent(url);
  }

  if (parsed.hostname === "r.manojbaba.com") {
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

  return BASE_REDIRECT + encodeURIComponent(url);
}

export async function getPlaylistItems(
  apiKey: string,
  playlistId: string,
  maxResults = 10,
): Promise<{ first: string; rest: string[] }> {
  const url =
    `https://www.googleapis.com/youtube/v3/playlistItems` +
    `?part=snippet&key=${apiKey}&maxResults=${maxResults}&playlistId=${playlistId}`;

  const res  = await fetch(url);
  const data = await res.json() as { items?: Array<{ snippet: { resourceId: { videoId: string } } }> };

  if (!data.items || !Array.isArray(data.items) || data.items.length === 0) {
    return { first: getParsedUrl(DEFAULT_PREV), rest: [] };
  }

  const urls = data.items.map((item) => getParsedUrl(item.snippet.resourceId.videoId, true));
  return { first: urls[0], rest: urls.slice(1) };
}
