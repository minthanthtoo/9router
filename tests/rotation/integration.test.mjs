import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const root = new URL('../../', import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'rotation-tests-'));
process.env.DATA_DIR = directory;
process.env.AURIX_ISOLATED_BUILD = '1';
process.env.DISABLE_ROTATION_SNAPSHOT_REFRESH = '1';
const sqlite = new DatabaseSync(join(directory, 'test.sqlite'));
let transaction = 0;
const db = {
  driver: 'node:sqlite',
  get: (sql, params = []) => sqlite.prepare(sql).get(...params),
  all: (sql, params = []) => sqlite.prepare(sql).all(...params),
  run: (sql, params = []) => sqlite.prepare(sql).run(...params),
  exec: sql => sqlite.exec(sql),
  transaction: fn => { const id = 't' + ++transaction; sqlite.exec('SAVEPOINT ' + id); try { const value = fn(); sqlite.exec('RELEASE ' + id); return value; } catch (error) { sqlite.exec('ROLLBACK TO ' + id); sqlite.exec('RELEASE ' + id); throw error; } },
};
globalThis._dbAdapter = { instance: db, initPromise: null, logged: true };
let outbound = 0;
globalThis.fetch = async () => { outbound++; throw new Error('Provider network forbidden in integration tests'); };
const { MIGRATIONS } = await import(new URL('src/lib/db/migrations/index.js', root));
for (const migration of MIGRATIONS) migration.up(db);
const engine = await import(new URL('src/shared/utils/rotationSequence.mjs', root));
const repo = await import(new URL('src/lib/db/repos/providerRotationRepo.js', root));
const { updateSettings, getSettings } = await import(new URL('src/lib/db/repos/settingsRepo.js', root));
const { createProviderConnection, getProviderConnectionById, updateProviderConnection } = await import(new URL('src/lib/db/repos/connectionsRepo.js', root));
const { rotationPool } = await import(new URL('src/sse/services/providerRotation.js', root));
const route = await import(new URL('src/app/api/providers/[id]/rotation/route.js', root));
const { getProviderCredentials } = await import(new URL('src/sse/services/auth.js', root));
const params = { params: Promise.resolve({ id: 'codex' }) };
const config = { ...engine.emptyRotation(), enabled: true, sorts: [{ key: 'weekly-remaining', direction: 'asc', division: 'half' }, { key: 'session-remaining', direction: 'desc', division: 'half' }] };
const usage = (left, extra = {}) => ({ quotas: { weekly: { used: 100 - left, total: 100, resetAt: new Date(Date.now() + 86400000).toISOString() }, session: { used: 100 - left, total: 100 } }, ...extra });
const connections = [];
for (let index = 0; index < 4; index++) connections.push(await createProviderConnection({ provider: 'codex', authType: 'access_token', name: 'Fixture ' + index, accessToken: 'synthetic-only-' + index, isActive: true, priority: index + 1 }));
const ordinarySettings = { fallbackStrategy: 'round-robin', providerStrategies: { codex: { stickyRoundRobinLimit: 1 }, claude: { fallbackStrategy: 'fill-first' } }, fixture: 'retain' };
await updateSettings(ordinarySettings);

