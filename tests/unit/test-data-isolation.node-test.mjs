import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolateTestData } from "../helpers/isolatedTestData.js";

test("default test isolation selects a fresh store before application paths initialize", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { isolateTestData } from './tests/helpers/isolatedTestData.js';
    import { existsSync } from 'node:fs';
    const isolation = isolateTestData();
    const { DATA_DIR } = await import('./src/lib/dataDir.js');
    const result = { owned: isolation.owned, actual: DATA_DIR, expected: isolation.directory };
    isolation.cleanup();
    result.removed = !existsSync(result.expected);
    console.log(JSON.stringify(result));
  `], {
    cwd: root,
    env: { PATH: process.env.PATH || "", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.owned, true);
  assert.equal(resolve(result.actual), resolve(result.expected));
  assert.equal(result.removed, true);
});

test("cleanup preserves a caller-selected database and its files", () => {
  const directory = mkdtempSync(join(tmpdir(), "9router-explicit-test-data-"));
  try {
    const sentinel = join(directory, "database-sentinel");
    writeFileSync(sentinel, "preserve caller data");
    const env = { DATA_DIR: directory };
    const isolation = isolateTestData(env);
    assert.equal(isolation.owned, false);
    isolation.cleanup();
    assert.equal(env.DATA_DIR, directory);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve caller data");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("parallel test contexts receive separate stores and cleanup only their own", () => {
  const first = isolateTestData({});
  const second = isolateTestData({});
  try {
    assert.notEqual(first.directory, second.directory);
    first.cleanup();
    assert.equal(existsSync(second.directory), true);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("the explicit real-provider opt-in is preserved without opening any store", () => {
  const env = { RUN_REAL: "1" };
  const isolation = isolateTestData(env);
  isolation.cleanup();
  assert.equal(isolation.owned, false);
  assert.equal(env.DATA_DIR, undefined);
});
