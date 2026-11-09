import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isolateTestData(env = process.env) {
  // Preserve a caller-selected store and the explicit real-provider workflow.
  if (env.DATA_DIR || env.RUN_REAL === "1") return { owned: false, cleanup() {} };

  const directory = mkdtempSync(join(tmpdir(), "9router-vitest-data-"));
  env.DATA_DIR = directory;
  return {
    owned: true,
    directory,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
      if (env.DATA_DIR === directory) delete env.DATA_DIR;
    },
  };
}
