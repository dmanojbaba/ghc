import { castCommand } from "./catt";
import { getParsedUrl } from "./urlHelper";
import {
  DEVICES, DEVICE_ID, INPUT_TO_DEVICE,
  DEFAULT_APP, DEFAULT_DEVICE, DEFAULT_VOLUME,
  getInputKey, getAppKey, getAdjacentInput, getChannelCode,
} from "./devices";

function randomString(length = 6): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (const byte of array) result += chars[byte % chars.length];
  return result;
}

async function doGet(stub: DurableObjectStub, deviceKey: string, path: string): Promise<void> {
  await stub.fetch(`https://do/device/${deviceKey}${path}`);
}

async function doState(stub: DurableObjectStub, deviceKey: string): Promise<Record<string, unknown>> {
  const res = await stub.fetch(`https://do/device/${deviceKey}/state`);
  return res.json() as Promise<Record<string, unknown>>;
}

export async function handleSync(requestId: string): Promise<Record<string, unknown>> {
  return {
    requestId,
    payload: {
      agentUserId: "catt-user",
      devices: DEVICES,
    },
  };
}

export async function handleQuery(
  requestId: string,
  payload: { devices: Array<{ id: string }> },
  stub: DurableObjectStub,
  deviceKey = DEFAULT_DEVICE,
): Promise<Record<string, unknown>> {
  const states: Record<string, unknown> = {};

  for (const device of payload.devices) {
    if (device.id === DEVICE_ID) {
      const doSt      = await doState(stub, deviceKey);
      const inputKey  = deviceKey;

      states[device.id] = {
        online:              true,
        on:                  true,
        currentApplication:  String(doSt.app ?? DEFAULT_APP),
        currentInput:        inputKey,
        currentToggleSettings: { youtube_app: doSt.app === "youtube" },
        currentVolume:       DEFAULT_VOLUME,
        isMuted:             false,
        activityState:       "ACTIVE",
        playbackState:       doSt.session === "active" ? "PLAYING" : doSt.session === "paused" ? "PAUSED" : "STOPPED",
      };
    } else {
      states[device.id] = { online: true, on: true };
    }
  }

  return { requestId, payload: { devices: states } };
}

