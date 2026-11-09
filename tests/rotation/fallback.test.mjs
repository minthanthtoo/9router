import test from 'node:test';
import assert from 'node:assert/strict';
import {checkFallbackError} from '../../open-sse/services/accountFallback.js';
import {handleImageGenerationCore} from '../../open-sse/handlers/imageGenerationCore.js';
test('account errors fail over, caller validation errors do not quarantine every account',()=>{
 for(const status of [401,402,403,429,500,502,503])assert.equal(checkFallbackError(status,'provider unavailable',0,'codex').shouldFallback,true,String(status));
 assert.equal(checkFallbackError(400,'Invalid image size',0,'codex').shouldFallback,false);
});
test('image adapter preserves definite rejection vs unknown accepted outcome',async()=>{
 let count=0;const args={body:{prompt:'synthetic fixture'},modelInfo:{provider:'openai',model:'gpt-image-1'},credentials:{apiKey:'synthetic-unusable'},onProviderDispatch:()=>null};
 globalThis.fetch=async()=>{count++;return Response.json({error:{message:'quota exceeded'}},{status:429})};
 const refused=await handleImageGenerationCore(args);assert.equal(refused.success,false);assert.equal(refused.acceptance,'rejected_before_acceptance');assert.equal(count,1);
 globalThis.fetch=async()=>{count++;throw new Error('connection lost after send')};
 const uncertain=await handleImageGenerationCore(args);assert.equal(uncertain.acceptance,'unknown');assert.equal(count,2);
});
