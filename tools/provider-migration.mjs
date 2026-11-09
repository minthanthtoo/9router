#!/usr/bin/env node

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const BUNDLE_FORMAT = "9router-provider-migration";
export const BUNDLE_VERSION = 1;
const KDF = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 32 });
const TRANSIENT_FIELDS = new Set([
  "lastTested",
  "lastError",
  "lastErrorAt",
  "rateLimitedUntil",
  "errorCode",
  "consecutiveUseCount",
]);
const LOCAL_PROXY_FIELDS = new Set([
  "proxyPoolId",
  "connectionProxyEnabled",
  "connectionProxyUrl",
  "connectionNoProxy",
]);

function fail(message) {
  throw new Error(message);
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function atomicWrite(filePath, contents, mode = 0o600) {
  const destination = resolve(filePath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, contents, { mode, flag: "wx" });
  chmodSync(temporary, mode);
  renameSync(temporary, destination);
}

function assertPrivateFile(filePath, label) {
  const mode = statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    fail(`${label} must not be readable by group or others (expected chmod 600)`);
  }
}

export function readPassphrase(filePath) {
  if (!filePath) fail("--passphrase-file is required");
  const resolved = resolve(filePath);
  assertPrivateFile(resolved, "Passphrase file");
  const passphrase = readFileSync(resolved, "utf8").replace(/[\r\n]+$/, "");
  if (passphrase.length < 16) fail("Migration passphrase must be at least 16 characters");
  return passphrase;
}

function assertDatabase(db) {
  const quickCheck = db.prepare("PRAGMA quick_check").get();
  if (!quickCheck || Object.values(quickCheck)[0] !== "ok") fail("SQLite quick_check failed");
  const required = ["_meta", "providerConnections", "providerNodes"];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  for (const table of required) {
    if (!tables.has(table)) fail(`Not a supported 9Router database: missing table ${table}`);
  }
}