async function handleExecute(
  requestId: string,
  payload: {
    commands: Array<{
      devices: Array<{ id: string }>;
      execution: Array<{ command: string; params?: Record<string, unknown> }>;
    }>;
  },
  stub: DurableObjectStub,
  env: Env,
  deviceKey = DEFAULT_DEVICE,
): Promise<Record<string, unknown>> {
  const results: unknown[] = [];

  for (const cmd of payload.commands) {
    for (const device of cmd.devices) {
      if (device.id !== DEVICE_ID) {
        results.push({ ids: [device.id], status: "SUCCESS", states: { online: true } });
        continue;
      }
      const inputKey   = deviceKey;
      const cattDevice = INPUT_TO_DEVICE[inputKey] ?? inputKey;

      for (const exec of cmd.execution) {
        const command = exec.command;
        const params  = exec.params ?? {};
        let result: Record<string, unknown>;

        if (command === "action.devices.commands.OnOff") {
          if (params.on) {
            await doGet(stub, deviceKey, "/reset");
            await env.CALLER_KV.put("googlehome:all", DEFAULT_DEVICE);
            result = {
              status: "SUCCESS",
              states: {
                on: true,
                online: true,
                playbackState: "STOPPED",
                currentInput: DEFAULT_DEVICE,
                currentApplication: DEFAULT_APP,
                currentToggleSettings: { youtube_app: false },
              },
            };
          } else {
            await doGet(stub, deviceKey, "/off");
            result = { status: "SUCCESS", states: { on: false, online: true, playbackState: "STOPPED" } };
          }

        } else if (command === "action.devices.commands.SetToggles") {
          const on = Boolean((params.updateToggleSettings as Record<string, boolean>)?.youtube_app);
          const appMode = on ? "youtube" : DEFAULT_APP;
          await doGet(stub, deviceKey, "/set/app/" + appMode);
          result = { status: "SUCCESS", states: { online: true, currentToggleSettings: { youtube_app: on } } };

        } else if (command === "action.devices.commands.SetInput") {
          const newInput = String(params.newInput);
          const key      = getInputKey(DEVICE_ID, newInput, null) ?? newInput;
          await env.CALLER_KV.put("googlehome:all", key);
          const updatedSt = await doState(stub, deviceKey);
          const newApp    = String(updatedSt.app ?? DEFAULT_APP);
          result = {
            status: "SUCCESS",
            states: {
              online: true,
              currentInput: key,
              currentApplication: newApp,
              currentToggleSettings: { youtube_app: newApp === "youtube" },
            },
          };

        } else if (
          command === "action.devices.commands.NextInput" ||
          command === "action.devices.commands.PreviousInput"
        ) {
          const delta  = command === "action.devices.commands.NextInput" ? 1 : -1;
          const key    = getAdjacentInput(DEVICE_ID, inputKey, delta);
          await env.CALLER_KV.put("googlehome:all", key);
          const updatedSt = await doState(stub, deviceKey);
          const newApp    = String(updatedSt.app ?? DEFAULT_APP);
          result = {
            status: "SUCCESS",
            states: {
              online: true,
              currentInput: key,
              currentApplication: newApp,
              currentToggleSettings: { youtube_app: newApp === "youtube" },
            },
          };

        } else if (command === "action.devices.commands.selectChannel") {
          const channelCode = String(
            params.channelCode ?? getChannelCode(DEVICE_ID, String(params.channelNumber)) ?? "",
          );
          await doGet(stub, deviceKey, "/channel/" + encodeURIComponent(channelCode));
          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.relativeChannel") {
          const delta = Number(params.relativeChannelChange);
          await doGet(stub, deviceKey, "/channel/" + (delta >= 0 ? "up" : "down"));
          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.mediaShuffle") {
          await doGet(stub, deviceKey, "/shuffle");
          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.returnChannel") {
          await doGet(stub, deviceKey, "/prev");
          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.mediaPrevious") {
          await doGet(stub, deviceKey, "/prev");
          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.mediaNext") {
          await doGet(stub, deviceKey, "/next");
          result = { status: "SUCCESS", states: { online: true } };

        } else if (
          command === "action.devices.commands.mediaResume" ||
          command === "action.devices.commands.mediaPause"
        ) {
          await castCommand(env.CATT_BACKEND_URL, cattDevice, "play_toggle", undefined, undefined, env.CATT_BACKEND_SECRET);
          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.mediaStop") {
          await doGet(stub, deviceKey, "/stop");
          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.appSelect") {
          const raw = String(params.newApplication ?? params.newApplicationName ?? DEFAULT_APP);
          const app = getAppKey(DEVICE_ID, raw, DEFAULT_APP);
          await doGet(stub, deviceKey, "/set/app/" + app);
          result = { status: "SUCCESS", states: { online: true, currentApplication: app } };

        } else if (
          command === "action.devices.commands.appInstall" ||
          command === "action.devices.commands.appSearch"
        ) {
          const query = String(params.newApplicationName ?? params.newApplication ?? "");
          if (query) {
            await doGet(stub, deviceKey, "/clear");
            await doGet(stub, deviceKey, "/cast/" + encodeURIComponent(getParsedUrl(query, env.REDIRECT_URL)));
          }

          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.setVolume") {
          const volume = Number(params.volumeLevel ?? 5);
          await castCommand(env.CATT_BACKEND_URL, cattDevice, "volume", volume * 10, undefined, env.CATT_BACKEND_SECRET);
          result = { status: "SUCCESS", states: { online: true, currentVolume: volume } };

        } else if (command === "action.devices.commands.mediaSeekRelative") {
          const seconds = Number(params.relativePositionMs ?? 0) / 1000;
          if (seconds > 0) {
            await doGet(stub, deviceKey, `/ffwd/${encodeURIComponent(Math.abs(seconds))}`);
          } else if (seconds < 0) {
            await doGet(stub, deviceKey, `/rewind/${encodeURIComponent(Math.abs(seconds))}`);
          }
          result = { status: "SUCCESS", states: { online: true } };

        } else if (command === "action.devices.commands.mute") {
          const muted = Boolean(params.mute ?? true);
          await doGet(stub, deviceKey, `/mute/${muted}`);
          result = { status: "SUCCESS", states: { online: true, isMuted: muted } };

        } else if (command === "action.devices.commands.volumeRelative") {
          const steps = Number(params.relativeSteps ?? 0);
          if (steps > 0) {
            await castCommand(env.CATT_BACKEND_URL, cattDevice, "volumeup", steps * 10, undefined, env.CATT_BACKEND_SECRET);
          } else if (steps < 0) {
            await castCommand(env.CATT_BACKEND_URL, cattDevice, "volumedown", Math.abs(steps) * 10, undefined, env.CATT_BACKEND_SECRET);
          }
          result = { status: "SUCCESS", states: { online: true } };

        } else {
          result = { status: "SUCCESS", states: { online: true } };
        }

        results.push({ ids: [device.id], ...result });
      }
    }
  }

  return { requestId, payload: { commands: results } };
}

export async function handleFulfillment(request: Request, env: Env, stub: DurableObjectStub, deviceKey = DEFAULT_DEVICE): Promise<Response> {
  const body      = await request.json() as {
    requestId: string;
    inputs: Array<{ intent: string; payload?: unknown }>;
  };
  const requestId = body.requestId ?? randomString(6);

  let result: Record<string, unknown> = { requestId, payload: {} };

  for (const input of body.inputs) {
    if (input.intent === "action.devices.SYNC") {
      result = await handleSync(requestId);
    } else if (input.intent === "action.devices.DISCONNECT") {
      return Response.json({});
    } else if (input.intent === "action.devices.QUERY") {
      result = await handleQuery(requestId, input.payload as Parameters<typeof handleQuery>[1], stub, deviceKey);
    } else if (input.intent === "action.devices.EXECUTE") {
      result = await handleExecute(requestId, input.payload as Parameters<typeof handleExecute>[1], stub, env, deviceKey);
    }
  }

  return Response.json(result);
}
