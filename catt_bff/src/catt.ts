export interface CattResponse {
  status: string;
  data?: unknown;
  error?: string;
  error_type?: string;
}

export interface CattStatusResponse {
  status: string;
  data?: {
    title?: string;
    player_state?: string;
    content_id?: string;
  };
}

export interface CattInfoResponse {
  status: string;
  data?: {
    duration?: number;
    current_time?: number;
    player_state?: string;
    content_type?: string;
    stream_type?: string;
  };
}

function cattHeaders(secret?: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["X-Catt-Secret"] = secret;
  return headers;
}

export async function castCommand(
  serverUrl: string,
  device: string,
  command: string,
  value?: unknown,
  extra?: Record<string, unknown>,
  secret?: string,
): Promise<CattResponse> {
  const body: Record<string, unknown> = { device, command };
  if (value !== undefined) body.value = value;
  if (extra) Object.assign(body, extra);

  const res = await fetch(serverUrl.replace(/\/$/, "") + "/catt", {
    method: "POST",
    headers: cattHeaders(secret),
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`catt_backend error: ${res.status}`);
  return res.json() as Promise<CattResponse>;
}

export async function getStatus(serverUrl: string, device: string, secret?: string): Promise<CattStatusResponse> {
  const res = await fetch(serverUrl.replace(/\/$/, "") + "/catt", {
    method: "POST",
    headers: cattHeaders(secret),
    body: JSON.stringify({ device, command: "status" }),
  });

  if (!res.ok) throw new Error(`catt_backend error: ${res.status}`);
  return res.json() as Promise<CattStatusResponse>;
}

export async function getInfo(serverUrl: string, device: string, secret?: string): Promise<CattInfoResponse> {
  const res = await fetch(serverUrl.replace(/\/$/, "") + "/catt", {
    method: "POST",
    headers: cattHeaders(secret),
    body: JSON.stringify({ device, command: "info" }),
  });

  if (!res.ok) throw new Error(`catt_backend error: ${res.status}`);
  return res.json() as Promise<CattInfoResponse>;
}
