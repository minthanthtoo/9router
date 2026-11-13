import { accountContext, collectCapacitySamples } from '../../../shared/utils/quotaCapacity.mjs';
import { createHash } from 'node:crypto';
import { getAdapter } from '../driver.js';
import { emptyRotation, normalizeRotationUsage, validateRotation, SNAPSHOT_MAX_AGE_MS, scopeMatches, applicableRotationQuotas } from '../../../shared/utils/rotationSequence.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint = connection => hash([connection.provider, connection.accessToken, connection.apiKey, connection.projectId, connection.providerSpecificData?.accountId, connection.providerSpecificData?.workspaceId, connection.providerSpecificData?.chatgptAccountId, connection.providerSpecificData?.verifiedQuotaIdentity, connection.providerSpecificData?.imageQuotaIdentityGeneration]);
function identityStillCurrent(db, connection) {
  const row = db.get('SELECT provider,data FROM providerConnections WHERE id=?', [connection.id]);
  return row && fingerprint({ ...JSON.parse(row.data), provider: row.provider }) === fingerprint(connection);
}
export const rotationRevision = policy => hash(policy);
function immediate(db, fn) {
  if (!['node:sqlite', 'better-sqlite3', 'bun:sqlite'].includes(db.driver)) {
    const error = new Error('Live sequence rotation requires durable SQLite'); error.status = 503; throw error;
  }
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
function readPolicy(db, provider) {
  const settings = JSON.parse(db.get('SELECT data FROM settings WHERE id=1')?.data || '{}');
  const policy = settings.providerStrategies?.[provider]?.rotationSequence || emptyRotation();
  return { settings, policy, revision: rotationRevision(policy) };
}
export async function readRotationPolicy(provider) { const db = await getAdapter(); const { policy, revision } = readPolicy(db, provider); return { policy, revision }; }
export async function saveRotationPolicy(provider, policy, expectedRevision) {
  policy = validateRotation(policy, provider); const db = await getAdapter();
  return immediate(db, () => {
    const current = readPolicy(db, provider);
    if (current.revision !== expectedRevision) { const error = new Error('Rotation changed elsewhere. Reload before applying.'); error.status = 409; throw error; }
    const strategies = current.settings.providerStrategies || {};
    const settings = { ...current.settings, providerStrategies: { ...strategies, [provider]: { ...strategies[provider], rotationSequence: policy } } };
    db.run('INSERT INTO settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', [JSON.stringify(settings)]);
    return { policy, revision: rotationRevision(policy) };
  });
}
export async function readRotationSnapshots(connections) {
  const db = await getAdapter(), ids = new Map(connections.map(connection => [connection.id, fingerprint(connection)]));
  return Object.fromEntries(db.all('SELECT connectionId,fingerprint,data FROM providerRotationSnapshots').filter(row => ids.get(row.connectionId) === row.fingerprint).map(row => [row.connectionId, JSON.parse(row.data)]).filter(([, value]) => !value.invalidatedAt));
}
export async function recordRotationUsage(connection, usage, readStartedAt = Date.now()) {
  if (!usage?.quotas) return;
  const db = await getAdapter(), identity = fingerprint(connection), now = Date.now(), startedAt = Math.min(readStartedAt, now);
  db.transaction(() => {
    if (!identityStillCurrent(db, connection)) return;
    const previous = db.get('SELECT fingerprint,data FROM providerRotationSnapshots WHERE connectionId=?', [connection.id]);
    const old = previous?.fingerprint === identity ? JSON.parse(previous.data) : null;
    if (old?.pendingReset && readStartedAt <= old.pendingResetUntil || old?.invalidatedAt >= readStartedAt) return;
    if ((old?.usageReadStartedAt ?? (old?.quotas?.length ? old.observedAt : 0)) > startedAt) return;
    const next = { ...normalizeRotationUsage(connection.provider, usage, startedAt), usageReadStartedAt: startedAt };
    if (old?.plan === next.plan && old?.modelAccess) next.modelAccess=old.modelAccess;
    next.completedAt=now;
    next.accountType=accountContext(connection,next);
    if(old?.plan===next.plan && !old.invalidatedAt && !old.pendingReset) {
      const rows=db.all('SELECT timestamp,model,status,tokens,meta FROM usageHistory WHERE connectionId=? AND provider=? AND timestamp>? AND timestamp<=? ORDER BY timestamp,id LIMIT 501',[connection.id,connection.provider,new Date(old.observedAt).toISOString(),new Date(startedAt).toISOString()]);
      const pending=globalThis._pendingRequests?.byAccount?.[connection.id];
      const nextSamples=pending&&Object.values(pending).some(n=>n>0)?[]:collectCapacitySamples(old,next,rows).filter(sample=>scopeMatches(connection.provider,sample.scope,sample.model));
      next.capacitySamples=[...(old.capacitySamples||[]),...nextSamples].filter(sample=>sample.at<=now&&now-sample.at<=7*86400000).slice(-384);
    }

    if ((old?.usageReadStartedAt !== undefined || old?.quotas?.length) && old.observedAt > next.observedAt) return;
    const creditReadAt = old?.creditReadStartedAt ?? old?.credits?.observedAt ?? 0;
    if (old?.credits && now - old.credits.observedAt <= SNAPSHOT_MAX_AGE_MS && (creditReadAt > startedAt || usage.resetCredits?.availableCount === old.credits.availableCount)) next.credits = old.credits;
    // Retain the fence even when a newer usage read invalidates credit details.
    next.creditReadStartedAt = next.credits ? creditReadAt : Math.max(creditReadAt, startedAt);
    db.run('INSERT INTO providerRotationSnapshots(connectionId,fingerprint,data) VALUES(?,?,?) ON CONFLICT(connectionId) DO UPDATE SET fingerprint=excluded.fingerprint,data=excluded.data', [connection.id, identity, JSON.stringify(next)]);
  });
}
// Only successful account-authenticated catalogs are evidence; a static fallback is not.
export async function recordRotationModels(connection, models, readStartedAt = Date.now()) {
  if(!Array.isArray(models) || models.length>4096 || !Number.isFinite(readStartedAt))return;
  const ids=[...new Set(models.map(row=>typeof row==='string'?row:row?.id).filter(id=>typeof id==='string' && id.length>0 && id.length<=256))];
  if(connection.provider!=='codex' || ids.length>4096)return;
  const db=await getAdapter();
  db.transaction(()=>{
    if(!identityStillCurrent(db,connection))return;
    const row=db.get('SELECT fingerprint,data FROM providerRotationSnapshots WHERE connectionId=?',[connection.id]);
    if(row?.fingerprint!==fingerprint(connection))return;
    const next=JSON.parse(row.data);
    if(next.invalidatedAt || (next.modelAccess?.checkedAt||next.modelAccess?.observedAt||0)>readStartedAt || next.usageReadStartedAt>readStartedAt)return;
    const checkedAt=Math.min(readStartedAt,Date.now());
    next.modelAccess=ids.length ? {source:'account_models',observedAt:checkedAt,checkedAt,models:ids} : {...next.modelAccess,checkedAt};
    db.run('UPDATE providerRotationSnapshots SET data=? WHERE connectionId=?',[JSON.stringify(next),connection.id]);
  });
}

export async function recordRotationCredits(connection, details, readStartedAt = Date.now()) {
  const db = await getAdapter(), identity = fingerprint(connection), now = Date.now(), startedAt = Math.min(readStartedAt, now);
  db.transaction(() => {
    if (!identityStillCurrent(db, connection)) return;
    const previous = db.get('SELECT fingerprint,data FROM providerRotationSnapshots WHERE connectionId=?', [connection.id]);
    const next = previous?.fingerprint === identity ? JSON.parse(previous.data) : normalizeRotationUsage(connection.provider, {}, now);
    if (next.pendingReset && readStartedAt <= next.pendingResetUntil || next.invalidatedAt >= readStartedAt) return;
    if ((next.creditReadStartedAt ?? next.credits?.observedAt ?? 0) > startedAt) return;
    delete next.invalidatedAt; delete next.pendingReset; delete next.pendingResetUntil;
    next.credits = { ...normalizeRotationUsage(connection.provider, {}, startedAt, details).credits, observedAt: startedAt };
    next.creditReadStartedAt = startedAt;
    db.run('INSERT INTO providerRotationSnapshots(connectionId,fingerprint,data) VALUES(?,?,?) ON CONFLICT(connectionId) DO UPDATE SET fingerprint=excluded.fingerprint,data=excluded.data', [connection.id, identity, JSON.stringify(next)]);
  });
}
export async function invalidateRotationSnapshot(id, pendingReset = false) {
  const db = await getAdapter();
  const row = db.get('SELECT provider,data FROM providerConnections WHERE id=?', [id]);
  if (!row) return;
  const connection = { ...JSON.parse(row.data), provider: row.provider };
  const tombstone = { provider: row.provider, observedAt: Date.now(), invalidatedAt: Date.now(), pendingReset, pendingResetUntil: pendingReset ? Date.now() + 300000 : null, quotas: [], credits: null };
  db.run('INSERT INTO providerRotationSnapshots(connectionId,fingerprint,data) VALUES(?,?,?) ON CONFLICT(connectionId) DO UPDATE SET fingerprint=excluded.fingerprint,data=excluded.data', [id, fingerprint(connection), JSON.stringify(tombstone)]);
}

export async function chooseSequenceConnection(connections, { provider, model, policy, stickyRequests = 1, peekOnly = false }) {
  if (!connections.length) return null;
  const db = await getAdapter(), scope = JSON.stringify([provider, model, rotationRevision(policy)]);
  return (peekOnly ? fn => fn() : fn => immediate(db, fn))(() => {
    const cursor = db.get('SELECT connectionId,useCount FROM providerRotationCursors WHERE scope=?', [scope]);
    const index = connections.findIndex(connection => connection.id === cursor?.connectionId);
    const stay = index >= 0 && cursor.useCount < stickyRequests;
    const next = stay ? connections[index] : connections[(index + 1) % connections.length];
    const count = stay ? cursor.useCount + 1 : 1;
    if (!peekOnly) db.run('INSERT INTO providerRotationCursors(scope,connectionId,useCount) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET connectionId=excluded.connectionId,useCount=excluded.useCount', [scope, next.id, count]);
    return next;
  });
}

export async function claimCreditReset(connectionId, cycle = null, expectedPolicy = null) {
  const db = await getAdapter();
  return immediate(db, () => {
    if (cycle) {
      const policy = readPolicy(db, 'codex').policy;
      if (!policy.enabled || !policy.resetPriority?.enabled || policy.resetPriority.autoReset !== true || expectedPolicy && rotationRevision(policy) !== rotationRevision(expectedPolicy)) return null;
    }
    if (db.get("SELECT id FROM providerCreditResetAttempts WHERE connectionId=? AND state IN ('pending','unknown','confirmed')", [connectionId])) return null;
    if (cycle && db.get('SELECT id FROM providerCreditResetAttempts WHERE connectionId=? AND cycle=?', [connectionId, cycle])) return null;
    const id = globalThis.crypto.randomUUID();
    db.run('INSERT INTO providerCreditResetAttempts(id,connectionId,cycle,state,createdAt) VALUES(?,?,?,?,?)', [id, connectionId, cycle, 'pending', Date.now()]);
    return id;
  });
}
export async function finishCreditReset(id, state, code) {
  if (!['confirmed', 'rejected', 'unknown'].includes(state)) throw new TypeError('Invalid reset outcome');
  const db = await getAdapter();
  db.run("UPDATE providerCreditResetAttempts SET state=?,result=? WHERE id=? AND state='pending'", [state, code || null, id]);
}

export async function readCreditResetHolds(connections) {
  const db = await getAdapter(), ids = new Set(connections.map(c => c.id));
  const holds = db.all("SELECT id,connectionId,state,createdAt FROM providerCreditResetAttempts WHERE state IN ('pending','unknown','confirmed')").filter(row => ids.has(row.connectionId));
  const snapshots = holds.some(row => row.state === 'confirmed') ? await readRotationSnapshots(connections) : {};
  return holds.filter(row => {
    const snapshot = snapshots[row.connectionId];
    const quotas = applicableRotationQuotas(snapshot, 'codex', '', Date.now());
    // A later identity-checked provider read can verify a confirmed reset without another text request.
    if (row.state !== 'confirmed' || !(snapshot?.usageReadStartedAt > row.createdAt) || !quotas.some(quota => quota.window === 'session' && quota.remaining > 0) || !quotas.every(quota => Number.isFinite(quota.remaining) && quota.remaining > 0)) return true;
    db.run("UPDATE providerCreditResetAttempts SET state='recovered' WHERE id=? AND state='confirmed'", [row.id]);
    return false;
  });
}
export async function completeCreditResetRecovery(id) {
  const db = await getAdapter();
  db.run("UPDATE providerCreditResetAttempts SET state='recovered' WHERE id=? AND state='confirmed'", [id]);
}
