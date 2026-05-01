import { guardCookie } from "../../src/lib/guard";
import { fetchWithTimeout } from "../../src/lib/proxy";
import { DEFAULT_COOKIE_MAX_AGE_DAYS } from "../../src/lib/cookie";
import type { Env } from "../../src/lib/env";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const maxAgeDays = Number(env.UI_COOKIE_MAX_AGE_DAYS ?? DEFAULT_COOKIE_MAX_AGE_DAYS);
  const denied = await guardCookie(request, ["kids", "admin"], env.UI_COOKIE_SECRET, maxAgeDays);
  if (denied) return denied;

  return fetchWithTimeout(`${env.CATT_BFF_URL}/devices`, {
    headers: { "X-API-Key": env.CATT_API_KEY },
  });
};