function metadata(db) {
  const rows = db.prepare("SELECT key, value FROM _meta").all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function inspectDatabase(dbPath) {
  const db = new DatabaseSync(resolve(dbPath), { readOnly: true, allowExtension: false });
  try {
    assertDatabase(db);
    const meta = metadata(db);
    return {
      status: "ready",
      appVersion: meta.appVersion || null,
      schemaVersion: Number(meta.schemaVersion || 0),
    };
  } finally {
    db.close();
  }
}

export function bootstrapDatabase(dbPath, { appVersion, schemaVersion }) {
  const numericSchemaVersion = Number(schemaVersion);
  if (!appVersion || !Number.isInteger(numericSchemaVersion) || numericSchemaVersion < 1) {
    fail("Database bootstrap requires --app-version and a positive integer --schema-version");
  }
  const destination = resolve(dbPath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(destination, { allowExtension: false, timeout: 5000 });
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS providerConnections (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL,
        name TEXT, email TEXT, priority INTEGER, isActive INTEGER DEFAULT 1,
        data TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider);
      CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive);
      CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority);
      CREATE TABLE IF NOT EXISTS providerNodes (
        id TEXT PRIMARY KEY, type TEXT, name TEXT, data TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type);
    `);
    const putMeta = db.prepare("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO NOTHING");
    putMeta.run("appVersion", String(appVersion));
    putMeta.run("schemaVersion", String(numericSchemaVersion));
    db.exec("COMMIT");
    assertDatabase(db);
    return {
      status: "bootstrapped",
      appVersion: metadata(db).appVersion || null,
      schemaVersion: Number(metadata(db).schemaVersion || 0),
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may not be open */ }
    throw error;
  } finally {
    db.close();
  }
}

function cleanConnection(row, keepProxyBindings) {
  const data = parseJson(row.data, {});
  for (const field of TRANSIENT_FIELDS) delete data[field];
  if (!keepProxyBindings && data.providerSpecificData) {
    for (const field of LOCAL_PROXY_FIELDS) delete data.providerSpecificData[field];
    if (Object.keys(data.providerSpecificData).length === 0) delete data.providerSpecificData;
  }
  return { ...row, data: stableStringify(data) };
}

function collectPayload(db, { keepProxyBindings = false } = {}) {
  assertDatabase(db);
  const meta = metadata(db);
  const connections = db.prepare(
    "SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt FROM providerConnections ORDER BY provider, priority, id"
  ).all().map((row) => cleanConnection(row, keepProxyBindings));
  const providerIds = new Set(connections.map((row) => row.provider));
  const nodes = db.prepare(
    "SELECT id, type, name, data, createdAt, updatedAt FROM providerNodes ORDER BY id"
  ).all().filter((row) => providerIds.has(row.id));
  return {
    source: {
      appVersion: meta.appVersion || null,
      schemaVersion: Number(meta.schemaVersion || 0),
    },
    exportedAt: new Date().toISOString(),
    keepProxyBindings,
    providerConnections: connections,
    providerNodes: nodes,
  };
}

function encryptPayload(payload, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(stableStringify(payload));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    crypto: {
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      N: KDF.N,
      r: KDF.r,
      p: KDF.p,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptBundle(envelope, passphrase) {
  if (envelope?.format !== BUNDLE_FORMAT || envelope?.version !== BUNDLE_VERSION) {
    fail("Unsupported provider migration bundle format or version");
  }
  const crypto = envelope.crypto || {};
  if (crypto.algorithm !== "aes-256-gcm" || crypto.kdf !== "scrypt") fail("Unsupported bundle encryption");
  if (crypto.N !== KDF.N || crypto.r !== KDF.r || crypto.p !== KDF.p) fail("Unexpected scrypt parameters");
  try {
    const salt = Buffer.from(crypto.salt, "base64");
    const iv = Buffer.from(crypto.iv, "base64");
    const tag = Buffer.from(crypto.tag, "base64");
    const key = scryptSync(passphrase, salt, KDF.keyLength, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    fail("Unable to decrypt migration bundle (wrong passphrase or damaged bundle)");
  }
}

function summarize(payload) {
  const providerCounts = {};
  const authCounts = {};
  for (const row of payload.providerConnections || []) {
    providerCounts[row.provider] = (providerCounts[row.provider] || 0) + 1;
    authCounts[row.authType] = (authCounts[row.authType] || 0) + 1;
  }
  return {
    source: payload.source,
    exportedAt: payload.exportedAt,
    connections: payload.providerConnections?.length || 0,
    providerNodes: payload.providerNodes?.length || 0,
    providers: providerCounts,
    authTypes: authCounts,
    proxyBindingsIncluded: payload.keepProxyBindings === true,
  };
}

export function exportProviders({ dbPath, outPath, passphrase, keepProxyBindings = false, force = false }) {
  const source = resolve(dbPath);
  const destination = resolve(outPath);
  if (existsSync(destination) && !force) fail(`Refusing to overwrite existing bundle: ${destination}`);
  const db = new DatabaseSync(source, { readOnly: true, allowExtension: false });
  let transactionOpen = false;
  try {
    db.exec("BEGIN");
    transactionOpen = true;
    const payload = collectPayload(db, { keepProxyBindings });
    db.exec("COMMIT");
    transactionOpen = false;
    const encrypted = encryptPayload(payload, passphrase);
    const envelope = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      createdAt: new Date().toISOString(),
      summary: summarize(payload),
      ...encrypted,
    };
    atomicWrite(destination, `${JSON.stringify(envelope, null, 2)}\n`);
    return { path: destination, digest: sha256(stableStringify(envelope)), ...envelope.summary };
  } finally {
    if (transactionOpen) db.exec("ROLLBACK");
    db.close();
  }
}

function connectionIdentity(row) {
  const data = parseJson(row.data, {});
  const psd = data.providerSpecificData || {};
  if (row.authType === "oauth") {
    const discriminator = psd.chatgptAccountId || psd.projectId || psd.profileArn || psd.username || "";
    return `oauth|${row.provider}|${row.email || ""}|${discriminator}`;
  }
  if (row.authType === "apikey") return `apikey|${row.provider}|${row.name || ""}`;
  return `${row.authType}|${row.provider}|${row.id}`;
}

function validatePayload(payload) {
  if (!payload || !Array.isArray(payload.providerConnections) || !Array.isArray(payload.providerNodes)) {
    fail("Decrypted bundle has an invalid payload");
  }
  if (!Number.isInteger(payload.source?.schemaVersion) || payload.source.schemaVersion < 1) {
    fail("Bundle is missing a supported source schema version");
  }
  for (const row of payload.providerConnections) {
    for (const field of ["id", "provider", "authType", "data", "createdAt", "updatedAt"]) {
      if (row[field] === null || row[field] === undefined) fail(`Provider connection is missing ${field}`);
    }
    const data = parseJson(row.data, null);
    if (!data || typeof data !== "object") fail(`Provider connection ${row.id} contains invalid JSON data`);
    if (row.authType === "oauth" && !data.accessToken && !data.refreshToken) {
      fail(`OAuth connection ${row.id} contains no access or refresh token`);
    }
    if (row.authType === "apikey" && row.provider !== "ollama-local" && !data.apiKey) {
      fail(`API-key connection ${row.id} contains no API key`);
    }
  }
}

function mergeData(existingData, incomingData, mode) {
  if (mode === "replace") return incomingData;
  const existing = parseJson(existingData, {});
  const incoming = parseJson(incomingData, {});
  return stableStringify({
    ...existing,
    ...incoming,
    providerSpecificData: {
      ...(existing.providerSpecificData || {}),
      ...(incoming.providerSpecificData || {}),
    },
  });
}

function planImport(db, payload, conflict) {
  const existingConnections = db.prepare(
    "SELECT id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt FROM providerConnections"
  ).all();
  const byId = new Map(existingConnections.map((row) => [row.id, row]));
  const byIdentity = new Map(existingConnections.map((row) => [connectionIdentity(row), row]));
  const plan = { insert: [], update: [], skip: [], nodeUpserts: payload.providerNodes };
  for (const incoming of payload.providerConnections) {
    const existing = byId.get(incoming.id) || byIdentity.get(connectionIdentity(incoming));
    if (!existing) {
      let id = incoming.id;
      while (byId.has(id)) id = randomUUID();
      const row = { ...incoming, id };
      plan.insert.push(row);
      byId.set(id, row);
      byIdentity.set(connectionIdentity(row), row);
      continue;
    }
    if (conflict === "skip") {
      plan.skip.push({ incomingId: incoming.id, existingId: existing.id, provider: incoming.provider });
      continue;
    }
    plan.update.push({
      ...incoming,
      id: existing.id,
      createdAt: existing.createdAt,
      data: mergeData(existing.data, incoming.data, conflict),
    });
  }
  return plan;
}

function applyPlan(db, plan) {
  const upsertNode = db.prepare(`
    INSERT INTO providerNodes(id, type, name, data, createdAt, updatedAt)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET type=excluded.type, name=excluded.name,
      data=excluded.data, updatedAt=excluded.updatedAt
  `);
  const upsertConnection = db.prepare(`
    INSERT INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, authType=excluded.authType,
      name=excluded.name, email=excluded.email, priority=excluded.priority,
      isActive=excluded.isActive, data=excluded.data, updatedAt=excluded.updatedAt
  `);
  for (const row of plan.nodeUpserts) {
    upsertNode.run(row.id, row.type, row.name, row.data, row.createdAt, row.updatedAt);
  }
  for (const row of [...plan.insert, ...plan.update]) {
    upsertConnection.run(
      row.id, row.provider, row.authType, row.name, row.email, row.priority,
      row.isActive, row.data, row.createdAt, row.updatedAt
    );
  }
}

function verifyImported(db, plan) {
  const get = db.prepare("SELECT data FROM providerConnections WHERE id = ?");
  for (const expected of [...plan.insert, ...plan.update]) {
    const row = get.get(expected.id);
    if (!row) fail(`Post-import verification failed for connection ${expected.id}`);
    const data = parseJson(row.data, {});
    if (expected.authType === "oauth" && !data.accessToken && !data.refreshToken) {
      fail(`Post-import OAuth credential verification failed for ${expected.id}`);
    }
    if (expected.authType === "apikey" && expected.provider !== "ollama-local" && !data.apiKey) {
      fail(`Post-import API-key verification failed for ${expected.id}`);
    }
  }
}

export async function importProviders({
  dbPath,
  bundlePath,
  passphrase,
  conflict = "merge",
  dryRun = false,
  offlineConfirmed = false,
  backupDir,
  stateDir,
}) {
  if (!["merge", "skip", "replace"].includes(conflict)) fail("--conflict must be merge, skip, or replace");
  if (!dryRun && !offlineConfirmed) fail("Refusing live import without --offline-confirmed");
  const bundleText = readFileSync(resolve(bundlePath), "utf8");
  const envelope = JSON.parse(bundleText);
  const digest = sha256(stableStringify(envelope));
  const payload = decryptBundle(envelope, passphrase);
  validatePayload(payload);
  const markerPath = stateDir ? join(resolve(stateDir), `${digest}.json`) : null;
  if (markerPath && existsSync(markerPath)) {
    return { status: "already_applied", digest, summary: summarize(payload) };
  }
  const target = resolve(dbPath);
  const db = new DatabaseSync(target, { allowExtension: false, timeout: 5000 });
  try {
    assertDatabase(db);
    const targetMeta = metadata(db);
    if (Number(targetMeta.schemaVersion || 0) !== payload.source.schemaVersion) {
      fail(`Schema mismatch: bundle=${payload.source.schemaVersion}, target=${targetMeta.schemaVersion || "unknown"}`);
    }
    const plan = planImport(db, payload, conflict);
    const result = {
      status: dryRun ? "dry_run" : "imported",
      digest,
      source: payload.source,
      target: { appVersion: targetMeta.appVersion || null, schemaVersion: Number(targetMeta.schemaVersion || 0) },
      changes: {
        inserted: plan.insert.length,
        updated: plan.update.length,
        skipped: plan.skip.length,
        providerNodesUpserted: plan.nodeUpserts.length,
      },
    };
    if (dryRun) return result;
    const resolvedBackupDir = resolve(backupDir || join(dirname(target), "backups"));
    mkdirSync(resolvedBackupDir, { recursive: true, mode: 0o700 });
    const backupPath = join(resolvedBackupDir, `pre-provider-import-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
    await sqliteBackup(db, backupPath);
    chmodSync(backupPath, 0o600);
    db.exec("BEGIN IMMEDIATE");
    try {
      applyPlan(db, plan);
      verifyImported(db, plan);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    result.backupPath = backupPath;
    if (markerPath) {
      atomicWrite(markerPath, `${JSON.stringify({ digest, appliedAt: new Date().toISOString(), result }, null, 2)}\n`);
    }
    return result;
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return { command, options };
}

function usage() {
  return `Usage:
  provider-migration.mjs ready --db PATH
  provider-migration.mjs bootstrap --db PATH --app-version VERSION --schema-version VERSION
  provider-migration.mjs export --db PATH --out PATH --passphrase-file PATH [--keep-proxy-bindings] [--force]
  provider-migration.mjs inspect --bundle PATH --passphrase-file PATH
  provider-migration.mjs import --db PATH --bundle PATH --passphrase-file PATH --offline-confirmed [--conflict merge|skip|replace] [--backup-dir PATH] [--state-dir PATH]
  provider-migration.mjs import --db PATH --bundle PATH --passphrase-file PATH --dry-run [--conflict merge|skip|replace]
`;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || options.help) {
    process.stdout.write(usage());
    return;
  }
  let result;
  if (command === "ready") {
    result = inspectDatabase(options.db);
  } else if (command === "bootstrap") {
    result = bootstrapDatabase(options.db, {
      appVersion: options.appVersion,
      schemaVersion: options.schemaVersion,
    });
  } else if (command === "export") {
    const passphrase = readPassphrase(options.passphraseFile);
    result = exportProviders({
      dbPath: options.db,
      outPath: options.out,
      passphrase,
      keepProxyBindings: options.keepProxyBindings === true,
      force: options.force === true,
    });
  } else if (command === "inspect") {
    const passphrase = readPassphrase(options.passphraseFile);
    const envelope = JSON.parse(readFileSync(resolve(options.bundle), "utf8"));
    result = summarize(decryptBundle(envelope, passphrase));
  } else if (command === "import") {
    const passphrase = readPassphrase(options.passphraseFile);
    result = await importProviders({
      dbPath: options.db,
      bundlePath: options.bundle,
      passphrase,
      conflict: options.conflict || "merge",
      dryRun: options.dryRun === true,
      offlineConfirmed: options.offlineConfirmed === true,
      backupDir: options.backupDir,
      stateDir: options.stateDir,
    });
  } else {
    fail(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`provider-migration: ${error.message}\n`);
    process.exitCode = 1;
  });
}