test('migration is repeatable and introduces only snapshot/cursor tables', () => {
  MIGRATIONS.at(-1).up(db);
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE name IN ('providerRotationSnapshots','providerRotationCursors')").length, 2);
});
test('policy save checks revision and preserves other provider settings', async () => {
  const old = await repo.readRotationPolicy('codex');
  const saved = await repo.saveRotationPolicy('codex', config, old.revision);
  assert.notEqual(saved.revision, old.revision);
  await assert.rejects(repo.saveRotationPolicy('codex', config, old.revision), error => error.status === 409);
  assert.equal((await getSettings()).fixture, 'retain');
  assert.equal((await getSettings()).providerStrategies.claude.fallbackStrategy, 'fill-first');
  assert.equal((await getSettings()).providerStrategies.codex.stickyRoundRobinLimit, 1);
});
test('generic settings writer cannot erase or replace a sequence, including stale maps', async () => {
  await updateSettings({ providerStrategies: { codex: { fallbackStrategy: null, stickyRoundRobinLimit: 1, rotationSequence: { unsafe: true } } } });
  assert.deepEqual((await repo.readRotationPolicy('codex')).policy, config);
  await updateSettings({ providerStrategies: { claude: { fallbackStrategy: 'round-robin' } } });
  assert.deepEqual((await repo.readRotationPolicy('codex')).policy, config);
});
test('snapshots are credential-bound and store normalized evidence, not secrets', async () => {
  for (let index = 0; index < connections.length; index++) await repo.recordRotationUsage(connections[index], usage(10 + index * 20));
  const snapshots = await repo.readRotationSnapshots(connections);
  assert.equal(Object.keys(snapshots).length, 4);
  assert.ok(!db.get('SELECT data FROM providerRotationSnapshots LIMIT 1').data.includes('synthetic-only'));
  assert.equal(Object.keys(await repo.readRotationSnapshots([{ ...connections[0], accessToken: 'changed' }])).length, 0);
});
test('credit details remain separate, expire independently, and redemption invalidation removes old ranking evidence', async () => {
  await repo.recordRotationCredits(connections[0], { availableCount: 1, credits: [{ status: 'available', expiresAt: new Date(Date.now() + 100000).toISOString() }] });
  let snapshots = await repo.readRotationSnapshots(connections);
  assert.equal(snapshots[connections[0].id].credits.availableCount, 1);
  await repo.invalidateRotationSnapshot(connections[0].id);
  assert.equal((await repo.readRotationSnapshots(connections))[connections[0].id], undefined);
  await repo.recordRotationUsage(connections[0], usage(10), Date.now() + 1);
});
test('concurrent picks rotate inside selected segment; preview never advances cursor', async () => {
  const snapshots = await repo.readRotationSnapshots(connections);
  const pool = rotationPool(connections, snapshots, config, { provider: 'codex', model: 'gpt-6.1' });
  assert.equal(pool.candidates.length, 2);
  const options = { provider: 'codex', model: 'fixture-rotation', policy: config, stickyRequests: 2 };
  const peek = await repo.chooseSequenceConnection(pool.candidates, { ...options, peekOnly: true });
  assert.equal(db.all('SELECT * FROM providerRotationCursors').length, 0);
  const picks = await Promise.all(Array.from({ length: 4 }, () => repo.chooseSequenceConnection(pool.candidates, options)));
  assert.equal(picks[0].id, peek.id); assert.equal(picks[0].id, picks[1].id); assert.equal(picks[2].id, picks[3].id); assert.notEqual(picks[0].id, picks[2].id);
});
test('preview and actual routing select the same account; peek is side-effect free', async () => {
  const previewResponse = await route.POST(new Request('http://localhost/api/providers/codex/rotation', { method: 'POST', body: JSON.stringify({ action: 'preview', policy: config, model: 'gpt-6.1' }) }), params);
  assert.equal(previewResponse.status, 200);
  const { preview } = await previewResponse.json();
  assert.ok(preview.validUntil > preview.observedAt);
  assert.equal(preview.groups.reduce((n,g)=>n+g.count,0), preview.eligible);
  assert.equal(preview.selectedCount, preview.groups[0].count);
  assert.ok(preview.quality && preview.creditSummary);
  assert.deepEqual(preview.stages.at(-1).groups.flatMap(group=>group.ids),preview.rows.map(row=>row.id));
  assert.ok(preview.rows.every(row=>row.scope&&row.measurements&&row.constraints));
  const before = db.all('SELECT * FROM providerRotationCursors');
  const peek = await getProviderCredentials('codex', null, 'gpt-6.1', { peekOnly: true, capability: 'chat' });
  assert.equal(peek.connectionId, preview.nextId); assert.deepEqual(db.all('SELECT * FROM providerRotationCursors'), before);
  const actual = await getProviderCredentials('codex', null, 'gpt-6.1', { capability: 'chat' });
  assert.equal(actual.connectionId, preview.nextId);
  assert.equal(outbound, 0);
});
test('disabled, model-locked, model-disabled and exhausted accounts remain ineligible', async () => {
  const snapshots = await repo.readRotationSnapshots(connections), now = Date.now();
  const rows = [
    { ...connections[0], isActive: false },
    { ...connections[1], 'modelLock_gpt-6.1': new Date(now + 999999).toISOString() },
    { ...connections[2], providerSpecificData: { enabledModels: ['other-model'] } },
    connections[3],
  ];
  snapshots[connections[3].id].quotas[0].remaining = 0;
  const pool = rotationPool(rows, snapshots, config, { provider: 'codex', model: 'gpt-6.1', now });
  assert.equal(pool.ranked.length, 0); assert.deepEqual(pool.blocked.map(row => row.reason), ['Turned off', 'Cooling down', 'Model disabled', 'Quota exhausted']);
});
test('quota read failure leaves old timestamps unchanged and stale snapshots lose authority', async () => {
  const snapshots = await repo.readRotationSnapshots(connections);
  const before = snapshots[connections[0].id].observedAt;
  await repo.recordRotationUsage(connections[0], { message: 'Unavailable' });
  assert.equal((await repo.readRotationSnapshots(connections))[connections[0].id].observedAt, before);
  for (const data of Object.values(snapshots)) data.observedAt -= engine.SNAPSHOT_MAX_AGE_MS + 1;
  assert.equal(rotationPool(connections, snapshots, config, { provider: 'codex', model: 'gpt-6.1' }).hasEvidence, false);
});
test('API rejects unsupported controls and stale revision without provider calls', async () => {
  const invalid = await route.POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ action: 'preview', policy: { ...config, sorts: [{ key: 'monthly-reset', direction: 'asc', division: 'half' }] } }) }), params);
  assert.equal(invalid.status, 400);
  const conflict = await route.PATCH(new Request('http://localhost', { method: 'PATCH', body: JSON.stringify({ policy: config, revision: 'wrong' }) }), params);
  assert.equal(conflict.status, 409); assert.equal(outbound, 0);
});
test('global card preview sorts before pagination and puts expiring credits on page one', async () => {
  const clientRoute = await import(new URL('src/app/api/providers/client/route.js', root));
  await repo.recordRotationCredits(connections[3], { availableCount: 1, credits: [{ status: 'available', expiresAt: new Date(Date.now() + 86400000).toISOString() }] });
  const withPriority = { ...config, resetPriority: { enabled: true, days: 3, weeklyBelow: null } };
  const url = new URL('http://localhost/api/providers/client');
  url.searchParams.set('provider', 'codex'); url.searchParams.set('includeImageAccounts', 'true'); url.searchParams.set('pageSize', '2');
  url.searchParams.set('rotationModel', 'gpt-6.1'); url.searchParams.set('rotationPolicy', JSON.stringify(withPriority));
  const first = await (await clientRoute.GET(new Request(url))).json();
  url.searchParams.set('page', '2'); const second = await (await clientRoute.GET(new Request(url))).json();
  assert.equal(first.connections[0].id, connections[3].id); assert.ok(first.connections[0].rotationHint.expiresAt);
  assert.equal(new Set([...first.connections, ...second.connections].map(row => row.id)).size, 4);
  assert.equal(first.pagination.totalPages, 2); assert.equal(outbound, 0);
});
test('all-provider reset priority promotes matching Codex accounts before pagination without publishing', async () => {
  const client = await import(new URL('src/app/api/providers/client/route.js', root));
  const other = await createProviderConnection({provider:'claude',authType:'oauth',name:'Other provider',accessToken:'fixture',isActive:true,priority:0});
  const saved = await repo.readRotationPolicy('codex');
  const priority = {enabled:true,days:3,weeklyBelow:75};
  const url = new URL('http://localhost/api/providers/client?includeImageAccounts=true&pageSize=2');
  url.searchParams.set('resetPriority',JSON.stringify(priority));
  try {
    const first = await (await client.GET(new Request(url))).json();
    assert.equal(first.connections[0].id,connections[3].id);
    assert.ok(first.connections[0].rotationHint.expiresAt);
    assert.equal(first.resetPrioritySummary.matching,1);
    assert.equal(first.resetPrioritySummary.live,false);
    assert.ok(first.resetPrioritySummary.nextExpiry > Date.now());
    url.searchParams.set('page','2');
    const second = await (await client.GET(new Request(url))).json();
    assert.equal(new Set([...first.connections,...second.connections].map(row=>row.id)).size,4);
    assert.deepEqual((await repo.readRotationPolicy('codex')).policy,saved.policy);
    url.searchParams.set('page','1');
    url.searchParams.set('resetPriority',JSON.stringify({...priority,weeklyBelow:10}));
    const below = await (await client.GET(new Request(url))).json();
    assert.equal(below.resetPrioritySummary.matching,0);
    assert.ok(below.connections.every(row=>!row.rotationHint));
    const current = await repo.readRotationPolicy('codex');
    const applied = await repo.saveRotationPolicy('codex',{...saved.policy,enabled:true,resetPriority:priority},current.revision);
    url.searchParams.set('resetPriority',JSON.stringify(priority));
    const live = await (await client.GET(new Request(url))).json();
    assert.equal(live.resetPrioritySummary.live,true);
    await repo.saveRotationPolicy('codex',saved.policy,applied.revision);
    url.searchParams.set('resetPriority',JSON.stringify({...priority,days:0}));
    assert.equal((await client.GET(new Request(url))).status,400);
    assert.equal(outbound,0);
  } finally { db.run('DELETE FROM providerConnections WHERE id=?',[other.id]); }
});
test('changed credentials cannot overwrite a newer account snapshot', async () => {
  const changed = await updateProviderConnection(connections[0].id, { accessToken: 'replacement-fixture' });
  await repo.recordRotationUsage(changed, usage(80));
  await repo.recordRotationUsage(connections[0], usage(0));
  const snapshots = await repo.readRotationSnapshots([changed]);
  assert.equal(snapshots[changed.id].quotas[0].remaining, 80);
});
test('reset fencing rejects reads begun before or during an explicit reset', async () => {
  const connection = await getProviderConnectionById(connections[0].id);
  const started = Date.now() - 100;
  await repo.invalidateRotationSnapshot(connection.id, true);
  await repo.recordRotationUsage(connection, usage(0), Date.now() + 1);
  assert.equal((await repo.readRotationSnapshots([connection]))[connection.id], undefined);
  await repo.invalidateRotationSnapshot(connection.id);
  await repo.recordRotationUsage(connection, usage(0), started);
  assert.equal((await repo.readRotationSnapshots([connection]))[connection.id], undefined);
  await repo.recordRotationUsage(connection, usage(80), Date.now() + 1);
  assert.equal((await repo.readRotationSnapshots([connection]))[connection.id].quotas[0].remaining, 80);
});
test('upgrading the version-16 schema preserves every pre-existing table and fixture row', async () => {
  const sqlite2 = new DatabaseSync(':memory:');
  const upgrade = { exec: sql => sqlite2.exec(sql), run: (sql, args=[]) => sqlite2.prepare(sql).run(...args), get: (sql, args=[]) => sqlite2.prepare(sql).get(...args), all: (sql, args=[]) => sqlite2.prepare(sql).all(...args) };
  for (const migration of MIGRATIONS.filter(migration => migration.version <= 16)) migration.up(upgrade);
  // Initial bootstrap uses today's schema; remove only the new empty tables to model v16.
  upgrade.exec('DROP TABLE providerRotationSnapshots; DROP TABLE providerRotationCursors');
  upgrade.run('INSERT INTO settings(id,data) VALUES(1,?)', [JSON.stringify({fixture:'preserve',providerStrategies:{codex:{fallbackStrategy:'round-robin'}}})]);
  const names = upgrade.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row => row.name);
  const before = Object.fromEntries(names.map(name => [name, upgrade.all('SELECT * FROM "'+name+'"')]));
  for (const migration of MIGRATIONS.filter(migration => migration.version > 16)) migration.up(upgrade);
  assert.deepEqual(Object.fromEntries(names.map(name => [name, upgrade.all('SELECT * FROM "'+name+'"')])), before);
  assert.equal(upgrade.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length, names.length + 4);
  sqlite2.close();
});

