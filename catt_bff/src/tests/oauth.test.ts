import { describe, it, expect } from "vitest";
import { handleOAuthAuth, handleOAuthToken } from "../oauth";

describe("handleOAuthAuth", () => {
  describe("GET", () => {
    it("returns HTML with a form", async () => {
      const request = new Request("https://example.com/oauth/auth?redirect_uri=https://callback.example.com&state=xyz", {
        method: "GET",
      });
      const response = await handleOAuthAuth(request);
      const text = await response.text();

      expect(response.headers.get("content-type")).toContain("text/html");
      expect(text).toContain("<form");
      expect(text).toContain("Link this service to Google");
    });

    it("embeds redirect_uri and state in responseurl", async () => {
      const request = new Request("https://example.com/oauth/auth?redirect_uri=https://callback.example.com&state=abc123", {
        method: "GET",
      });
      const response = await handleOAuthAuth(request);
      const text = await response.text();

      expect(text).toContain("https://callback.example.com");
      expect(text).toContain("state=abc123");
    });

    it("handles missing redirect_uri gracefully", async () => {
      const request = new Request("https://example.com/oauth/auth", { method: "GET" });
      const response = await handleOAuthAuth(request);
      expect(response.status).toBe(200);
    });
  });

  describe("POST", () => {
    it("redirects to responseurl from form body", async () => {
      const form = new FormData();
      form.append("responseurl", "https://callback.example.com?code=abc&state=xyz");

      const request = new Request("https://example.com/oauth/auth", {
        method: "POST",
        body: form,
      });
      const response = await handleOAuthAuth(request);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("callback.example.com");
      expect(response.headers.get("location")).toContain("code=abc");
      expect(response.headers.get("location")).toContain("state=xyz");
    });
  });
});

describe("handleOAuthToken", () => {
  it("returns bearer token response", async () => {
    const response = handleOAuthToken();
    const body = await response.json() as Record<string, unknown>;

    expect(body.token_type).toBe("bearer");
    expect(typeof body.access_token).toBe("string");
    expect(body.expires_in).toBe(31536000);
  });

  it("access_token is 32 chars", async () => {
    const response = handleOAuthToken();
    const body = await response.json() as Record<string, unknown>;
    expect((body.access_token as string).length).toBe(32);
  });

  it("includes a refresh_token", async () => {
    const response = handleOAuthToken();
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body.refresh_token).toBe("string");
    expect((body.refresh_token as string).length).toBe(32);
  });

  it("returns a different token on each call", async () => {
    const r1 = handleOAuthToken();
    const r2 = handleOAuthToken();
    const b1 = await r1.json() as Record<string, unknown>;
    const b2 = await r2.json() as Record<string, unknown>;
    expect(b1.access_token).not.toBe(b2.access_token);
  });
});
