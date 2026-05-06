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

const FETCH_TIMEOUT_MS = 50_000;

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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`catt_backend error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<CattResponse>;
}

export async function getStatus(serverUrl: string, device: string, secret?: string): Promise<CattStatusResponse> {
  const res = await fetch(serverUrl.replace(/\/$/, "") + "/catt", {
    method: "POST",
    headers: cattHeaders(secret),
    body: JSON.stringify({ device, command: "status" }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`catt_backend error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<CattStatusResponse>;
}

export async function getInfo(serverUrl: string, device: string, secret?: string): Promise<CattInfoResponse> {
  const res = await fetch(serverUrl.replace(/\/$/, "") + "/catt", {
    method: "POST",
    headers: cattHeaders(secret),
    body: JSON.stringify({ device, command: "info" }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`catt_backend error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<CattInfoResponse>;
}