test('image model rotation stays inside account-ranked group and exclusions promote the next group', async()=>{
 const live=await repo.readRotationPolicy('codex');
 const policy={...engine.emptyRotation(),enabled:true,sorts:[{key:'weekly-remaining',direction:'desc',division:'half'},{key:'session-remaining',direction:'desc',division:'half'}]};
 await repo.saveRotationPolicy('codex',policy,live.revision);
 await updateSettings({aurixImageRouting:{version:1,rules:[{provider:'codex',operation:'generate',model:'gpt-image-1',strategy:'round-robin',stickyRequests:1}]}});
 const active=[];
 for(let i=0;i<connections.length;i++){
  const c=await getProviderConnectionById(connections[i].id);await updateProviderConnection(c.id,{isActive:true,providerSpecificData:{...c.providerSpecificData,enabledModels:[]}});
  const current=await getProviderConnectionById(c.id);await repo.recordRotationUsage(current,{quotas:{image_gen_primary:{used:i*20,total:100,quotaKind:'image_generation',limitId:'image_gen',windowSeconds:18000},image_gen_secondary:{used:i*20,total:100,quotaKind:'image_generation',limitId:'image_gen',windowSeconds:604800}}},Date.now()+1000);active.push(current);
 }
 const opts={peekOnly:true,capability:'image_generation',imageOperation:'generate',requestedModel:'gpt-image-1'};
 const snapshots=await repo.readRotationSnapshots(active),pool=rotationPool(active,snapshots,policy,{provider:'codex',model:'gpt-image-1'});
 const chosen=await getProviderCredentials('codex',null,'gpt-image-1',opts);assert.ok(pool.candidates.some(c=>c.id===chosen.connectionId));assert.equal(pool.candidates.length,2);
 const next=await getProviderCredentials('codex',new Set(pool.candidates.map(c=>c.id)),'gpt-image-1',opts);assert.ok(next);assert.equal(pool.candidates.some(c=>c.id===next.connectionId),false);
 const held=new Map([[active[0].id,{manualPolicy:{policyState:'paused'}}]]);assert.equal(rotationPool(active,snapshots,policy,{provider:'codex',model:'gpt-image-1',imageStates:held}).blocked.some(row=>row.connection.id===active[0].id),true);
 assert.equal(db.get('SELECT COUNT(*) AS n FROM aurixImageRoutingCursors').n,0);
});
test('provider image settings inherit method and sticky count while preview and routing agree', async () => {
 const previous=await getSettings(),override=previous.providerStrategies.codex;
 const model='gpt-image-2.5';
 const rule={provider:'codex',operation:'generate',model,strategy:'provider',stickyRequests:1,accountPreference:{mode:'text'}};
 const {policy}=await repo.readRotationPolicy('codex');
 try {
  for(const [strategy,stickyRequests] of [['fill-first',1],['round-robin',2]]) {
   await updateSettings({aurixImageRouting:{version:1,rules:[rule]},providerStrategies:{codex:{fallbackStrategy:strategy,stickyRoundRobinLimit:2}}});
   const response=await route.POST(new Request('http://localhost',{method:'POST',body:JSON.stringify({action:'preview',policy,model})}),params);
   assert.equal(response.status,200);
   const {preview}=await response.json();
   assert.equal(preview.strategy,strategy);assert.equal(preview.stickyRequests,stickyRequests);assert.deepEqual(preview.sorts,policy.sorts);
   const actual=await getProviderCredentials('codex',null,model,{peekOnly:true,capability:'image_generation',imageOperation:'generate',requestedModel:model});
   assert.equal(actual.connectionId,preview.nextId,strategy);
  }
  assert.equal((await getSettings()).aurixImageRouting.rules[0].strategy,'provider');
 } finally {
  await updateSettings({aurixImageRouting:previous.aurixImageRouting,providerStrategies:{codex:{fallbackStrategy:override.fallbackStrategy,stickyRoundRobinLimit:override.stickyRoundRobinLimit}}});
 }
});
test('waiting preview and routing agree without advancing cursors, including empty fallback and pinned zero', async () => {
  const active = await Promise.all(connections.map(connection => getProviderConnectionById(connection.id)));
  const saved = await repo.readRotationPolicy('codex');
  const policy = { ...config, sorts: [{ key: 'weekly-reset', direction: 'asc', division: 'half' }, { key: 'session-remaining', direction: 'desc', division: 'half' }] };
  await repo.saveRotationPolicy('codex', policy, saved.revision);
  const write = async allWaiting => {
    for (let index = 0; index < active.length; index++) await repo.recordRotationUsage(active[index], { quotas: { session: { total: 100, used: allWaiting || index === 0 ? 100 : 10 * index } } }, Date.now() + 1000);
  };
  const preview = async p => (await (await route.POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ action: 'preview', policy: p, model: 'gpt-6.1' }) }), params)).json()).preview;
  await write(false);
  const before = db.all('SELECT * FROM providerRotationCursors'), imageBefore = db.all('SELECT * FROM aurixImageRoutingCursors');
  const mixed = await preview(policy);
  assert.equal(mixed.waitingCount, 1); assert.equal(mixed.eligible, 3);
  assert.equal(mixed.rows.at(-1).id, active[0].id); assert.equal(mixed.rows.at(-1).waiting, true);
  assert.equal(mixed.rows.at(-1).reason, 'Short window exhausted');
  const peek = await getProviderCredentials('codex', null, 'gpt-6.1', { capability: 'chat', peekOnly: true });
  assert.equal(peek.connectionId, mixed.nextId);
  const pinned = await getProviderCredentials('codex', null, 'gpt-6.1', { capability: 'chat', peekOnly: true, preferredConnectionId: active[0].id });
  assert.equal(pinned.connectionId, mixed.nextId);
  const clientRoute = await import(new URL('src/app/api/providers/client/route.js', root));
  const url = new URL('http://localhost/api/providers/client');
  for (const [key,value] of Object.entries({provider:'codex',includeImageAccounts:'true',rotationModel:'gpt-6.1',rotationPolicy:JSON.stringify(policy)})) url.searchParams.set(key,value);
  const cards = await (await clientRoute.GET(new Request(url))).json();
  assert.ok(cards.rotationSegments.flatMap(segment=>segment.unavailableIds).includes(active[0].id));
  assert.equal(cards.connections.length, active.length);
  await write(true);
  // No sort evidence is also the legacy fallback path; zero must not re-enter it.
  const unknown = { ...policy, sorts: policy.sorts.slice(0, 1) };
  await repo.saveRotationPolicy('codex', unknown, (await repo.readRotationPolicy('codex')).revision);
  const empty = await preview(unknown);
  assert.equal(empty.waitingCount, 4); assert.equal(empty.nextId, null); assert.equal(empty.selectedCount, 0);
  assert.equal(await getProviderCredentials('codex', null, 'gpt-6.1', { capability: 'chat', peekOnly: true }), null);
  assert.equal(await getProviderCredentials('codex', null, 'gpt-6.1', { capability: 'chat' }), null);
  assert.deepEqual(db.all('SELECT * FROM providerRotationCursors'), before);
  assert.deepEqual(db.all('SELECT * FROM aurixImageRoutingCursors'), imageBefore);
  // Image admission rejects exhausted subscription windows before ranking and leaves cursors untouched.
  for (const connection of active) await repo.recordRotationUsage(connection, { quotas: { image_gen_primary: { total: 100, used: 100, quotaKind: 'image_generation', limitId: 'image_gen', windowSeconds: 18000 } } }, Date.now() + 1000);
  const imagePreview = (await (await route.POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ action: 'preview', policy: unknown, model: 'gpt-image-2.5' }) }), params)).json()).preview;
  assert.equal(imagePreview.blocked.length, 4); assert.equal(imagePreview.admission[1].ready, 0); assert.equal(imagePreview.nextId, null);
  assert.equal(await getProviderCredentials('codex', null, 'gpt-image-2.5', { capability: 'image_generation', imageOperation: 'generate', requestedModel: 'gpt-image-2.5' }), null);
  assert.deepEqual(db.all('SELECT * FROM aurixImageRoutingCursors'), imageBefore);
  assert.equal(outbound, 0);
});
test('custom image account sequence remains independent of text and none preserves quota admission', async()=>{
 const {readImageRouting,saveImageRouting}=await import(new URL('src/lib/db/repos/imageRoutingRepo.js',root));
 const active=await Promise.all(connections.map(connection=>getProviderConnectionById(connection.id)));
 const imageSequence={...engine.emptyRotation(),enabled:true,sorts:[{key:'session-remaining',direction:'asc',division:'half'},{key:'weekly-remaining',direction:'asc',division:'half'}]};
 const imageRule={operation:'generate',provider:'codex',model:'*',strategy:'fill-first',stickyRequests:1,accountPreference:{mode:'custom',sequence:imageSequence},tryNextOnQuota:false};
 const old=await readImageRouting(); await saveImageRouting({version:1,rules:[imageRule]},old.revision);
 await assert.rejects(saveImageRouting({version:1,rules:[]},old.revision),error=>error.status===409);
 for(let i=0;i<active.length;i++)await repo.recordRotationUsage(active[i],{quotas:{image_gen_primary:{used:20+i*20,total:100,quotaKind:'image_generation',limitId:'image_gen',windowSeconds:18000},image_gen_secondary:{used:10,total:100,quotaKind:'image_generation',limitId:'image_gen',windowSeconds:604800}}},Date.now()+1000);
 const choose=()=>getProviderCredentials('codex',null,'gpt-image-2.5',{capability:'image_generation',imageOperation:'generate',requestedModel:'gpt-image-2.5',peekOnly:true});
 const first=await choose();assert.equal(first.connectionId,active.at(-1).id);
 const live=await repo.readRotationPolicy('codex');await repo.saveRotationPolicy('codex',{...config,sorts:[{key:'session-remaining',direction:'desc',division:'half'}]},live.revision);
 assert.equal((await choose()).connectionId,first.connectionId);
 const response=await route.POST(new Request('http://localhost',{method:'POST',body:JSON.stringify({action:'preview',policy:config,model:'gpt-image-2.5'})}),params);
 assert.equal((await response.json()).preview.nextId,first.connectionId);
 const draftRule={...imageRule,accountPreference:{mode:'custom',sequence:{...imageSequence,sorts:[{key:'session-remaining',direction:'desc',division:'half'}]}}};
 const beforeDraft=await readImageRouting(),beforeCursors=db.all('SELECT * FROM aurixImageRoutingCursors');
 const draftResponse=await route.POST(new Request('http://localhost',{method:'POST',body:JSON.stringify({action:'preview',policy:config,model:'gpt-image-2.5',imageRule:draftRule})}),params);
 assert.equal(draftResponse.status,200);assert.equal((await draftResponse.json()).preview.nextId,active[0].id);
 assert.deepEqual(await readImageRouting(),beforeDraft);assert.deepEqual(db.all('SELECT * FROM aurixImageRoutingCursors'),beforeCursors);
 const wrongScope=await route.POST(new Request('http://localhost',{method:'POST',body:JSON.stringify({action:'preview',policy:config,model:'gpt-6.1',imageRule:draftRule})}),params);
 assert.equal(wrongScope.status,400);
 const current=await readImageRouting();assert.equal(current.config.rules[0].tryNextOnQuota,false);
 await saveImageRouting({version:1,rules:[{...imageRule,accountPreference:{mode:'none'}}]},current.revision);
 for(const connection of active)await repo.recordRotationUsage(connection,{quotas:{image_gen_primary:{used:100,total:100,quotaKind:'image_generation',limitId:'image_gen',windowSeconds:18000}}},Date.now()+1000);
 const cursors=db.all('SELECT * FROM aurixImageRoutingCursors');assert.equal(await choose(),null);assert.deepEqual(db.all('SELECT * FROM aurixImageRoutingCursors'),cursors);
 const summary=await (await route.GET(new Request('http://localhost?summary=1&model=gpt-image-2.5'),params)).json();assert.equal(summary.sequenceScope,'image');assert.equal(summary.effectivePolicy.enabled,false);assert.equal(summary.policy.enabled,true);
 const clientRoute=await import(new URL('src/app/api/providers/client/route.js',root));
 const cardURL=new URL('http://localhost/api/providers/client');
 for(const [key,value]of Object.entries({provider:'codex',includeImageAccounts:'true',rotationModel:'gpt-image-2.5',rotationPolicy:JSON.stringify(config)}))cardURL.searchParams.set(key,value);
 const cardResult=await clientRoute.GET(new Request(cardURL));assert.equal(cardResult.status,200);const cardData=await cardResult.json();
 assert.equal(cardData.rotationSegments.flatMap(segment=>segment.unavailableIds).length,4,JSON.stringify(cardData.rotationSegments));
 assert.deepEqual(db.all('SELECT * FROM aurixImageRoutingCursors'),cursors);

 const {rotationAutomationStatus}=await import(new URL('src/shared/services/rotationSnapshotRefresh.js',root));
 const status=rotationAutomationStatus(await getSettings());assert.equal(status.scope,'process');assert.equal(status.quotaReads.running,false);assert.equal(status.imageRecovery.scheduled,false);assert.equal(status.imageRecovery.mode,'manual');assert.equal(outbound,0);
 const {recordImageQuotaObservations}=await import(new URL('src/lib/db/repos/imageQuotaRepo.js',root));
 await recordImageQuotaObservations(active[0],[{capability:'image_generation',quotaGroupId:'codex.image_generation',constraintId:'image_gen',observedModel:'gpt-image-2.5',appliesToModels:['gpt-image-2.5'],retryAt:new Date(Date.now()-1000).toISOString(),confidence:'provider_confirmed',source:'provider_retry_after'}],'synthetic-expired-hold');
 const leases=db.all('SELECT * FROM imageQuotaProbeLeases'),requestState={};
 const recovery=await getProviderCredentials('codex',null,'gpt-image-2.5',{capability:'image_generation',imageOperation:'generate',requestedModel:'gpt-image-2.5',quotaRequestId:'synthetic-subscription-zero',requestState});
 assert.equal(recovery,null);assert.equal(requestState.recoveryProbeClaimed,undefined);assert.deepEqual(db.all('SELECT * FROM imageQuotaProbeLeases'),leases);

});

