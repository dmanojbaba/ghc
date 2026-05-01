import { guardCookie } from "../../src/lib/guard";
import { fetchWithTimeout } from "../../src/lib/proxy";
import { DEFAULT_COOKIE_MAX_AGE_DAYS } from "../../src/lib/cookie";
import type { Env } from "../../src/lib/env";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const maxAgeDays = Number(env.UI_COOKIE_MAX_AGE_DAYS ?? DEFAULT_COOKIE_MAX_AGE_DAYS);
  const denied = await guardCookie(request, ["kids"], env.UI_COOKIE_SECRET, maxAgeDays);
  if (denied) return denied;

  const res = await fetchWithTimeout(`${env.CATT_BFF_URL}/device/box/state`, {
    headers: { "X-API-Key": env.CATT_API_KEY },
  });
  if (!res.ok) return res;

  const state = await res.json<{ device?: string; session?: string; prev?: string }>();
  return Response.json({ device: state.device, session: state.session, prev: state.prev });
};
