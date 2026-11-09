import test from 'node:test';
import assert from 'node:assert/strict';
import {validateImageRouting,resolveImageAccountPreference,resolveImageSelection} from '../../src/shared/utils/imageRouting.mjs';
import {emptyRotation} from '../../src/shared/utils/rotationSequence.mjs';
const base={operation:'generate',provider:'codex',model:'*',strategy:'round-robin',stickyRequests:1};
const text={...emptyRotation(),enabled:true,sorts:[{key:'session-remaining',direction:'desc',division:'half'}]};
test('legacy image rules retain linked text behavior without rewriting saved fields',()=>{const config=validateImageRouting({version:1,rules:[base]});assert.deepEqual(config.rules[0],base);assert.deepEqual(resolveImageAccountPreference(base,text,'codex'),text);});
test('independent image preference does not inherit subsequent text changes',()=>{const config=validateImageRouting({version:1,rules:[{...base,accountPreference:{mode:'custom',sequence:text},tryNextOnQuota:false}]});assert.deepEqual(resolveImageAccountPreference(config.rules[0],emptyRotation(),'codex'),text);assert.equal(config.rules[0].tryNextOnQuota,false);assert.equal(resolveImageAccountPreference({...base,accountPreference:{mode:'none'}},text,'codex').sorts.length,0);});
test('provider rotation is inherited only when requested; legacy methods and sticky counts remain explicit',()=>{
 const inherited=validateImageRouting({version:1,rules:[{...base,strategy:'provider',stickyRequests:1,accountPreference:{mode:'text'}}]}).rules[0];
 assert.deepEqual(resolveImageSelection(inherited,{fallbackStrategy:'round-robin',stickyRoundRobinLimit:4},{fallbackStrategy:'fill-first'}),{strategy:'round-robin',stickyRequests:4});
 assert.deepEqual(resolveImageSelection(null,{fallbackStrategy:'fill-first',stickyRoundRobinLimit:4},{}),{strategy:'fill-first',stickyRequests:1});
 assert.deepEqual(resolveImageSelection(base,{fallbackStrategy:'fill-first',stickyRoundRobinLimit:4},{}),{strategy:'round-robin',stickyRequests:1});
 const custom={...base,stickyRequests:2};assert.deepEqual(resolveImageSelection(custom,{fallbackStrategy:'fill-first',stickyRoundRobinLimit:4},{}),{strategy:'round-robin',stickyRequests:2});
});
test('image routing validates capability and rejects ambiguous custom global policy',()=>{for(const rule of [{...base,provider:'*',accountPreference:{mode:'custom',sequence:text}},{...base,accountPreference:{mode:'custom',sequence:{...text,sorts:[{key:'fake',direction:'asc'}]}}},{...base,tryNextOnQuota:'false'},{...base,accountPreference:{mode:'text',sequence:text}},{...base,strategy:'provider',accountPreference:{mode:'none'}},{...base,strategy:'provider',accountPreference:{mode:'custom',sequence:text}}])assert.throws(()=>validateImageRouting({version:1,rules:[rule]}));});