test('account pause and restore preserve child model choices and idempotent receipts',async()=>{
 const {writeImageQuotaPolicy}=await import(new URL('src/lib/db/repos/imageQuotaRepo.js',root));
 const connection=await getProviderConnectionById(connections[0].id),group='codex.image_generation';
 const base={connection,capability:'image_generation',principal:'fixture-operator',reason:'Synthetic control regression'};
 const child={...base,quotaGroupId:group+':model:gpt-image-2.5',action:'pause',expectedRevision:0,idempotencyKey:'child-fixture',requestHash:'child-fixture'};
 await writeImageQuotaPolicy(child);
 const before=db.all('SELECT * FROM imageQuotaPolicies WHERE quotaGroupId=?',[child.quotaGroupId]);
 assert.equal(before.length,1);assert.equal(before[0].policyState,'paused');
 await writeImageQuotaPolicy({...base,quotaGroupId:group,action:'pause',expectedRevision:0,idempotencyKey:'account-pause',requestHash:'account-pause'});
 await writeImageQuotaPolicy({...base,quotaGroupId:group,action:'resume',expectedRevision:1,idempotencyKey:'account-resume',requestHash:'account-resume'});
 assert.deepEqual(db.all('SELECT * FROM imageQuotaPolicies WHERE quotaGroupId=?',[child.quotaGroupId]),before);
 assert.equal((await writeImageQuotaPolicy(child)).replayed,true);assert.equal(outbound,0);
});

