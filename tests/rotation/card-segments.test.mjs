import test from 'node:test';
import assert from 'node:assert/strict';
import {pinnedQuotaSegments} from '../../src/app/(dashboard)/dashboard/quota/quotaPins.mjs';

test('disabled cards follow all active segments even when pinned; re-enabling restores pin order',()=>{
 const a={id:'a'},b={id:'b',isActive:false},c={id:'c',isActive:true},d={id:'d',isActive:false};
 const segments=[{key:'first',connections:[b,a],boundaries:['original']},{key:'second',connections:[c,d]}];
 const result=pinnedQuotaSegments(segments,['b','c']);
 assert.deepEqual(result.map(group=>[group.key,group.connections.map(row=>row.id)]),[['pinned',['c']],['first',['a']],['disabled',['b','d']]]);
 assert.deepEqual(result[1].boundaries,['original']);
 assert.equal(segments[0].connections.length,2);
 const enabled=segments.map(group=>({...group,connections:group.connections.map(row=>row.id==='b'?{...row,isActive:true}:row)}));
 assert.deepEqual(pinnedQuotaSegments(enabled,['b','c'])[0].connections.map(row=>row.id),['b','c']);
 assert.deepEqual(pinnedQuotaSegments([{key:'all',connections:[b,d]}],['b']).map(group=>group.key),['disabled']);
 assert.deepEqual(pinnedQuotaSegments([],[]),[]);
});
