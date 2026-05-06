import { guardCookie } from "../../../src/lib/guard";
import { fetchWithTimeout } from "../../../src/lib/proxy";
import { DEFAULT_COOKIE_MAX_AGE_DAYS } from "../../../src/lib/cookie";
import type { Env } from "../../../src/lib/env";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const maxAgeDays = Number(env.UI_COOKIE_MAX_AGE_DAYS ?? DEFAULT_COOKIE_MAX_AGE_DAYS);
  const denied = await guardCookie(request, ["admin"], env.UI_COOKIE_SECRET, maxAgeDays);
  if (denied) return denied;

  const headers = { "Content-Type": "application/json", "X-API-Key": env.CATT_API_KEY, "X-Caller": "admin" };
  const [stateRes, historyRes] = await Promise.all([
    fetchWithTimeout(`${env.CATT_BFF_URL}/catt`, { method: "POST", headers, body: JSON.stringify({ command: "state" }) }),
    fetchWithTimeout(`${env.CATT_BFF_URL}/catt`, { method: "POST", headers, body: JSON.stringify({ command: "history" }) }),
  ]);

  if (!stateRes.ok) return stateRes;

  const state = await stateRes.json<Record<string, unknown>>();
  const history = historyRes.ok ? await historyRes.json<unknown[]>() : [];
  return Response.json({ ...state, history });
};
