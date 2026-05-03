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
    willReportState: false,
    roomHint: "playground",
    customData: {},
    deviceInfo: {},
    attributes: {
      availableApplications: [
        { key: "default", names: [{ name_synonym: ["default"], lang: "en" }] },
        { key: "youtube", names: [{ name_synonym: ["youtube"], lang: "en" }] },
      ],
      availableInputs: [
        {
          key: "k",
          names: [{ name_synonym: ["Mini Kitchen", "Kitchen"], lang: "en" }],
        },
        {
          key: "o",
          names: [{ name_synonym: ["Mini Office", "Office"], lang: "en" }],
        },
        {
          key: "b",
          names: [{ name_synonym: ["Mini Bedroom", "Bedroom"], lang: "en" }],
        },
        {
          key: "zbk",
          names: [{ name_synonym: ["Mini ZBK", "ZBK"], lang: "en" }],
        },
        {
          key: "tv",
          names: [{ name_synonym: ["Google TV", "TV"], lang: "en" }],
        },
        {
          key: "otv",
          names: [{ name_synonym: ["Office TV", "OTV"], lang: "en" }],
        },
      ],
      commandOnlyInputSelector: false,
      orderedInputs: true,
      supportActivityState: true,
      supportPlaybackState: true,
      commandOnlyOnOff: true,
      queryOnlyOnOff: false,
      transportControlSupportedCommands: [
        "NEXT",
        "PAUSE",
        "PREVIOUS",
        "RESUME",
        "SEEK_RELATIVE",
        "SHUFFLE",
        "STOP",
      ],
      volumeMaxLevel: 10,
      volumeCanMuteAndUnmute: false,
      commandOnlyVolume: true,
      availableChannels: [
        { key: "ping", names: ["ping"], number: "1" },
        { key: "sun", names: ["Sun News"], number: "2" },
        {
          key: "pttv",
          names: ["Tamil News", "Puthiya Thalaimurai"],
          number: "3",
        },
        {
          key: "london",
          names: ["Radio London", "Athavan Radio"],
          number: "4",
        },
        { key: "dubai", names: ["Radio Dubai", "89.4 Tamil FM"], number: "5" },
        {
          key: "raja",
          names: ["Radio Raja", "Radio Ilaiyaraaja"],
          number: "6",
        },
        { key: "lime", names: ["Radio Lime"], number: "7" },
        {
          key: "chennai",
          names: ["Radio Chennai", "Radio Mirchi"],
          number: "8",
        },
        { key: "arr", names: ["Radio ARR", "Radio Rahman"], number: "9" },
      ],
      commandOnlyChannels: true,
      availableToggles: [
        {
          name: "youtube_app",
          name_values: [
            {
              name_synonym: ["YouTube app"],
              lang: "en",
            },
          ],
        },
      ],
      commandOnlyToggles: false,
    },
  },
];

// Derived from availableInputs: maps every key and name_synonym → catt_backend device name
export const INPUT_TO_DEVICE: Record<string, string> = Object.fromEntries(
  DEVICES.flatMap((d) =>
    (
      d.attributes.availableInputs as Array<{
        key: string;
        names: Array<{ name_synonym: string[] }>;
      }>
    ).flatMap((i) => [
      [i.key, i.names[0].name_synonym[0]],
      ...i.names.flatMap((n) =>
        n.name_synonym.map((s) => [
          s.toLowerCase(),
          i.names[0].name_synonym[0],
        ]),
      ),
    ]),
  ),
);

export const DEFAULT_CHANNEL = "ping";
export const DEFAULT_DEVICE = "o";
export const DEFAULT_APP = "default";
export const DEFAULT_PREV = "pingr2";
export const DEFAULT_NEXT = "ping";
export const DEFAULT_SESSION = "idle";
export const DEFAULT_TTS = "Hello World!";
export const DEFAULT_PLAYLIST = "PLT26XfDyh_oQqoekQItn1eAFqpiWgJQSk";
export const DEFAULT_SLEEP_AT = "";
export const DEFAULT_VOLUME = 10;

export function resolveDevice(input: string): string {
  return INPUT_TO_DEVICE[input] ?? input;
}

