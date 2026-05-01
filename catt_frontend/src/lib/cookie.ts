export type Role = "kids" | "admin";

const COOKIE_NAME = "__Secure-catt_session";
export const DEFAULT_COOKIE_MAX_AGE_DAYS = 7;
export const DAYS_TO_MS = 24 * 60 * 60 * 1000;

async function hmac(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifyHmac(secret: string, message: string, expected: string): Promise<boolean> {
  const actual = await hmac(secret, message);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export async function signCookie(role: Role, secret: string, ts: number): Promise<string> {
  const payload = btoa(`${role}:${ts}`);
  const sig = await hmac(secret, `${role}:${ts}`);
  return `${payload}.${sig}`;
}

export async function verifyCookie(
  cookie: string | undefined | null,
  role: Role,
  secret: string,
  maxAgeMs: number,
): Promise<boolean> {
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot === -1) return false;
  const payload = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  let decoded: string;
  try {
    decoded = atob(payload);
  } catch {
    return false;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return false;
  const cookieRole = decoded.slice(0, colon);
  const ts = Number(decoded.slice(colon + 1));
  if (cookieRole !== role) return false;
  if (isNaN(ts) || Date.now() - ts > maxAgeMs) return false;
  return verifyHmac(secret, `${role}:${ts}`, sig);
}

export function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((p) => {
      const eq = p.indexOf("=");
      return eq === -1 ? [p.trim(), ""] : [p.slice(0, eq).trim(), p.slice(eq + 1).trim()];
    }),
  );
}

export function setCookieHeader(value: string, maxAgeDays: number): string {
  const maxAge = maxAgeDays * (DAYS_TO_MS / 1000);
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}; Path=/`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/`;
}

export { COOKIE_NAME };
