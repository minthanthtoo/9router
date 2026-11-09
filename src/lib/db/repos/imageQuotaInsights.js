import { getAdapter } from "../driver.js";
import { createHash } from "node:crypto";
import { getCustomModels } from "./aliasRepo.js";
import { configuredQuotaModels } from '../../quotaModelCatalog.js';
import { imageQuotaIdentity, imageQuotaIdentityGeneration, imageQuotaIdentityType } from "./imageQuotaIdentity.js";

export const IMAGE_INSIGHT_LIMITS = Object.freeze({ schema: "image_quota_insights.v1", maxRangeSeconds: 604800, maxBuckets: 500 });
const INSIGHT_PROVIDERS = new Set(["gemini", "antigravity", "codex"]);
const OUTCOMES = ["succeeded", "quota_rejected", "provider_rejected", "outcome_unknown", "in_flight"];
const KEYS = new Set(["view", "connection", "scope", "model", "from", "to", "bucketSeconds", "eventsLimit", "eventsCursor"]);
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) throw new TypeError("Invalid UTC range");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction || "").padEnd(3, "0")}Z`)) throw new TypeError("Invalid UTC date");
  return ms;
}

/** Explicit opt-in view: old default status/history/trace contracts are untouched. */
export function parseImageInsightQuery(params, nowMs = Date.now()) {
  for (const key of params.keys()) if (!KEYS.has(key) || params.getAll(key).length !== 1) throw new TypeError("Unsupported or duplicate insight filter");
  if (params.get("view") !== "insights") throw new TypeError("Unsupported insight view");
  const connection = params.get("connection");
  if (!connection || !/^[A-Za-z0-9._:-]{1,160}$/.test(connection)) throw new TypeError("One configured connection is required");
  const scope = params.get("scope") ?? "quota_group";
  if (!["credential", "quota_group"].includes(scope)) throw new TypeError("Invalid scope");
  const model = params.get("model") ?? null;
  if (model !== null && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model))) throw new TypeError("Invalid exact model");
  const toMs = params.has("to") ? timestamp(params.get("to")) : Math.floor(nowMs / 1000) * 1000;
  const fromMs = params.has("from") ? timestamp(params.get("from")) : toMs - 86400_000;
  if (fromMs >= toMs || toMs > nowMs || toMs - fromMs > 604800_000) throw new TypeError("Range must be positive, not future and at most seven days");
  const rawBucket = params.get("bucketSeconds");
  if (rawBucket !== null && !/^[1-9]\d{0,5}$/.test(rawBucket)) throw new TypeError("Invalid bucket size");
  const bucketSeconds = rawBucket === null ? Math.max(60, Math.ceil((toMs - fromMs) / 1000 / 500)) : Number(rawBucket);
  if (bucketSeconds > 604800 || Math.ceil((toMs - fromMs) / (bucketSeconds * 1000)) > 500) throw new TypeError("Too many buckets");
  const rawEventsLimit = params.get("eventsLimit");
  if (rawEventsLimit !== null && !/^(?:[1-9]\d?|100)$/.test(rawEventsLimit)) throw new TypeError("Invalid event page size");
  const eventsCursor = params.get("eventsCursor");
  if (eventsCursor !== null && (eventsCursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(eventsCursor))) throw new TypeError("Invalid event cursor");
  const eventsLimit = rawEventsLimit === null ? 50 : Number(rawEventsLimit);
  return { connection, scope, model, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), bucketSeconds, eventsLimit, eventsCursor };
}

function decodeEventCursor(value, scopeHash, from, to) {
  if (!value) return null;
  try {
    const json = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== value) throw new Error("Noncanonical cursor");
    const cursor = JSON.parse(json);
    if (!cursor || Object.keys(cursor).sort().join(",") !== "at,id,scope,v" || cursor.v !== 1
      || typeof cursor.at !== "string" || typeof cursor.id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(cursor.id)
      || typeof cursor.scope !== "string" || !/^[a-f0-9]{64}$/.test(cursor.scope)
      || cursor.scope !== scopeHash) throw new Error("Invalid cursor scope");
    const at = timestamp(cursor.at);
    if (at < Date.parse(from) || at >= Date.parse(to)) throw new Error("Cursor outside range");
    return { at: cursor.at, id: cursor.id };
  } catch {
    throw new TypeError("Invalid or mismatched event cursor");
  }
}

function encodeEventCursor(at, id, scopeHash) {
  return Buffer.from(JSON.stringify({ v: 1, at, id, scope: scopeHash }), "utf8").toString("base64url");
}

function safeCount(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("Unsafe insight count");
  return n;
}
function counts(row) {
  return Object.fromEntries(["dispatches", "images", ...OUTCOMES].map(key => [key, safeCount(row?.[key] || 0)]));
}

/** Historical membership is recorded at dispatch; never join it through today's credentials. */
export async function getImageQuotaInsights(connection, query, nowMs = Date.now()) {
  query = parseImageInsightQuery(new URLSearchParams({ view: "insights", connection: query.connection, scope: query.scope,
    ...(query.model ? {model: query.model} : {}), from: query.from, to: query.to,
    bucketSeconds: String(query.bucketSeconds), eventsLimit: String(query.eventsLimit ?? 50),
    ...(query.eventsCursor ? {eventsCursor: query.eventsCursor} : {}) }), nowMs);
  if (!connection || connection.id !== query.connection || !["gemini", "antigravity", "codex"].includes(connection.provider)) throw new TypeError("Invalid configured scope");
  const db = await getAdapter();
  if (!["node:sqlite", "better-sqlite3", "bun:sqlite"].includes(db.driver)) throw new TypeError("Durable evidence required");
  const identity = imageQuotaIdentity(connection), generation = imageQuotaIdentityGeneration(connection);
  const cursorScope = createHash("sha256").update(JSON.stringify([
    connection.id, connection.provider, identity, generation, query.scope, query.model, query.from, query.to, query.eventsLimit,
  ])).digest("hex");
  const cursor = decodeEventCursor(query.eventsCursor, cursorScope, query.from, query.to);
  const clauses = ["provider = ?", "supplierIdentity = ?", "identityGeneration = ?", "dispatchedAt >= ?", "dispatchedAt < ?"];
  const args = [connection.provider, identity, generation, query.from, query.to];
  if (query.scope === "credential") { clauses.push("connectionId = ?"); args.push(connection.id); }
  if (query.model) { clauses.push("model = ?"); args.push(query.model); }
  const where = clauses.join(" AND ");
  return db.transaction(() => {
  const measures = ["COUNT(*) AS dispatches", "COALESCE(SUM(outputCount),0) AS images", ...OUTCOMES.map(outcome => `SUM(CASE WHEN outcome = '${outcome}' THEN 1 ELSE 0 END) AS ${outcome}`)].join(", ");
  // Keep totals, buckets and each event page on the same SQLite read snapshot.
  const rows = db.all(`WITH scoped AS (SELECT dispatchedAt, outcome, outputCount, CAST((CAST(ROUND((julianday(dispatchedAt)-2440587.5)*86400000) AS INTEGER) - ?) / ? AS INTEGER) AS bucket FROM imageQuotaRequestSubmissions WHERE ${where})
    SELECT -1 AS bucket, ${measures}, MIN(dispatchedAt) AS firstAt, MAX(dispatchedAt) AS lastAt FROM scoped
    UNION ALL SELECT bucket, ${measures}, MIN(dispatchedAt) AS firstAt, MAX(dispatchedAt) AS lastAt FROM scoped GROUP BY bucket ORDER BY bucket`,
    [Date.parse(query.from), query.bucketSeconds * 1000, ...args]);
  const total = rows.find(row => row.bucket === -1);
  const byBucket = new Map(rows.filter(row => row.bucket >= 0).map(row => [Number(row.bucket), row]));
  const fromMs = Date.parse(query.from), toMs = Date.parse(query.to), step = query.bucketSeconds * 1000;
  const buckets = Array.from({ length: Math.ceil((toMs - fromMs) / step) }, (_, index) => ({
    from: new Date(fromMs + index * step).toISOString(), to: new Date(Math.min(toMs, fromMs + (index + 1) * step)).toISOString(), counts: counts(byBucket.get(index)),
  }));
  const totalCounts = counts(total);
  const eventClauses = [where], eventArgs = [...args];
  if (cursor) {
    eventClauses.push("(dispatchedAt < ? OR (dispatchedAt = ? AND id < ?))");
    eventArgs.push(cursor.at, cursor.at, cursor.id);
  }
  const page = db.all(
    "SELECT id, model, dispatchedAt, outcome, httpStatus, retryAt, confidence, outputCount FROM imageQuotaRequestSubmissions WHERE " +
      eventClauses.join(" AND ") + " ORDER BY dispatchedAt DESC, id DESC LIMIT ?",
    [...eventArgs, query.eventsLimit + 1],
  );
  const hasMore = page.length > query.eventsLimit;
  const events = page.slice(0, query.eventsLimit);
  if (OUTCOMES.reduce((sum, outcome) => sum + totalCounts[outcome], 0) !== totalCounts.dispatches) throw new TypeError("Unknown submission outcome");
  if (Object.keys(totalCounts).some(key => buckets.reduce((sum, bucket) => sum + bucket.counts[key], 0) !== totalCounts[key])) throw new TypeError("Incomplete bucket evidence");
  return { schema: IMAGE_INSIGHT_LIMITS.schema, generatedAt: new Date(nowMs).toISOString(),
    scope: { connectionId: connection.id, provider: connection.provider, model: query.model, kind: query.scope, identityGeneration: generation, identityEvidence: imageQuotaIdentityType(connection) },
    range: { from: query.from, to: query.to, bucketSeconds: query.bucketSeconds, semantics: "dispatch_time_half_open" },
    quality: { coverage: "retained_records_only", externalUsageObserved: false, firstRecordedAt: total?.firstAt || null, lastRecordedAt: total?.lastAt || null, outcomesAsOf: new Date(nowMs).toISOString() },
    units: { dispatches: "physical_provider_submissions", images: "validated_outputs" }, counts: totalCounts, buckets,
    events: { limit: query.eventsLimit, truncated: totalCounts.dispatches > events.length || hasMore,
      nextCursor: hasMore && events.length ? encodeEventCursor(events.at(-1).dispatchedAt, events.at(-1).id, cursorScope) : null,
      items: events.map((row) => ({ model: row.model, dispatchedAt: row.dispatchedAt,
        outcome: OUTCOMES.includes(row.outcome) ? row.outcome : "outcome_unknown",
        httpStatus: Number.isInteger(row.httpStatus) ? row.httpStatus : null,
        retryAt: row.retryAt || null, confidence: ["provider_confirmed", "estimated", "unknown"].includes(row.confidence) ? row.confidence : "unknown",
        outputCount: Number.isSafeInteger(row.outputCount) && row.outputCount >= 0 ? row.outputCount : null })) } };
  });
}

/** A bounded autocomplete catalog from the saved image registry plus retained dispatch evidence. */
export async function getImageQuotaModelCatalog() {
  const models = new Map();
  const add = (provider, id, name, source, capabilities = null) => {
    if (!INSIGHT_PROVIDERS.has(provider) || typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id)) return;
    const key = provider + "\n" + id;
    const existing = models.get(key);
    models.set(key, { provider, id, name: name || id, source: existing ? "catalog_and_observed" : source, capabilities: existing?.capabilities || capabilities });
  };
  let custom = [];
  try { custom = await getCustomModels(); } catch { /* Registry remains available without retained settings. */ }
  for (const model of configuredQuotaModels([...INSIGHT_PROVIDERS], custom)) {
    if (model.kind === "image") add(model.provider, model.id, model.name, "catalog", model.capabilities);
  }
  try {
    const db = await getAdapter();
    if (["node:sqlite", "better-sqlite3", "bun:sqlite"].includes(db.driver)) {
      for (const row of db.all("SELECT DISTINCT provider, model FROM imageQuotaRequestSubmissions WHERE provider IN ('gemini','antigravity','codex') ORDER BY provider, model LIMIT 500")) {
        add(row.provider, row.model, row.model, "observed");
      }
    }
  } catch {
    // Keep static registry suggestions available when retained history is unavailable.
  }
  return [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)).slice(0, 500);
}