export function isAudioOnlyInput(deviceId: string, inputKey: string): boolean {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const inputs = d.attributes.availableInputs as Array<{
      key: string;
      names: Array<{ name_synonym: string[] }>;
    }>;
    for (const i of inputs) {
      if (i.key !== inputKey) continue;
      return i.names.some((n) =>
        n.name_synonym.some((s) => s.toLowerCase().startsWith("mini")),
      );
    }
  }
  return false;
}

export function getAppKey(
  deviceId: string,
  input: string,
  fallback: string,
): string {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const apps = d.attributes.availableApplications as Array<{
      key: string;
      names: Array<{ name_synonym: string[] }>;
    }>;
    for (const a of apps) {
      if (a.key === input) return a.key;
      for (const n of a.names) {
        for (const syn of n.name_synonym) {
          if (syn.toLowerCase() === input.toLowerCase()) return a.key;
        }
      }
    }
  }
  return fallback;
}

export function getInputKey(
  deviceId: string,
  input: string,
  fallback: string | null,
): string | null {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const inputs = d.attributes.availableInputs as Array<{
      key: string;
      names: Array<{ name_synonym: string[] }>;
    }>;
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

export function getAdjacentInput(
  deviceId: string,
  currentKey: string,
  delta: number,
): string {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const inputs = d.attributes.availableInputs as Array<{ key: string }>;
    const idx = inputs.findIndex((i) => i.key === currentKey);
    const base = idx === -1 ? 0 : idx;
    const next = (base + delta + inputs.length) % inputs.length;
    return inputs[next].key;
  }
  return currentKey;
}

export function getAdjacentChannel(
  deviceId: string,
  currentKey: string,
  delta: number,
): string {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const channels = d.attributes.availableChannels as Array<{
      key: string;
      number: string;
    }>;
    const sorted = [...channels].sort(
      (a, b) => Number(a.number) - Number(b.number),
    );
    const idx = sorted.findIndex((c) => c.key === currentKey);
    const base = idx === -1 ? 0 : idx;
    const next = (base + delta + sorted.length) % sorted.length;
    return sorted[next].key;
  }
  return currentKey;
}

export function getChannelKey(
  deviceId: string,
  input: string,
): string | null {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const channels = d.attributes.availableChannels as Array<{
      key: string;
      number: string;
      names: string[];
    }>;
    for (const c of channels) {
      if (c.key === input) return c.key;
      if (c.number === input) return c.key;
      for (const name of c.names) {
        if (name.toLowerCase() === input.toLowerCase()) return c.key;
      }
    }
  }
  return null;
}

export function getDeviceList(deviceId: string): Array<{ key: string; name: string }> {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const inputs = d.attributes.availableInputs as Array<{
      key: string;
      names: Array<{ name_synonym: string[] }>;
    }>;
    return inputs.map((i) => ({ key: i.key, name: i.names[0].name_synonym[0] }));
  }
  return [];
}

export function getChannelList(deviceId: string): Array<{ key: string; name: string; number: string }> {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const channels = d.attributes.availableChannels as Array<{
      key: string;
      names: string[];
      number: string;
    }>;
    return channels
      .slice()
      .sort((a, b) => Number(a.number) - Number(b.number))
      .map((c) => ({ key: c.key, name: c.names[0], number: c.number }));
  }
  return [];
}

export function getChannelListWithSynonyms(deviceId: string): Array<{ key: string; names: string[] }> {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const channels = d.attributes.availableChannels as Array<{
      key: string;
      names: string[];
      number: string;
    }>;
    return channels
      .slice()
      .sort((a, b) => Number(a.number) - Number(b.number))
      .map((c) => ({ key: c.key, names: c.names }));
  }
  return [];
}

export function getChannelCode(
  deviceId: string,
  channelNumber: string,
): string | null {
  for (const d of DEVICES) {
    if (d.id !== deviceId) continue;
    const channels = d.attributes.availableChannels as Array<{
      key: string;
      number: string;
    }>;
    for (const c of channels) {
      if (c.number === channelNumber) return c.key;
    }
  }
  return null;
}
