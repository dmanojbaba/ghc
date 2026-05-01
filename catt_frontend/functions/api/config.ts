import { guardCookie } from "../../src/lib/guard";
import { DEFAULT_COOKIE_MAX_AGE_DAYS } from "../../src/lib/cookie";
import type { Env } from "../../src/lib/env";

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const maxAgeDays = Number(env.UI_COOKIE_MAX_AGE_DAYS ?? DEFAULT_COOKIE_MAX_AGE_DAYS);
  const denied = await guardCookie(request, ["kids", "admin"], env.UI_COOKIE_SECRET, maxAgeDays);
  if (denied) return denied;

  const allowSearch = (env.UI_KIDS_ALLOW_SEARCH ?? "true") !== "false";
  const allowDeviceSwitch = (env.UI_KIDS_ALLOW_DEVICE_SWITCH ?? "true") !== "false";
  let buttons: unknown[] = [];
  if (env.BUTTONS_CONFIG) {
    try {
      buttons = JSON.parse(env.BUTTONS_CONFIG);
    } catch {
      buttons = [];
    }
  }

  return Response.json({ allowSearch, allowDeviceSwitch, buttons });
};
