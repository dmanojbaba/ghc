import { describe, it, expect } from "vitest";
import { signCookie, verifyCookie, DEFAULT_COOKIE_MAX_AGE_DAYS, DAYS_TO_MS } from "../lib/cookie";

const SECRET = "test-secret";
const MAX_AGE_MS = DEFAULT_COOKIE_MAX_AGE_DAYS * DAYS_TO_MS;

describe("signCookie", () => {
  it("returns two base64 segments separated by a dot", async () => {
    const cookie = await signCookie("kids", SECRET, Date.now());
    const parts = cookie.split(".");
    expect(parts).toHaveLength(2);
    expect(() => atob(parts[0])).not.toThrow();
    expect(() => atob(parts[1])).not.toThrow();
  });

  it("encodes role and timestamp in payload", async () => {
    const ts = Date.now();
    const cookie = await signCookie("kids", SECRET, ts);
    const payload = atob(cookie.split(".")[0]);
    expect(payload).toBe(`kids:${ts}`);
  });
});

describe("verifyCookie", () => {
  it("verifies a valid kids cookie", async () => {
    const cookie = await signCookie("kids", SECRET, Date.now());
    expect(await verifyCookie(cookie, "kids", SECRET, MAX_AGE_MS)).toBe(true);
  });

  it("verifies a valid admin cookie", async () => {
    const cookie = await signCookie("admin", SECRET, Date.now());
    expect(await verifyCookie(cookie, "admin", SECRET, MAX_AGE_MS)).toBe(true);
  });

  it("rejects a tampered HMAC segment", async () => {
    const cookie = await signCookie("kids", SECRET, Date.now());
    const tampered = cookie.slice(0, -4) + "XXXX";
    expect(await verifyCookie(tampered, "kids", SECRET, MAX_AGE_MS)).toBe(false);
  });

  it("rejects cookie signed with wrong role", async () => {
    const cookie = await signCookie("admin", SECRET, Date.now());
    expect(await verifyCookie(cookie, "kids", SECRET, MAX_AGE_MS)).toBe(false);
  });

  it("rejects cookie signed as kids when verifying as admin", async () => {
    const cookie = await signCookie("kids", SECRET, Date.now());
    expect(await verifyCookie(cookie, "admin", SECRET, MAX_AGE_MS)).toBe(false);
  });

  it("rejects an expired cookie", async () => {
    const expired = Date.now() - MAX_AGE_MS - 1000;
    const cookie = await signCookie("kids", SECRET, expired);
    expect(await verifyCookie(cookie, "kids", SECRET, MAX_AGE_MS)).toBe(false);
  });

  it("rejects undefined", async () => {
    expect(await verifyCookie(undefined, "kids", SECRET, MAX_AGE_MS)).toBe(false);
  });

  it("rejects empty string", async () => {
    expect(await verifyCookie("", "kids", SECRET, MAX_AGE_MS)).toBe(false);
  });

  it("rejects cookie with wrong secret", async () => {
    const cookie = await signCookie("kids", SECRET, Date.now());
    expect(await verifyCookie(cookie, "kids", "wrong-secret", MAX_AGE_MS)).toBe(false);
  });

  it("rejects malformed cookie with no dot", async () => {
    expect(await verifyCookie("nodothere", "kids", SECRET, MAX_AGE_MS)).toBe(false);
  });
});
