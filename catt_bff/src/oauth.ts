function randomString(length = 32): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (const byte of array) {
    result += chars[byte % chars.length];
  }
  return result;
}

export async function handleOAuthAuth(request: Request): Promise<Response> {
  const url    = new URL(request.url);
  const params = url.searchParams;

  if (request.method === "GET") {
    const redirectUri = params.get("redirect_uri") ?? "";
    const state       = params.get("state") ?? "";
    const code        = randomString(6);
    const responseUrl = `${redirectUri}?code=${code}&state=${state}`;

    const html = `<html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<body>
  <form method="post">
    <input type="hidden" name="responseurl" value="${responseUrl}" />
    <button type="submit">Link this service to Google</button>
  </form>
</body>
</html>`;

    return new Response(html, { headers: { "content-type": "text/html;charset=UTF-8" } });
  }

  // POST — redirect to responseurl from form body
  const form        = await request.formData();
  const responseUrl = form.get("responseurl") as string;
  return Response.redirect(responseUrl, 302);
}

export function handleOAuthToken(): Response {
  return Response.json({
    token_type:    "bearer",
    access_token:  randomString(32),
    refresh_token: randomString(32),
    expires_in:    31536000,
  });
}
