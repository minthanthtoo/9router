import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaSequencePolicy,rotationPublishReady,sameQuotaSequence} from '../../src/shared/utils/quotaSequenceDraft.mjs';
const sorts=[{key:'weekly-remaining',direction:'desc'},{key:'session-reset',direction:'asc',division:'gap'}],reset={enabled:true,days:3,weeklyBelow:20};
test('the curated sequence retains exact order/direction/division, and only Codex receives reset awareness',()=>{
 const before=JSON.stringify({sorts,reset});const codex=quotaSequencePolicy('codex',sorts,reset),claude=quotaSequencePolicy('claude',sorts,reset);
 assert.deepEqual(codex.sorts,[{...sorts[0],division:'half'},sorts[1]]);assert.equal(codex.enabled,true);assert.deepEqual(codex.resetPriority,reset);assert.equal(claude.resetPriority.enabled,false);assert.equal(JSON.stringify({sorts,reset}),before);
});
test('unsupported keys and reset-only non-Codex drafts are rejected without dropping criteria',()=>{
 assert.throws(()=>quotaSequencePolicy('github',sorts,reset),/Unsupported/);assert.throws(()=>quotaSequencePolicy('no-provider',sorts,reset),/unavailable/);assert.throws(()=>quotaSequencePolicy('claude',[],reset),/Choose/);assert.equal(quotaSequencePolicy('codex',[],reset).enabled,true);
});
test('publish readiness blocks stale, uncertain, conflicting, failed and already-applied outcomes',()=>{
 const row={revision:'1',preview:{validUntil:2000}};assert.equal(rotationPublishReady(row,1000),true);for(const more of [{status:'saving'},{status:'uncertain'},{status:'conflict'},{status:'applied'},{loading:true},{error:'failed'},{preview:{validUntil:999}}])assert.equal(rotationPublishReady({...row,...more},1000),false);
 assert.equal(sameQuotaSequence(quotaSequencePolicy('codex',sorts,reset),quotaSequencePolicy('codex',sorts,reset)),true);
});