test('image preview supports providers without subscription sorting and still rejects text models',async()=>{
 const params={params:Promise.resolve({id:'gemini'})};
 const imageRule={operation:'generate',provider:'gemini',model:'*',strategy:'round-robin',stickyRequests:1,accountPreference:{mode:'none'}};
 const request=model=>new Request('http://localhost',{method:'POST',body:JSON.stringify({action:'preview',policy:engine.emptyRotation(),model,imageRule})});
 const image=await route.POST(request('gemini-3.1-flash-image'),params);
 assert.equal(image.status,200);assert.deepEqual((await image.json()).preview.metrics,[]);
 assert.equal((await route.POST(request('gemini-text-invalid'),params)).status,400);
 assert.equal((await route.GET(new Request('http://localhost?summary=1'),params)).status,400);
 assert.equal(outbound,0);
});

test('text permission is durable, idempotent and enforced in normal, preferred and preview selection',async()=>{
 const {readTextModelPolicy,commandTextModelPolicy}=await import(new URL('src/lib/db/repos/textModelPolicyRepo.js',root));
 const model='gpt-6.1-sol';
 const settings=await repo.readRotationPolicy('codex');await repo.saveRotationPolicy('codex',engine.emptyRotation(),settings.revision);
 for(const connection of connections){
  const initial=await readTextModelPolicy(connection.id);assert.equal(initial.revision,0);
  const command={capability:'text_generation',model,allowed:false,expectedRevision:0,idempotencyKey:'pause-'+connection.id};
  const result=await commandTextModelPolicy(connection.id,command);assert.equal(result.revision,1);
  assert.equal((await commandTextModelPolicy(connection.id,command)).replayed,true);
  await assert.rejects(commandTextModelPolicy(connection.id,{...command,allowed:true}),error=>error.status===409);
  await assert.rejects(commandTextModelPolicy(connection.id,{...command,idempotencyKey:'stale-'+connection.id}),error=>error.status===409);
 }
 assert.equal(await getProviderCredentials('codex',null,model,{capability:'chat',requestedModel:model,peekOnly:true}),null);
 const preview=await route.POST(new Request('http://localhost',{method:'POST',body:JSON.stringify({action:'preview',policy:engine.emptyRotation(),model})}),params);
 const blocked=(await preview.json()).preview;assert.equal(blocked.nextId,null);assert.equal(blocked.blocked.length,connections.length);
 const restored=await commandTextModelPolicy(connections[0].id,{capability:'text_generation',model,allowed:true,expectedRevision:1,idempotencyKey:'restore-one'});
 assert.equal(restored.revision,2);
 const selected=await getProviderCredentials('codex',null,model,{capability:'chat',requestedModel:model,peekOnly:true,preferredConnectionId:connections[1].id});assert.equal(selected.connectionId,connections[0].id);
 const unsupported={capability:'text_generation',model:'not-a-real-model',allowed:false,expectedRevision:2,idempotencyKey:'bad-model'};
 await assert.rejects(commandTextModelPolicy(connections[0].id,unsupported),error=>error.status===400);
 const client=await import(new URL('src/app/api/providers/client/route.js',root));
 const result=await (await client.GET(new Request('http://localhost?provider=codex&includeCatalog=true&category=image&includeImageAccounts=true'))).json();
 assert.ok(result.connections.every(row=>row.displayModels.some(item=>item.kind==='llm')));
 assert.ok(result.connections.some(row=>row.displayModels.some(item=>item.id===model)));
 assert.equal(outbound,0);
});

