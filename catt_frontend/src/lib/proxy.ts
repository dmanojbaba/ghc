export const PROXY_TIMEOUT_MS = 10_000;

export async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return new Response("Gateway timeout", { status: 504 });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
