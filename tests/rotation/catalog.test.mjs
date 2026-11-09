import test from 'node:test';
import assert from 'node:assert/strict';
import REGISTRY from '../../open-sse/providers/registry/index.js';
import {getModelsByProviderId,PROVIDER_ID_TO_ALIAS} from '../../open-sse/config/providerModels.js';
import {configuredQuotaModels} from '../../src/lib/quotaModelCatalog.js';
import {normalizeQuotaModel,filterQuotaConnections,quotaCatalogCounts,quotaModelMatchesCategory} from '../../src/shared/utils/quotaModelCatalog.mjs';

test('registered model kinds are canonical for every provider, even with a conflicting custom type',()=>{
 for(const {id:provider} of REGISTRY){
  const registered=getModelsByProviderId(provider).map(raw=>normalizeQuotaModel(provider,raw)).filter(Boolean);
  if(!registered.length)continue;
  const custom=registered.map(model=>({providerAlias:PROVIDER_ID_TO_ALIAS[provider]||provider,id:model.id,type:model.kind==='image'?'llm':'image'}));
  const actual=configuredQuotaModels([provider],custom);
  for(const model of registered)assert.equal(actual.find(item=>item.id===model.id)?.kind,model.kind,`${provider}/${model.id}`);
 }
});
test('provider aliases and custom-only image models extend the same catalog without crossing providers',()=>{
 const custom=[{providerAlias:'ag',id:'studio/image',type:'image',capabilities:{generation:true,editing:true}},{providerAlias:'cx',id:'studio/text',type:'llm'}];
 const models=configuredQuotaModels(['antigravity','codex','gemini'],custom);
 assert.deepEqual(models.filter(model=>model.id==='studio/image').map(model=>model.provider),['antigravity']);
 assert.equal(models.find(model=>model.id==='studio/text').kind,'llm');
 const accounts=[{id:'a',provider:'antigravity'},{id:'b',provider:'codex'},{id:'c',provider:'gemini'}];
 assert.deepEqual(filterQuotaConnections(accounts,models,{model:'studio/image'}).map(c=>c.id),['a']);
 const counts=quotaCatalogCounts(accounts,models,'editing');assert.equal(counts.find(m=>m.id==='studio/image').accountCount,1);
 assert.ok(models.filter(m=>quotaModelMatchesCategory(m,'text')).every(m=>m.kind==='llm'));
 assert.ok(models.filter(m=>quotaModelMatchesCategory(m,'image')).every(m=>m.kind==='image'));
});
test('Antigravity image models are not hidden by its text model allowlist while Codex image support stays scoped',()=>{
 const models=configuredQuotaModels(['antigravity','codex']);
 const image=models.find(model=>model.provider==='antigravity'&&model.id==='gemini-3.1-flash-image');
 assert.equal(image?.kind,'image');
 assert.equal(image?.capabilities.generation,true);
 const accounts=[
  {id:'ag',provider:'antigravity',providerSpecificData:{enabledModels:['gemini-3.8-flash-high']}},
  {id:'codex',provider:'codex',providerSpecificData:{enabledModels:['gpt-6.1-sol']}},
 ];
 assert.deepEqual(filterQuotaConnections(accounts,models,{model:'gemini-3.1-flash-image'}).map(account=>account.id),['ag']);
});
