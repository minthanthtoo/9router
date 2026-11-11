import test from 'node:test';
import assert from 'node:assert/strict';
import {QUOTA_SORT_OPTIONS} from '../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js';
import {pinnedQuotaSegments,availabilityQuotaSegments} from '../../src/app/(dashboard)/dashboard/quota/quotaPins.mjs';

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

test('card display has at most Ready and Unavailable groups, with pins staying inside availability',()=>{
 const ready={id:'ready',isActive:true},zero={id:'zero',isActive:true},off={id:'off',isActive:false},waiting={id:'waiting'},blocked={id:'blocked'};
 const segments=[{key:'regular.1',connections:[zero,ready,off]},{key:'waiting',connections:[waiting]},{key:'unavailable',connections:[blocked]}];
 const data={zero:{quotas:[{quotaType:'session',remainingPercentage:0}]}};
 const grouped=availabilityQuotaSegments(segments,['off','zero'],data,true);
 assert.deepEqual(grouped.map(group=>[group.key,group.connections.map(c=>c.id)]),[['ready',['ready']],['unavailable',['zero','off','waiting','blocked']]]);
 const flat=availabilityQuotaSegments(segments,[],data,false);
 assert.equal(flat.length,1);assert.equal(flat[0].key,'all');assert.equal(flat[0].connections.length,5);
});

test('request-scoped server availability wins over unrelated zero quota windows',()=>{
 const account={id:'ready'};
 const data={ready:{quotas:[{quotaType:'weekly',remainingPercentage:0}]}};
 assert.equal(availabilityQuotaSegments([{key:'regular',connections:[account]}],[],data,true,true)[0].key,'ready');
 assert.equal(availabilityQuotaSegments([{key:'regular',connections:[account],unavailableIds:['ready']}],[],{},true,true)[0].key,'unavailable');
});

test('ungrouped cards preserve reset order across ready, waiting and disabled accounts',()=>{
 const cards=[{id:'early',isActive:false},{id:'waiting'},{id:'ready'}];
 const sections=[{key:'all',connections:cards,unavailableIds:['early','waiting']}];
 assert.deepEqual(availabilityQuotaSegments(sections,[],{},false,true)[0].connections.map(c=>c.id),['early','waiting','ready']);
 assert.deepEqual(availabilityQuotaSegments(sections,[],{},true,true).map(g=>g.connections.map(c=>c.id)),[['ready'],['early','waiting']]);
});


test('sequence groups retain boundaries inside availability groups and when availability is off',()=>{
 const a={id:'a'}, b={id:'b'}, c={id:'c'}, d={id:'d'};
 const segments=[{key:'regular.1',connections:[a,b],boundaries:[{mode:'gap',threshold:10}],unavailableIds:['b']},{key:'regular.2',connections:[c,d],boundaries:[{mode:'gap',threshold:20}],unavailableIds:['d']}];
 const groups=availabilityQuotaSegments(segments,[],{},true,true,true);
 assert.deepEqual(groups.map(g=>[g.rotationName,g.connections.map(c=>c.id)]),[['Ready · Group 1',['a']],['Ready · Group 2',['c']],['Unavailable · Group 1',['b']],['Unavailable · Group 2',['d']]]);
 assert.equal(groups[1].boundaries[0].threshold,20);
 const flat=availabilityQuotaSegments(segments,[],{},false,true,true);
 assert.deepEqual(flat.map(g=>g.key),['regular.1','regular.2']);
 assert.deepEqual(flat[0].connections,[a,b]);
});


test('reset groups precede availability and contain all matching waiting and disabled accounts',()=>{
 const a={id:'match-wait'},b={id:'match-ready'},c={id:'outside-ready'},d={id:'no-reset-ready'},e={id:'match-off',isActive:false},f={id:'outside-off',isActive:false};
 const segments=[{key:'reset.1',resetGroup:'reset',connections:[a,b],unavailableIds:['match-wait']},{key:'reset.2',resetGroup:'reset',connections:[e]},{key:'reset-other',resetGroup:'reset-other',connections:[f,c]},{key:'regular',resetGroup:'regular',connections:[d]}];
 const groups=availabilityQuotaSegments(segments,['no-reset-ready'],{},true,true,true);
 assert.deepEqual(groups.map(g=>[g.rotationName,g.connections.map(c=>c.id)]),[['Reset · Matches',['match-wait','match-ready','match-off']],['Reset · Outside criteria',['outside-off','outside-ready']],['No reset credits · Ready',['no-reset-ready']]]);
 const flat=availabilityQuotaSegments(segments,[],{},false,true,true);
 assert.equal(flat.length,3);
 assert.deepEqual(flat[0].connections.map(c=>c.id),['match-wait','match-ready','match-off']);
});

test('quota page reset controls use the same hourglass as provider rotation',()=>{
 assert.deepEqual(QUOTA_SORT_OPTIONS.filter(option=>option.kind==='reset').map(option=>option.icon),['hourglass_empty','hourglass_empty']);
});
