import test from 'node:test';
import assert from 'node:assert/strict';
import {modelQuotaWindows} from '../../src/shared/utils/modelQuotaDisplay.mjs';
import {cardGroupVisible,setSharedCardGroupVisible,setAllCardSectionsVisible,selectedCardModels,setCardModelVisible,cardModelVisible} from '../../src/app/(dashboard)/dashboard/quota/quotaCardDisplay.mjs';
const now=Date.now(),reset=new Date(now+3600000).toISOString();
test('text measurements use the same subscription scope as rotation and keep Antigravity pools separate',()=>{
 const usage={observedAt:new Date(now).toISOString(),quotas:{gemini_session:{remainingPercentage:80,resetAt:reset},gemini_weekly:{remainingPercentage:40},claude_gpt_session:{remainingPercentage:20},claude_gpt_weekly:{remainingPercentage:5}}};
 assert.deepEqual(modelQuotaWindows('antigravity','gemini-3-pro',usage,now).map(q=>q.remaining),[80,40]);
 assert.deepEqual(modelQuotaWindows('antigravity','claude-opus-4',usage,now).map(q=>q.remaining),[20,5]);
 assert.deepEqual(modelQuotaWindows('antigravity','gpt-oss-120b',usage,now).map(q=>q.remaining),[20,5]);
 const codex={quotas:{session:{used:3,total:100},weekly:{used:70,total:100},spark_session:{used:90,total:100},image:{quotaKind:'image_generation',limitId:'image_gen',windowSeconds:18000,used:50,total:100}}};
 assert.deepEqual(modelQuotaWindows('codex','gpt-6.1',codex,now).map(q=>q.remaining),[97,30]);
 assert.deepEqual(modelQuotaWindows('codex','gpt-spark',codex,now).map(q=>q.remaining),[10]);
 assert.deepEqual(modelQuotaWindows('codex','gpt-image-1',codex,now).map(q=>q.remaining),[50]);
});
test('temporary model focus does not rewrite display preferences; global section choices preserve model choices',()=>{
 const models=[{id:'one',kind:'llm'},{id:'two',kind:'llm'},{id:'image',kind:'image'}];
 let prefs=setCardModelVisible({}, {id:'a',provider:'codex',group:'text',model:'two',visible:true});const original=structuredClone(prefs);
 assert.deepEqual(selectedCardModels(models,model=>model.id==='two','one','llm'),['one']);
 assert.deepEqual(selectedCardModels(models,model=>model.id==='two','','llm'),['two']);assert.deepEqual(prefs,original);
 prefs=setSharedCardGroupVisible(prefs,'text',false);
 for(const id of ['a','b'])assert.equal(cardGroupVisible(prefs,id,'text'),false);
 prefs=setAllCardSectionsVisible(prefs,true);for(const id of ['a','b'])for(const group of ['text','summary','images'])assert.equal(cardGroupVisible(prefs,id,group),true);
 prefs=setAllCardSectionsVisible(prefs,false);assert.equal(cardGroupVisible(prefs,'b','summary'),true);assert.equal(cardGroupVisible(prefs,'a','images'),false);assert.equal(cardModelVisible(prefs,'codex','text','two'),true);
});