test('registry model kinds survive conflicting custom entries across cards, filters and image rotation', async()=>{
 const {addCustomModel}=await import(new URL('src/lib/db/repos/aliasRepo.js',root));
 const {getImageQuotaModelCatalog}=await import(new URL('src/lib/db/repos/imageQuotaInsights.js',root));
 const {readTextModelPolicy}=await import(new URL('src/lib/db/repos/textModelPolicyRepo.js',root));
 const client=await import(new URL('src/app/api/providers/client/route.js',root));
 const image='gemini-3.1-flash-image',customImage='studio/custom-image';
 await addCustomModel({providerAlias:'ag',id:image,type:'llm'});
 await addCustomModel({providerAlias:'ag',id:customImage,type:'image'});
 const accounts=[];
 for(let i=0;i<2;i++){
  const c=await createProviderConnection({provider:'antigravity',authType:'oauth',name:'Image catalog fixture '+i,isActive:true,accessToken:'fixture',providerSpecificData:{projectId:'fixture-project'}});
  accounts.push(c);await repo.recordRotationUsage(c,{quotas:{gemini_session:{remainingPercentage:80-i*20},gemini_weekly:{remainingPercentage:90-i*20}}});
 }
 const url=new URL('http://localhost/api/providers/client?provider=antigravity&includeCatalog=true&includeImageAccounts=true&category=image');
 const cards=await (await client.GET(new Request(url))).json();
 assert.equal(cards.connections.length,2);
 assert.ok(cards.connections.every(c=>c.displayModels.some(m=>m.id===image&&m.kind==='image')));
 assert.ok(cards.modelCatalog.some(m=>m.id===image&&m.kind==='image'&&m.accountCount===2));
 assert.ok(cards.modelCatalog.some(m=>m.id===customImage&&m.kind==='image'&&m.accountCount===2));
 const text=await readTextModelPolicy(accounts[0].id);assert.ok(!text.models.some(m=>m.id===image||m.id===customImage));
 const images=await getImageQuotaModelCatalog();assert.ok(images.some(m=>m.provider==='antigravity'&&m.id===customImage));
 url.searchParams.set('model',image);url.searchParams.set('rotationModel',image);url.searchParams.set('rotationPolicy',JSON.stringify({...engine.emptyRotation(),enabled:true,sorts:[{key:'weekly-remaining',direction:'asc',division:'half'}]}));
 const sorted=await(await client.GET(new Request(url))).json();assert.equal(sorted.connections[0].id,accounts[1].id);
 assert.ok(sorted.rotationSegments.flatMap(s=>s.ids).includes(accounts[0].id));
 const summary=await route.GET(new Request('http://localhost?summary=1&model='+encodeURIComponent(customImage)),{params:Promise.resolve({id:'antigravity'})});
 const body=await summary.json();assert.equal(summary.status,200);assert.equal(body.sequenceScope,'image');
 assert.equal(outbound,0);
});

