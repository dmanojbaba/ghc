import { verifyCookie, parseCookieHeader, COOKIE_NAME, DAYS_TO_MS } from "./cookie";
import type { Role } from "./cookie";

export async function guardCookie(
  request: Request,
  roles: Role[],
  secret: string,
  maxAgeDays: number,
): Promise<Response | null> {
  const maxAgeMs = maxAgeDays * DAYS_TO_MS;
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const cookieVal = cookies[COOKIE_NAME];
  for (const role of roles) {
    if (await verifyCookie(cookieVal, role, secret, maxAgeMs)) return null;
  }
  return new Response("Unauthorized", { status: 401 });
}
