import { getAdapter } from '../driver.js';
import { configuredQuotaModels } from '../../quotaModelCatalog.js';
import { canonicalTextModel, textModelPermissionReason } from '../../../shared/utils/textModelPermission.mjs';
import { QUOTA_MODEL_ID } from '../../../shared/utils/quotaModelCatalog.mjs';

const failure = (message, status) => Object.assign(new Error(message), { status });
function connectionById(db, id) {
  const row = db.get('SELECT * FROM providerConnections WHERE id=?', [id]);
  if (!row) throw failure('Account not found', 404);
  return { ...JSON.parse(row.data), id: row.id, provider: row.provider, isActive: Boolean(row.isActive) };
}
function readPolicy(db, connection) {
  const row = db.get('SELECT * FROM textModelPolicies WHERE connectionId=?', [connection.id]);
  // A connection reassigned to another provider must be explicitly reviewed.
  if (row && row.provider !== connection.provider) throw failure('Text policy account scope changed', 409);
  return { connectionId: connection.id, provider: connection.provider, capability: 'text_generation', revision: row?.revision || 0, disabledModels: row ? JSON.parse(row.disabledModels) : [] };
}
function catalog(db, provider) {
  const custom = db.all("SELECT value FROM kv WHERE scope='customModels'").map(row => JSON.parse(row.value));
  return configuredQuotaModels([provider], custom).filter(model => model.kind === 'llm');
}
export async function readTextModelPolicy(connectionId) {
  const db = await getAdapter(), connection = connectionById(db, connectionId), policy = readPolicy(db, connection);
  return { ...policy, models: catalog(db, connection.provider).map(model => ({ ...model,
    allowed: !policy.disabledModels.includes(model.id), blockedReason: textModelPermissionReason(connection, model.id, policy),
  })) };
}
export async function readTextModelPolicies(connections) {
  const db = await getAdapter();
  return new Map(connections.map(connection => [connection.id, readPolicy(db, connection)]));
}
export async function commandTextModelPolicy(connectionId, command) {
  if (!command || typeof command!=='object' || Array.isArray(command) || Object.keys(command).some(key=>!['capability','model','allowed','expectedRevision','idempotencyKey'].includes(key)) || command.capability !== 'text_generation' || typeof command.allowed !== 'boolean'
    || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0
    || typeof command.model !== 'string' || !QUOTA_MODEL_ID.test(command.model)
    || typeof command.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(command.idempotencyKey)) throw failure('Invalid text permission command', 400);
  const db = await getAdapter();
  if (!['node:sqlite', 'better-sqlite3', 'bun:sqlite'].includes(db.driver)) throw failure('Text permissions require durable SQLite', 503);
  db.exec('BEGIN IMMEDIATE');
  try {
    const connection = connectionById(db, connectionId), model = canonicalTextModel(connection.provider, command.model);
    const payload = JSON.stringify([connection.provider, command.capability, model, command.allowed, command.expectedRevision]);
    const previous = db.get('SELECT payload,receipt FROM textModelCommands WHERE connectionId=? AND commandKey=?', [connectionId, command.idempotencyKey]);
    if (previous && previous.payload !== payload) throw failure('Command key already used for a different change', 409);
    if (previous) { db.exec('COMMIT'); return { ...JSON.parse(previous.receipt), replayed: true }; }
    const current = readPolicy(db, connection);
    if (current.revision !== command.expectedRevision) throw failure('Text permissions changed elsewhere. Reload before saving.', 409);
    if (!catalog(db, connection.provider).some(entry => entry.id === model)) throw failure('Unsupported text model', 400);
    const disabled = new Set(current.disabledModels);
    if (command.allowed) disabled.delete(model); else disabled.add(model);
    const receipt = { ...current, revision: current.revision + 1, disabledModels: [...disabled].sort(), model, allowed: command.allowed };
    db.run('INSERT INTO textModelPolicies(connectionId,provider,revision,disabledModels) VALUES(?,?,?,?) ON CONFLICT(connectionId) DO UPDATE SET provider=excluded.provider,revision=excluded.revision,disabledModels=excluded.disabledModels', [connectionId, connection.provider, receipt.revision, JSON.stringify(receipt.disabledModels)]);
    db.run('INSERT INTO textModelCommands(connectionId,commandKey,payload,receipt) VALUES(?,?,?,?)', [connectionId, command.idempotencyKey, payload, JSON.stringify(receipt)]);
    db.exec('COMMIT');
    return receipt;
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
