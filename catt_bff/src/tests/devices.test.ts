import { describe, it, expect } from "vitest";
import { getDeviceList, getChannelList, getDefaultPrev } from "../devices";

describe("getDeviceList", () => {
  it("returns all devices for known deviceId", () => {
    const list = getDeviceList("box");
    expect(list.length).toBeGreaterThan(0);
  });

  it("returns correct shape for each entry", () => {
    const list = getDeviceList("box");
    for (const d of list) {
      expect(d).toHaveProperty("key");
      expect(d).toHaveProperty("name");
      expect(typeof d.key).toBe("string");
      expect(typeof d.name).toBe("string");
    }
  });

  it("includes all expected device keys", () => {
    const list = getDeviceList("box");
    const keys = list.map((d) => d.key);
    expect(keys).toContain("k");
    expect(keys).toContain("o");
    expect(keys).toContain("b");
    expect(keys).toContain("zbk");
    expect(keys).toContain("tv");
    expect(keys).toContain("otv");
  });

  it("uses the first name_synonym as the display name", () => {
    const list = getDeviceList("box");
    const kitchen = list.find((d) => d.key === "k");
    expect(kitchen?.name).toBe("Mini Kitchen");
    const otv = list.find((d) => d.key === "otv");
    expect(otv?.name).toBe("Office TV");
  });

  it("returns empty array for unknown deviceId", () => {
    expect(getDeviceList("unknown")).toEqual([]);
  });
});

describe("getChannelList", () => {
  it("returns all channels for known deviceId", () => {
    const list = getChannelList("box");
    expect(list.length).toBeGreaterThan(0);
  });

  it("returns correct shape for each entry", () => {
    const list = getChannelList("box");
    for (const c of list) {
      expect(c).toHaveProperty("key");
      expect(c).toHaveProperty("name");
      expect(c).toHaveProperty("number");
      expect(typeof c.key).toBe("string");
      expect(typeof c.name).toBe("string");
      expect(typeof c.number).toBe("string");
    }
  });

  it("includes all expected channel keys", () => {
    const list = getChannelList("box");
    const keys = list.map((c) => c.key);
    expect(keys).toContain("ping");
    expect(keys).toContain("sun");
    expect(keys).toContain("pttv");
    expect(keys).toContain("london");
  });

  it("is sorted by channel number ascending", () => {
    const list = getChannelList("box");
    const numbers = list.map((c) => Number(c.number));
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBeGreaterThan(numbers[i - 1]);
    }
  });

  it("uses the first name as the display name", () => {
    const list = getChannelList("box");
    const sun = list.find((c) => c.key === "sun");
    expect(sun?.name).toBe("Sun News");
  });

  it("returns empty array for unknown deviceId", () => {
    expect(getChannelList("unknown")).toEqual([]);
  });
});

describe("getDefaultPrev", () => {
  it("returns pingmp3 for audio-only inputs", () => {
    expect(getDefaultPrev("k")).toBe("pingmp3");
    expect(getDefaultPrev("o")).toBe("pingmp3");
    expect(getDefaultPrev("b")).toBe("pingmp3");
    expect(getDefaultPrev("zbk")).toBe("pingmp3");
  });

  it("returns pingmp4 for video-capable inputs", () => {
    expect(getDefaultPrev("tv")).toBe("pingmp4");
    expect(getDefaultPrev("otv")).toBe("pingmp4");
  });
});
