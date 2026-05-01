import { defineConfig } from "vitest/config";
import { readFileSync } from "fs";
import { resolve } from "path";

function loadEnvFile(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf-8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => l.split("=", 2) as [string, string]),
    );
  } catch {
    return {};
  }
}

const fileEnv = loadEnvFile(resolve(__dirname, ".env.test"));

// CI env vars take precedence over .env.test file values
const env: Record<string, string> = { ...fileEnv };
for (const k of Object.keys(env)) {
  if (process.env[k]) env[k] = process.env[k]!;
}

export default defineConfig({
  test: { env },
});
