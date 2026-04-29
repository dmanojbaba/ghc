export const DEVICE_ID = "box";

export interface DeviceDefinition {
  id: string;
  type: string;
  traits: string[];
  name: { name: string; nicknames: string[] };
  willReportState: boolean;
  roomHint: string;
  customData: Record<string, unknown>;
  deviceInfo: Record<string, unknown>;
  attributes: Record<string, unknown>;
}

export const DEVICES: DeviceDefinition[] = [
  {
    id: DEVICE_ID,
    type: "action.devices.types.TV",
    traits: [
      "action.devices.traits.AppSelector",
      "action.devices.traits.Channel",
      "action.devices.traits.InputSelector",
      "action.devices.traits.MediaState",
      "action.devices.traits.Toggles",
      "action.devices.traits.OnOff",
      "action.devices.traits.TransportControl",
      "action.devices.traits.Volume",
    ],
    name: {
      name: "playground tv",
      nicknames: ["smart tv", "smart box", "google box", "googlebox"],
    },
    willReportState: true,
    roomHint: "playground",
    customData: {},
    deviceInfo: {},
    attributes: {
      availableApplications: [
        { key: "default", names: [{ name_synonym: ["default"], lang: "en" }] },
        { key: "youtube", names: [{ name_synonym: ["youtube"], lang: "en" }] },
      ],
      availableInputs: [
        { key: "k",   names: [{ name_synonym: ["Mini Kitchen"],  lang: "en" }] },
        { key: "o",   names: [{ name_synonym: ["Mini Office"],   lang: "en" }] },
        { key: "b",   names: [{ name_synonym: ["Mini Bedroom"],  lang: "en" }] },
        { key: "zbk", names: [{ name_synonym: ["Mini ZBK"],      lang: "en" }] },
        { key: "tv",  names: [{ name_synonym: ["Google TV"],     lang: "en" }] },
        { key: "otv", names: [{ name_synonym: ["Office TV"],     lang: "en" }] },
      ],
      commandOnlyInputSelector: false,
      orderedInputs: false,
      supportActivityState: true,
      supportPlaybackState: true,
      commandOnlyOnOff: true,
      queryOnlyOnOff: false,
      transportControlSupportedCommands: ["NEXT", "PREVIOUS", "PAUSE", "STOP", "RESUME", "SHUFFLE", "SEEK_RELATIVE"],
      volumeMaxLevel: 10,
      volumeCanMuteAndUnmute: false,
      commandOnlyVolume: true,
      availableChannels: [
        { key: "ping",    names: ["ping"],          number: "1" },
        { key: "sun",     names: ["Sun News"],      number: "2" },
        { key: "pttv",    names: ["Tamil News"],    number: "3" },
        { key: "london",  names: ["Radio London"],  number: "4" },
        { key: "dubai",   names: ["Radio Dubai"],   number: "5" },
        { key: "lime",    names: ["Radio Lime"],    number: "6" },
        { key: "chennai", names: ["Radio Chennai"], number: "7" },
      ],
      commandOnlyChannels: true,
      availableToggles: [
        {
          name: "youtube_app",
          name_values: [{ name_synonym: ["YouTube", "YouTube app", "YouTube mode"], lang: "en" }],
        },
      ],
      commandOnlyToggles: false,
    },
  },
];

// Maps alias key → catt_server device name
export const INPUT_TO_DEVICE: Record<string, string> = {
  k:   "Mini Kitchen",
  o:   "Mini Office",
  b:   "Mini Bedroom",
  zbk: "Mini ZBK",
  tv:  "Google TV",
  otv: "Office TV",
};

export const DEFAULT_CHANNEL  = "ping";
export const DEFAULT_DEVICE   = "otv";
export const DEFAULT_APP      = "default";
export const DEFAULT_PREV     = "pingr2";
export const DEFAULT_NEXT     = "ping";
export const DEFAULT_SESSION  = "idle";
export const DEFAULT_TTS      = "Hello World!";
export const DEFAULT_PLAYLIST = "PLT26XfDyh_oQqoekQItn1eAFqpiWgJQSk";
export const DEFAULT_SLEEP_AT = "";
export const DEFAULT_VOLUME   = 50;

export function resolveDevice(input: string): string {
  return INPUT_TO_DEVICE[input] ?? input;
}

export function isAudioOnlyInput(deviceId: string, inputKey: string): boolean {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const inputs = d.attributes.availableInputs as Array<{ key: string; names: Array<{ name_synonym: string[] }> }>;
    for (const i of inputs) {
      if (i.key !== inputKey) continue;
      return i.names.some((n) => n.name_synonym.some((s) => s.toLowerCase().startsWith("mini")));
    }
  }
  return false;
}

export function getInputKey(deviceId: string, input: string, fallback: string | null): string | null {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const inputs = d.attributes.availableInputs as Array<{ key: string; names: Array<{ name_synonym: string[] }> }>;
    for (const i of inputs) {
      if (i.key === input) return i.key;
      for (const n of i.names) {
        for (const syn of n.name_synonym) {
          if (syn.toLowerCase() === input.toLowerCase()) return i.key;
        }
      }
    }
  }
  return fallback;
}

export function getAdjacentChannel(deviceId: string, currentKey: string, delta: number): string {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const channels = d.attributes.availableChannels as Array<{ key: string; number: string }>;
    const sorted = [...channels].sort((a, b) => Number(a.number) - Number(b.number));
    const idx = sorted.findIndex((c) => c.key === currentKey);
    const base = idx === -1 ? 0 : idx;
    const next = (base + delta + sorted.length) % sorted.length;
    return sorted[next].key;
  }
  return currentKey;
}

export function getChannelCode(deviceId: string, channelNumber: string): string | null {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const channels = d.attributes.availableChannels as Array<{ key: string; number: string }>;
    for (const c of channels) {
      if (c.number === channelNumber) return c.key;
    }
  }
  return null;
}
