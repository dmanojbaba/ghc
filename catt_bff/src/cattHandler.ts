export async function handleCatt(request: Request, _env: Env, doStub: DurableObjectStub): Promise<Response> {
  const body = await request.json() as { command?: string; value?: string; device?: string };
  if (!body.command) return new Response("'command' is required", { status: 400 });

  const forwarded = new Request("https://do/device/box/catt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return doStub.fetch(forwarded);
}
