import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRotation, emptyRotation, normalizeRotationUsage, SNAPSHOT_MAX_AGE_MS } from '../../src/shared/utils/rotationSequence.mjs';
import { rotationPreviewInfo, previewIsCurrent, rotationMetricLabel, rotationDirection } from '../../src/shared/utils/rotationPreview.mjs';
const now = Date.parse('2026-11-06T08:00:00Z');
const policy = { ...emptyRotation(), enabled: true, sorts: [{ key: 'session-remaining', direction: 'desc', division: 'half' }, { key: 'session-reset', direction: 'asc', division: 'half' }] };
const connections = [1,2,3,4].map(id => ({ id: String(id) }));
const snapshots = Object.fromEntries(connections.map((c,i) => [c.id, normalizeRotationUsage('codex', { quotas: { session: { total: 100, used: i * 20, windowSeconds: 18000, resetAt: new Date(now + 120000 + i * 1000).toISOString() } } }, now)]));
function info(p = policy, s = snapshots, model = 'gpt-6-sol') { const pool = evaluateRotation(connections,s,p,{provider:'codex',model,now}); return rotationPreviewInfo(pool,s,p,{provider:'codex',model,now}); }
test('reports the first preferred segment, not all eligible accounts, and preserves group boundaries', () => {
 const v=info();assert.equal(v.selectedCount,2);assert.deepEqual(v.groups.map(g=>g.count),[2,2]);assert.equal(v.groups[0].boundaries[0].mode,'half');assert.equal(v.sessionLabel,'5h');assert.equal(info({...policy,enabled:false}).selectedCount,4);
});
test('missing, old and fresh-but-unreported are independent, not fabricated zeros', () => {
 const s={...snapshots};delete s['1'];s['2']={...s['2'],observedAt:now-SNAPSHOT_MAX_AGE_MS-1};s['3']={...s['3'],quotas:[]};
 assert.deepEqual(info(policy,s).quality,{missing:1,old:1,unreported:1});
});
test('preview expires at evidence, reset, credit expiry and priority-entry boundaries', () => {
 assert.equal(info().validUntil,now+60000);
 const s={...snapshots,'1':{...snapshots['1'],observedAt:now-SNAPSHOT_MAX_AGE_MS+12000}};
 assert.equal(info(policy,s).validUntil,now+12000);
 s['1']={...snapshots['1'],quotas:[{...snapshots['1'].quotas[0],resetAt:now+5000}]};assert.equal(info(policy,s).validUntil,now+5000);
 const p={...policy,resetPriority:{enabled:true,days:3,weeklyBelow:null}};
 s['1']={...snapshots['1'],credits:{availableCount:1,observedAt:now,expiresAt:now+3*86400000+3000}};
 assert.equal(info(p,s).validUntil,now+3000);
 s['1'].credits.expiresAt=now+2000;assert.equal(info(p,s).validUntil,now+2000);
});
test('blocked account recovery also expires the preview', () => {
 const pool=evaluateRotation(connections,snapshots,policy,{provider:'codex',model:'gpt-6-sol',now});
 const s={...snapshots,blocked:{...snapshots['1'],quotas:[{...snapshots['1'].quotas[0],remaining:0,resetAt:now+1000}]}};
 pool.blocked=[{connection:{id:'blocked'},reason:'Quota exhausted'}];
 assert.equal(rotationPreviewInfo(pool,s,policy,{provider:'codex',model:'gpt-6-sol',now}).validUntil,now+1000);
});
test('freshness guard rejects wrong context, expired and legacy previews', () => {
 const v=info();assert.equal(previewIsCurrent(v,'a','a',now),true);assert.equal(previewIsCurrent(v,'a','b',now),false);assert.equal(previewIsCurrent(v,'a','a',v.validUntil),false);assert.equal(previewIsCurrent({},'a','a',now),false);
});
test('credit matches distinguish missing expiry, missing weekly condition and separate model scopes', () => {
 const p={...policy,resetPriority:{enabled:true,days:3,weeklyBelow:20}},s={...snapshots};
 for(const id of ['1','2'])s[id]={...s[id],credits:{availableCount:1,observedAt:now,expiresAt:id==='1'?now+86400000:null}};
 assert.equal(info(p,s).creditSummary.matching,0);assert.equal(info(p,s).creditSummary.unavailable,4);
 s['1'].quotas.push({window:'weekly',scope:'codex:main',remaining:10,resetAt:now+86400000});assert.equal(info(p,s).creditSummary.matching,1);assert.equal(info(p,s,'gpt-6-spark').creditSummary.applicable,false);
});
test('duration labels require observed window length and directional copy preserves the metric', () => {
 const metric={window:'session',kind:'reset',label:'Short window reset'};
 assert.equal(rotationMetricLabel(metric),'Session reset');assert.equal(rotationMetricLabel(metric,'5h'),'5h reset');assert.equal(rotationDirection(metric,'desc'),'Latest first');assert.equal(rotationDirection({...metric,kind:'remaining'},'asc'),'Low first');
 assert.equal(info(policy,Object.fromEntries(Object.entries(snapshots).map(([k,v])=>[k,{...v,quotas:v.quotas.map(q=>({...q,windowSeconds:null}))}]))).sessionLabel,'Session');
});

test('reset matches distinguish ready accounts from exhausted short-window waits', () => {
 const p={...policy,resetPriority:{enabled:true,days:3,weeklyBelow:null}},s=structuredClone(snapshots);
 for(const id of ['1','2'])s[id].credits={availableCount:1,observedAt:now,expiresAt:now+86400000};
 s['2'].quotas[0].remaining=0;
 const result=info(p,s);
 assert.equal(result.creditSummary.matching,2);
 assert.equal(result.creditSummary.ready,1);
 assert.equal(result.creditSummary.waiting,1);
});