test('image admission explains subscription first, then model holds, without borrowing unrelated text quota', () => {
 const now=Date.now(),model='gpt-image-2';
 const rows=['off','subscription','held','ready'].map(id=>({id,provider:'codex',isActive:id!=='off'}));
 const snapshots=Object.fromEntries(rows.map(c=>[c.id,engine.normalizeRotationUsage('codex',{quotas:{
  session:{used:100,total:100},
  image_gen_primary:{used:c.id==='subscription'?100:20,total:100,quotaKind:'image_generation',limitId:'image_gen',windowSeconds:18000},
 }},now)]));
 const imageStates=new Map(rows.map(c=>[c.id,{blockingRows:c.id==='subscription'||c.id==='held'?[{retryAt:new Date(now+60000).toISOString()}]:[]}]));
 const pool=rotationPool(rows,snapshots,config,{provider:'codex',model,now,imageStates,quotaAdmission:true});
 assert.deepEqual(pool.admission.map(step=>[step.id,step.ready]),[['account',3],['subscription',2],['model',1]]);
 assert.equal(pool.blocked.find(row=>row.connection.id==='subscription').gate,'subscription');
 assert.equal(pool.blocked.find(row=>row.connection.id==='held').gate,'model');
 assert.deepEqual(pool.ranked.map(row=>row.connection.id),['ready']);
 snapshots.ready.quotas.filter(quota=>quota.scope==='codex:image').forEach(quota=>{quota.remaining=null;});
 assert.equal(rotationPool(rows,snapshots,config,{provider:'codex',model,now,imageStates,quotaAdmission:true}).admission[1].unreported,1);
});

test('inherited image rotation has separate Generate/Edit cursors even without an image override', async () => {
 const previous=await getSettings(),saved=await repo.readRotationPolicy('codex'),model='gpt-image-2';
 try {
  await repo.saveRotationPolicy('codex',engine.emptyRotation(),saved.revision);
  await updateSettings({aurixImageRouting:{version:1,rules:[]},providerStrategies:{codex:{fallbackStrategy:'round-robin',stickyRoundRobinLimit:1}}});
  const before=await Promise.all(connections.map(c=>getProviderConnectionById(c.id)));
  for(const c of before)await repo.recordRotationUsage(c,{quotas:{image_gen_primary:{used:20,total:100,quotaKind:'image_generation',limitId:'image_gen',windowSeconds:18000}}});
  const options={capability:'image_generation',imageOperation:'edit',requestedModel:model};
  const first=await getProviderCredentials('codex',null,model,options);
  const response=await route.POST(new Request('http://localhost',{method:'POST',body:JSON.stringify({action:'preview',policy:engine.emptyRotation(),model,imageRule:{operation:'edit',provider:'codex',model:'*',strategy:'provider',stickyRequests:1}})}),params);
  const {preview}=await response.json();
  const second=await getProviderCredentials('codex',null,model,options);
  assert.notEqual(first.connectionId,second.connectionId);assert.equal(second.connectionId,preview.nextId);
  const edit=db.get('SELECT * FROM aurixImageRoutingCursors WHERE scope=?',[JSON.stringify(['edit','codex',model])]);
  assert.ok(edit);assert.equal(edit.connectionId,second.connectionId);
  const generated=await getProviderCredentials('codex',null,model,{...options,imageOperation:'generate'});
  assert.ok(generated);assert.deepEqual(db.get('SELECT * FROM aurixImageRoutingCursors WHERE scope=?',[JSON.stringify(['edit','codex',model])]),edit);
  const after=await Promise.all(connections.map(c=>getProviderConnectionById(c.id)));
  assert.deepEqual(after.map(c=>[c.lastUsedAt,c.consecutiveUseCount]),before.map(c=>[c.lastUsedAt,c.consecutiveUseCount]));
 } finally {
  await repo.saveRotationPolicy('codex',saved.policy,(await repo.readRotationPolicy('codex')).revision);
  await updateSettings({aurixImageRouting:previous.aurixImageRouting,providerStrategies:{codex:{fallbackStrategy:previous.providerStrategies?.codex?.fallbackStrategy,stickyRoundRobinLimit:previous.providerStrategies?.codex?.stickyRoundRobinLimit}}});
 }
});

