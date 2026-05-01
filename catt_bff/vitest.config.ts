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

export default defineConfig({
  test: {
    env: loadEnvFile(resolve(__dirname, ".env.test")),
  },
});
