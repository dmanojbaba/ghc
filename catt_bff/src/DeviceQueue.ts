import { castCommand, getStatus, getInfo } from "./catt";
import { getPlaylistItems, getParsedUrl } from "./urlHelper";
import {
  DEFAULT_APP, DEFAULT_PREV, DEFAULT_NEXT, DEFAULT_NOW, DEFAULT_TTS, DEFAULT_DEVICE, DEFAULT_PLAYLIST, DEFAULT_VOLUME,
  INPUT_TO_DEVICE, isAudioOnlyInput,
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
      playlist: DEFAULT_PLAYLIST,
      volume:   String(DEFAULT_VOLUME),
    };
    return defaults[key] ?? "";
  }

  private resolveDevice(input: string): string {
    return INPUT_TO_DEVICE[input] ?? input;
  }

  private get serverUrl(): string {
    return this.env.CATT_SERVER_URL;
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

  async advance(): Promise<void> {
    const row = this.sql
      .exec<{ position: number; url: string; title: string | null }>(
        "SELECT position, url, title FROM queue ORDER BY position ASC LIMIT 1",
      )
      .toArray()[0];

    if (!row) {
      // queue empty — play ping sentinel and mark stopped
      const device = this.resolveDevice(this.get("device"));
      await castCommand(this.serverUrl, device, "cast", getParsedUrl(DEFAULT_NEXT), {
        force_default: this.forceDefault(),
      });
      this.set("now", DEFAULT_NOW);
      return;
    }

    this.sql.exec("DELETE FROM queue WHERE position = ?", row.position);
    const device = this.resolveDevice(this.get("device"));
    await castCommand(this.serverUrl, device, "cast", row.url, {
      title:         row.title ?? undefined,
      force_default: this.forceDefault(),
    });
    this.set("prev", row.url);
    this.set("now", "playing");
    await this.state.storage.setAlarm(Date.now() + CAST_SETTLE_MS);
  }

  async clear(): Promise<void> {
    const device = this.resolveDevice(this.get("device"));
    await castCommand(this.serverUrl, device, "stop");
    await this.state.storage.deleteAlarm();
    this.sql.exec("DELETE FROM queue");
    this.set("now",  DEFAULT_NOW);
    this.set("prev", DEFAULT_PREV);
    this.set("next", DEFAULT_NEXT);
    this.set("tts",  DEFAULT_TTS);
  }

  async shuffle(playlistId: string): Promise<void> {
    const device = this.resolveDevice(this.get("device"));
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
    });
    this.set("now", "playing");
    await this.state.storage.setAlarm(Date.now() + CAST_SETTLE_MS);
  }

  async playPrev(): Promise<void> {
    const prev   = getParsedUrl(this.get("prev"));
    const device = this.resolveDevice(this.get("device"));
    await castCommand(this.serverUrl, device, "cast", prev, {
      force_default: this.forceDefault(),
    });
    this.set("now", "playing");
    await this.state.storage.setAlarm(Date.now() + CAST_SETTLE_MS);
  }

  async alarm(): Promise<void> {
    if (this.get("now") === DEFAULT_NOW) return;
    const device = this.resolveDevice(this.get("device"));

    try {
      const info        = await getInfo(this.serverUrl, device);
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
    } catch {
      // getInfo failed — fall back to getStatus + regular polling
      try {
        const statusRes = await getStatus(this.serverUrl, device);
        const state     = statusRes.data?.player_state ?? "UNKNOWN";
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
        await this.advance();
        return new Response("ok");

      case "play": {
        const device = this.resolveDevice(this.get("device"));
        await castCommand(this.serverUrl, device, "play_toggle");
        return new Response("ok");
      }

      case "stop":
        await this.clear();
        return new Response("ok");

      case "clear":
        this.sql.exec("DELETE FROM queue");
        this.set("now", DEFAULT_NOW);
        await this.state.storage.deleteAlarm();
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
        const device = this.resolveDevice(this.get("device"));
        await castCommand(this.serverUrl, device, "stop");
        await this.state.storage.deleteAlarm();
        this.set("now", DEFAULT_NOW);
        if (rawArg.startsWith("http")) {
          await castCommand(this.serverUrl, device, "cast_site", rawArg);
        } else {
          this.set("tts", rawArg);
          if (device.toLowerCase().includes("tv")) {
            const echoUrl = `https://${new URL(request.url).host}/echo`;
            await castCommand(this.serverUrl, device, "cast_site", echoUrl);
          } else {
            await castCommand(this.serverUrl, device, "tts", rawArg);
          }
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
