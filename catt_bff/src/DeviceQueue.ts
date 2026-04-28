import { castCommand, getStatus, getInfo } from "./catt";
import { getPlaylistItems, getParsedUrl } from "./urlHelper";
import {
  DEFAULT_APP, DEFAULT_PREV, DEFAULT_NEXT, DEFAULT_NOW, DEFAULT_TTS, DEFAULT_DEVICE, DEFAULT_PLAYLIST, DEFAULT_VOLUME, DEFAULT_CHANNEL,
  resolveDevice, isAudioOnlyInput, getInputKey, DEVICE_ID,
} from "./devices";

const POLL_INTERVAL_MS   = 10_000;
const FAST_POLL_MS       = 3_000;
const APPROACH_WINDOW_MS = 10_000;
const CAST_SETTLE_MS     = 10_000;

export class DeviceQueue implements DurableObject {
  private sql: SqlStorage;

  constructor(private state: DurableObjectState, private env: Env) {
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS queue (
        position  INTEGER PRIMARY KEY AUTOINCREMENT,
        url       TEXT NOT NULL,
        title     TEXT,
        added_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private get(key: string): string {
    const rows = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray();
    return rows[0]?.value ?? this.defaultFor(key);
  }

  private set(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", key, value);
  }

  private defaultFor(key: string): string {
    const defaults: Record<string, string> = {
      now:      DEFAULT_NOW,
      prev:     DEFAULT_PREV,
      next:     DEFAULT_NEXT,
      app:      DEFAULT_APP,
      tts:      DEFAULT_TTS,
      device:   DEFAULT_DEVICE,
      channel:  DEFAULT_CHANNEL,
      playlist: DEFAULT_PLAYLIST,
      volume:   String(DEFAULT_VOLUME),
    };
    return defaults[key] ?? "";
  }

  private get serverUrl(): string {
    return this.env.CATT_SERVER_URL;
  }

  private get secret(): string | undefined {
    return this.env.CATT_SERVER_SECRET || undefined;
  }

  private forceDefault(): boolean {
    return this.get("app") === DEFAULT_APP;
  }


  async enqueue(url: string, title?: string): Promise<void> {
    this.sql.exec(
      "INSERT INTO queue (url, title, added_at) VALUES (?, ?, ?)",
      url,
      title ?? null,
      new Date().toISOString(),
    );
    if (this.get("now") === DEFAULT_NOW) {
      await this.advance();
    }
  }

  async advance(userInitiated = false): Promise<void> {
    const row = this.sql
      .exec<{ position: number; url: string; title: string | null }>(
        "SELECT position, url, title FROM queue ORDER BY position ASC LIMIT 1",
      )
      .toArray()[0];

    if (!row) {
      if (userInitiated) {
        const device = resolveDevice(this.get("device"));
        await castCommand(this.serverUrl, device, "cast", getParsedUrl(DEFAULT_NEXT), {
          force_default: this.forceDefault(),
        }, this.secret);
      }
      this.set("now", DEFAULT_NOW);
      await this.state.storage.deleteAlarm();
      return;
    }

    this.sql.exec("DELETE FROM queue WHERE position = ?", row.position);
    const device = resolveDevice(this.get("device"));
    await castCommand(this.serverUrl, device, "cast", row.url, {
      title:         row.title ?? undefined,
      force_default: this.forceDefault(),
    }, this.secret);
    this.set("prev", row.url);
    this.set("now", "playing");
    await this.state.storage.setAlarm(Date.now() + CAST_SETTLE_MS);
  }

  private async clearState(): Promise<void> {
    this.sql.exec("DELETE FROM queue");
    await this.state.storage.deleteAlarm();
    this.set("now",     DEFAULT_NOW);
    this.set("prev",    DEFAULT_PREV);
    this.set("next",    DEFAULT_NEXT);
    this.set("tts",     DEFAULT_TTS);
    this.set("channel", DEFAULT_CHANNEL);
  }

  async clear(): Promise<void> {
    const device = resolveDevice(this.get("device"));
    await castCommand(this.serverUrl, device, "stop", undefined, undefined, this.secret);
    await this.clearState();
  }

  async shuffle(playlistId: string): Promise<void> {
    const device = resolveDevice(this.get("device"));
    let first: string;
    let rest: string[];
    try {
      ({ first, rest } = await getPlaylistItems(this.env.YOUTUBE_API_KEY, playlistId));
    } catch {
      this.set("now", DEFAULT_NOW);
      await this.state.storage.deleteAlarm();
      return;
    }
    this.sql.exec("DELETE FROM queue");
    const now = new Date().toISOString();
    for (const url of rest) {
      this.sql.exec("INSERT INTO queue (url, title, added_at) VALUES (?, ?, ?)", url, null, now);
    }
    this.set("prev", first);
    await castCommand(this.serverUrl, device, "cast", first, {
      force_default: this.forceDefault(),
    }, this.secret);
    this.set("now", "playing");
    await this.state.storage.setAlarm(Date.now() + CAST_SETTLE_MS);
  }

  private async playSite(arg: string, host: string): Promise<void> {
    const device = resolveDevice(this.get("device"));
    await castCommand(this.serverUrl, device, "stop", undefined, undefined, this.secret);
    this.sql.exec("DELETE FROM queue");
    await this.state.storage.deleteAlarm();
    this.set("now", DEFAULT_NOW);
    if (arg.startsWith("http")) {
      await castCommand(this.serverUrl, device, "cast_site", arg, undefined, this.secret);
    } else {
      this.set("tts", arg);
      if (device.toLowerCase().includes("tv")) {
        await castCommand(this.serverUrl, device, "cast_site", `https://${host}/echo?text=${encodeURIComponent(arg)}`, undefined, this.secret);
      } else {
        this.set("prev", "tts");
        await castCommand(this.serverUrl, device, "tts", arg, undefined, this.secret);
      }
    }
  }

  async playPrev(): Promise<void> {
    const rawPrev = this.get("prev");
    const device  = resolveDevice(this.get("device"));

    if (rawPrev === "tts") {
      await castCommand(this.serverUrl, device, "tts", this.get("tts"), undefined, this.secret);
    } else {
      await castCommand(this.serverUrl, device, "cast", getParsedUrl(rawPrev), {
        force_default: this.forceDefault(),
      }, this.secret);
    }

    if (rawPrev !== DEFAULT_PREV && rawPrev !== "tts") {
      this.set("now", "playing");
      await this.state.storage.setAlarm(Date.now() + CAST_SETTLE_MS);
    } else {
      this.set("now", DEFAULT_NOW);
      await this.state.storage.deleteAlarm();
    }
  }

  async alarm(): Promise<void> {
    if (this.get("now") === DEFAULT_NOW) return;
    const device = resolveDevice(this.get("device"));

    try {
      const info        = await getInfo(this.serverUrl, device, this.secret);
      const state       = info.data?.player_state ?? "UNKNOWN";
      const duration    = info.data?.duration;
      const currentTime = info.data?.current_time ?? 0;

      if (state === "IDLE" || state === "UNKNOWN") {
        await this.advance();
        return;
      }

      const isPlaying = state === "PLAYING" || state === "BUFFERING";
      if (isPlaying && duration && duration > 0) {
        const remainingMs = (duration - currentTime) * 1000;
        const delayMs     = remainingMs <= APPROACH_WINDOW_MS
          ? FAST_POLL_MS
          : Math.max(remainingMs - APPROACH_WINDOW_MS, FAST_POLL_MS);
        await this.state.storage.setAlarm(Date.now() + delayMs);
        return;
      }
      // Live stream (no duration) — never ends naturally, no need to poll
      if (isPlaying && !duration) {
        await this.state.storage.deleteAlarm();
        return;
      }
    } catch {
      // getInfo failed — fall back to getStatus + regular polling
      try {
        const statusRes = await getStatus(this.serverUrl, device, this.secret);
        const state     = statusRes.data?.player_state ?? "UNKNOWN";
        if (statusRes.data?.volume_level !== undefined) {
          this.set("volume", String(Math.round(statusRes.data.volume_level * 100)));
        }
        if (state === "IDLE" || state === "UNKNOWN") {
          await this.advance();
          return;
        }
      } catch {
        // both calls failed — still reschedule to keep the loop alive
      }
    }
    await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
  }

  async getState(): Promise<Record<string, unknown>> {
    const rows = this.sql
      .exec<{ position: number; url: string; title: string | null }>(
        "SELECT position, url, title FROM queue ORDER BY position ASC",
      )
      .toArray();

    const alarmTs = await this.state.storage.getAlarm();

    return {
      alarm:     alarmTs ? new Date(alarmTs).toISOString() : null,
      now:       this.get("now"),
      device:    this.get("device"),
      channel:   this.get("channel"),
      app:       this.get("app"),
      volume:    Number(this.get("volume")) || DEFAULT_VOLUME,
      prev:      this.get("prev"),
      next:      rows[0]?.url ?? DEFAULT_NEXT,
      playlist:  this.get("playlist"),
      tts:       this.get("tts"),
      queue:     rows.slice(1).map((r) => r.url),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url   = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["device", "box", action, ...rest]
    const action = parts[2] ?? "";

    switch (action) {
      case "state":
        return new Response(JSON.stringify(await this.getState(), null, 2), { headers: { "content-type": "application/json" } });

      case "prev":
        await this.playPrev();
        return new Response("ok");

      case "next":
        await this.advance(true);
        return new Response("ok");

      case "play": {
        const device = resolveDevice(this.get("device"));
        await castCommand(this.serverUrl, device, "play_toggle", undefined, undefined, this.secret);
        return new Response("ok");
      }

      case "stop":
        await this.clear();
        return new Response("ok");

      case "clear":
        await this.clearState();
        return new Response("ok");

      case "cast": {
        const rawUrl  = decodeURIComponent(parts.slice(3).join("/"));
        const method  = request.method.toUpperCase();
        if (method === "POST") {
          const body = await request.json() as { url: string; title?: string };
          await this.enqueue(body.url, body.title);
        } else {
          await this.enqueue(rawUrl);
        }
        return new Response("ok");
      }

      case "site": {
        const rawArg = decodeURIComponent(parts.slice(3).join("/"));
        await this.playSite(rawArg, new URL(request.url).host);
        return new Response("ok");
      }

      case "catt": {
        const body = await request.json() as { command: string; value?: string; device?: string };
        const cmd        = body.command;
        const val        = body.value ?? "";
        const deviceArg  = body.device ?? "";

        if (deviceArg && deviceArg !== "queue") {
          const key = getInputKey(DEVICE_ID, deviceArg, null) ?? deviceArg;
          this.set("device", key);
          if (isAudioOnlyInput(DEVICE_ID, key)) this.set("app", DEFAULT_APP);
        }

        const device = resolveDevice(this.get("device"));

        if (cmd === "cast") {
          const parsedUrl = getParsedUrl(val);
          if (deviceArg === "queue") {
            await this.enqueue(parsedUrl);
          } else {
            this.sql.exec("DELETE FROM queue");
            await this.state.storage.deleteAlarm();
            await castCommand(this.serverUrl, device, "cast", parsedUrl, {
              force_default: this.forceDefault(),
            }, this.secret);
            this.set("prev", parsedUrl);
            this.set("now", "playing");
            await this.state.storage.setAlarm(Date.now() + CAST_SETTLE_MS);
          }

        } else if (cmd === "site") {
          await this.playSite(val, new URL(request.url).host);

        } else {
          return new Response("unknown command", { status: 400 });
        }

        return new Response("ok");
      }

      case "shuffle": {
        const playlistId = this.get("playlist");
        if (playlistId) await this.shuffle(playlistId);
        return new Response("ok");
      }

      case "set": {
        const key   = parts[3];
        const value = parts[4] ?? "";
        if (key) {
          this.set(key, value);
          if (key === "device" && isAudioOnlyInput("box", value)) {
            this.set("app", DEFAULT_APP);
          }
        }
        return new Response("ok");
      }

      default:
        return new Response("not found", { status: 404 });
    }
  }
}
