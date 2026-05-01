import { signCookie, setCookieHeader, DEFAULT_COOKIE_MAX_AGE_DAYS } from "../../../src/lib/cookie";
import type { Env } from "../../../src/lib/env";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const maxAgeDays = Number(env.UI_COOKIE_MAX_AGE_DAYS ?? DEFAULT_COOKIE_MAX_AGE_DAYS);

  let password: string;
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await request.formData();
    password = (form.get("password") as string) ?? "";
  } else {
    const body = await request.json<{ password?: string }>();
    password = body.password ?? "";
  }

  if (!password || password !== env.UI_ADMIN_PASSWORD) {
    return new Response("Unauthorized", { status: 401 });
  }

  const cookie = await signCookie("admin", env.UI_COOKIE_SECRET, Date.now());
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin/app",
      "Set-Cookie": setCookieHeader(cookie, maxAgeDays),
    },
  });
};
