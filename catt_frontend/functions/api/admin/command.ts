import { guardCookie } from "../../../src/lib/guard";
import { fetchWithTimeout } from "../../../src/lib/proxy";
import { DEFAULT_COOKIE_MAX_AGE_DAYS } from "../../../src/lib/cookie";
import type { Env } from "../../../src/lib/env";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const maxAgeDays = Number(env.UI_COOKIE_MAX_AGE_DAYS ?? DEFAULT_COOKIE_MAX_AGE_DAYS);
  const denied = await guardCookie(request, ["admin"], env.UI_COOKIE_SECRET, maxAgeDays);
  if (denied) return denied;

  const body = await request.json<{ command?: string; device?: string; value?: string }>();
  return fetchWithTimeout(`${env.CATT_BFF_URL}/catt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": env.CATT_API_KEY },
    body: JSON.stringify(body),
  });
};