test.after(() => { sqlite.close(); rmSync(directory, { recursive: true, force: true }); });

test('late usage and credit replies cannot replace newer independently observed evidence',async()=>{
 const c=await createProviderConnection({provider:'codex',authType:'access_token',name:'Evidence ordering',accessToken:'synthetic-ordering',isActive:true});
 const base=Date.now()-1000,old=base+100,newer=base+200;
 await repo.recordRotationUsage(c,usage(0),newer);
 await repo.recordRotationUsage(c,usage(90),old);
 let s=(await repo.readRotationSnapshots([c]))[c.id];assert.equal(s.quotas.find(q=>q.window==='session').remaining,0);
 const credit=count=>({availableCount:count,credits:[{status:'available',expiresAt:new Date(Date.now()+86400000).toISOString()}]});
 await repo.recordRotationCredits(c,credit(0),base+400);
 await repo.recordRotationCredits(c,credit(2),base+300);
 s=(await repo.readRotationSnapshots([c]))[c.id];assert.equal(s.credits.availableCount,0);
 await repo.recordRotationCredits(c,credit(1),base+600);
 await repo.recordRotationUsage(c,{...usage(20),resetCredits:{availableCount:0}},base+500);
 s=(await repo.readRotationSnapshots([c]))[c.id];assert.equal(s.credits.availableCount,1);assert.equal(s.observedAt,base+500);
 await repo.recordRotationUsage(c,{...usage(0),resetCredits:{availableCount:0}},base+700);
 await repo.recordRotationCredits(c,credit(3),base+650);
 s=(await repo.readRotationSnapshots([c]))[c.id];assert.equal(s.credits,null);
 const only=await createProviderConnection({provider:'codex',authType:'access_token',name:'Credit first',accessToken:'synthetic-credit-first',isActive:true});
 await repo.recordRotationCredits(only,credit(1),base+600);
 await repo.recordRotationUsage(only,{...usage(0),resetCredits:{availableCount:0}},base+500);
 s=(await repo.readRotationSnapshots([only]))[only.id];assert.equal(s.quotas.find(q=>q.window==='session').remaining,0);assert.equal(s.credits.availableCount,1);
});


test('namespaced model quota exhaustion protects admission without enabling custom sorting',()=>{
 const c={id:'namespaced',provider:'gemini-cli',isActive:true};const now=Date.now();
 const snapshots={[c.id]:engine.normalizeRotationUsage(c.provider,{quotas:{'google/gemini-pro':{remainingPercentage:0}}},now)};
 for(const model of ['google/gemini-pro','gemini-cli/google/gemini-pro']){
  const pool=rotationPool([c],snapshots,engine.emptyRotation(),{provider:c.provider,model,now,quotaAdmission:true});
  assert.equal(pool.ranked.length,0);assert.equal(pool.blocked[0].reason,'Image quota wait');assert.equal(pool.blocked[0].gate,'model');
  assert.equal(pool.admission[1].ready,1);assert.equal(pool.admission[2].ready,0);
 }
 assert.equal(rotationPool([c],snapshots,engine.emptyRotation(),{provider:c.provider,model:'other/gemini-pro',now,quotaAdmission:true}).ranked.length,1);
});

test('quota card weekly reset sort orders every account before availability grouping and pagination',async()=>{
 const active=await Promise.all(connections.map(c=>getProviderConnectionById(c.id)));
 db.run("DELETE FROM providerConnections WHERE provider='codex' AND id NOT IN (?,?,?,?)",active.map(c=>c.id));
 const now=Date.now(),days=[7,6,5,1];
 for(let i=0;i<active.length;i++){
  await updateProviderConnection(active[i].id,{isActive:i!==3});
  const current=await getProviderConnectionById(active[i].id);
  db.run('DELETE FROM providerRotationSnapshots WHERE connectionId=?',[current.id]);
  await repo.recordRotationUsage(current,{quotas:{session:{total:100,used:i===1||i===2?100:0,resetAt:new Date(now+3600000).toISOString()},weekly:{total:100,used:i===3?100:40,resetAt:new Date(now+days[i]*86400000).toISOString()}}},Date.now());
 }
 const client=await import(new URL('src/app/api/providers/client/route.js',root));
 for(const direction of ['asc','desc']){
  const policy={...config,sorts:[{key:'weekly-reset',direction,division:'half'}],resetPriority:{enabled:false,days:3,weeklyBelow:null}};
  const url=new URL('http://localhost/api/providers/client');
  for(const [key,value] of Object.entries({provider:'codex',includeImageAccounts:'true',rotationModel:'gpt-6.1',rotationPolicy:JSON.stringify(policy),pageSize:'2'}))url.searchParams.set(key,value);
  const result=await(await client.GET(new Request(url))).json();
  const expected=direction==='asc'?[3,2,1,0]:[0,1,2,3];
  assert.deepEqual(result.connections.map(c=>c.id),expected.slice(0,2).map(i=>active[i].id));
  url.searchParams.set('page','2');
  const second=await(await client.GET(new Request(url))).json();
  assert.deepEqual(second.connections.map(c=>c.id),expected.slice(2).map(i=>active[i].id));
 }
});
