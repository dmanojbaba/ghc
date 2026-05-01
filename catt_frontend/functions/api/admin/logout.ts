import { clearCookieHeader, verifyCookie, parseCookieHeader, COOKIE_NAME, DEFAULT_COOKIE_MAX_AGE_DAYS, DAYS_TO_MS } from "../../../src/lib/cookie";
import type { Env } from "../../../src/lib/env";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const maxAgeDays = Number(env.UI_COOKIE_MAX_AGE_DAYS ?? DEFAULT_COOKIE_MAX_AGE_DAYS);
  const maxAgeMs = maxAgeDays * DAYS_TO_MS;
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const valid = await verifyCookie(cookies[COOKIE_NAME], "admin", env.UI_COOKIE_SECRET, maxAgeMs);
  if (!valid) {
    return new Response("Unauthorized", { status: 401 });
  }
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin",
      "Set-Cookie": clearCookieHeader(),
    },
  });
};
