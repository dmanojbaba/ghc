export interface CattResponse {
  status: string;
  data?: unknown;
  error?: string;
  error_type?: string;
}

export interface CattStatusResponse {
  status: string;
  data?: {
    volume_level?: number;
    volume_muted?: boolean;
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

export async function castCommand(
  serverUrl: string,
  device: string,
  command: string,
  value?: unknown,
  extra?: Record<string, unknown>,
): Promise<CattResponse> {
  const body: Record<string, unknown> = { device, command };
  if (value !== undefined) body.value = value;
  if (extra) Object.assign(body, extra);

  const res = await fetch(serverUrl.replace(/\/$/, "") + "/catt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return res.json() as Promise<CattResponse>;
}

export async function getStatus(serverUrl: string, device: string): Promise<CattStatusResponse> {
  const res = await fetch(serverUrl.replace(/\/$/, "") + "/catt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device, command: "status" }),
  });

  return res.json() as Promise<CattStatusResponse>;
}

export async function getInfo(serverUrl: string, device: string): Promise<CattInfoResponse> {
  const res = await fetch(serverUrl.replace(/\/$/, "") + "/catt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device, command: "info" }),
  });

  return res.json() as Promise<CattInfoResponse>;
}
