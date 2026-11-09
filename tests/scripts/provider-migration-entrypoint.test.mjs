import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const hook = join(projectRoot, "tools/provider-migration-entrypoint.sh");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "9router-entrypoint-"));
  t.after(() => {
    try { rmSync(readFileSync(join(dir, "passphrase-path"), "utf8"), { force: true }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "su-exec"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const env = { PATH: `${dir}:/usr/bin:/bin`, DATA_DIR: join(dir, "data") };
  return { dir, env };
}

function lines(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n");
}

test("migration hook preserves the image command and arguments", (t) => {
  const { env } = fixture(t);
  const result = spawnSync("/bin/bash", [hook, "node", "custom-server.js", "--port", "20128"], { env, encoding: "utf8" });
  assert.deepEqual(lines(result), ["node", "node", "custom-server.js", "--port", "20128"]);
});

test("direct invocation defaults to the custom server", (t) => {
  const { env } = fixture(t);
  const result = spawnSync("/bin/bash", [hook], { env, encoding: "utf8" });
  assert.deepEqual(lines(result), ["node", "node", "custom-server.js"]);
});

test("missing configured migration bundle prevents app startup", (t) => {
  const { dir, env } = fixture(t);
  const result = spawnSync("/bin/bash", [hook, "node", "custom-server.js"], {
    env: { ...env, PROVIDER_MIGRATION_BUNDLE: join(dir, "missing.json") }, encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /configured bundle does not exist/);
  assert.equal(result.stdout, "");
});

for (const migrationEnabled of [false, true]) {
  test(`Docker entrypoint forwards CMD with migration ${migrationEnabled ? "enabled" : "disabled"}`, (t) => {
    const { dir, env } = fixture(t);
    const dockerfile = readFileSync(join(projectRoot, "Dockerfile"), "utf8");
    const match = dockerfile.match(/printf '([^']+)' > \/entrypoint\.sh/);
    assert.ok(match, "Docker entrypoint generator must be present");
    const stubHook = join(dir, "hook.sh");
    writeFileSync(stubHook, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    const generated = match[1].replaceAll("\\n", "\n")
      .replace("chown -R node:node /app/data /app/data-home 2>/dev/null", ":")
      .replace("/app/tools/provider-migration-entrypoint.sh", stubHook);
    const entrypoint = join(dir, "entrypoint.sh");
    writeFileSync(entrypoint, generated);
    const result = spawnSync("/bin/sh", [entrypoint, "node", "custom-server.js", "--port", "20128"], {
      env: { ...env, ...(migrationEnabled ? { PROVIDER_MIGRATION_BUNDLE: "fixture" } : {}) }, encoding: "utf8",
    });
    assert.deepEqual(lines(result), migrationEnabled
      ? ["node", "custom-server.js", "--port", "20128"]
      : ["node", "node", "custom-server.js", "--port", "20128"]);
  });
}

function migrationFixture(t) {
  const { dir, env } = fixture(t);
  const trace = join(dir, "trace");
  const passphraseRecord = join(dir, "passphrase-path");
  const bundle = join(dir, "bundle.json");
  writeFileSync(bundle, "{}");
  writeFileSync(join(dir, "node"), `#!/bin/bash
printf '%s\\n' "$2" >> "$TRACE"
if [[ "$2" == ready ]]; then exit 1; fi
if [[ "$2" == import ]]; then
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == --passphrase-file ]]; then printf '%s' "$argument" > "$PASSPHRASE_RECORD"; fi
    previous="$argument"
  done
fi
`, { mode: 0o755 });
  writeFileSync(join(dir, "chown"), '#!/bin/sh\nprintf "chown %s\\n" "$*" >> "$TRACE"\n', { mode: 0o755 });
  writeFileSync(join(dir, "su-exec"), `#!/bin/sh
printf 'exec\\n' >> "$TRACE"
if test -f "$(cat "$PASSPHRASE_RECORD")"; then printf 'temporary-secret-remains\\n' >> "$TRACE"; fi
`, { mode: 0o755 });
  return { dir, trace, env: { ...env, TRACE: trace, PASSPHRASE_RECORD: passphraseRecord,
    PROVIDER_MIGRATION_BUNDLE: bundle, PROVIDER_MIGRATION_PASSPHRASE: "synthetic-validation-passphrase" } };
}

test("migration hands imported files to node before starting the app", (t) => {
  const { trace, env } = migrationFixture(t);
  const result = spawnSync("/bin/bash", [hook, "node", "custom-server.js"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const events = readFileSync(trace, "utf8").trim().split("\n");
  assert.deepEqual(events.filter((line) => !line.includes("temporary-secret")), [
    "ready", "bootstrap", "import", `chown -R node:node ${env.DATA_DIR}`, "exec",
  ]);
});

test("temporary migration passphrase is removed before exec", (t) => {
  const { trace, env } = migrationFixture(t);
  const result = spawnSync("/bin/bash", [hook, "node", "custom-server.js"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(readFileSync(trace, "utf8"), /temporary-secret-remains/);
});
