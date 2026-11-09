import {readImageLearningScope} from "./imageLearningScope.js";
import {imageQuotaLearningPredictionChecks} from "./imageQuotaLearningPrediction.js";
import {createHash} from 'node:crypto';
import {getAdapter} from '../driver.js';
import {estimateImageQuotaLearning} from '../../../sse/services/imageQuotaLearning.js';
const OUTCOMES=['succeeded','quota_rejected','provider_rejected','outcome_unknown','in_flight'];
const PROVIDERS=['antigravity','codex','gemini'];
const ref=value=>createHash('sha256').update(value).digest('hex').slice(0,20);
const measures="COUNT(*) AS dispatches, COALESCE(SUM(outputCount),0) AS images,"+OUTCOMES.map(x=>`SUM(CASE WHEN outcome='${x}' THEN 1 ELSE 0 END) AS ${x}`).join(',');
function counts(row){return Object.fromEntries(['dispatches','images',...OUTCOMES].map(key=>{const n=Number(row?.[key]||0);if(!Number.isSafeInteger(n)||n<0)throw new TypeError('Invalid count');return [key,n];}));}
export function parseImageAnalyticsQuery(params,now=Date.now()){
 const keys=['view','provider','connection','model','days','source'];
 if([...params.keys()].some(key=>!keys.includes(key)||params.getAll(key).length!==1)||params.get('view')!=='analytics')throw new TypeError('Invalid analytics query');
 const provider=params.get('provider')||'',connection=params.get('connection')||'',model=params.get('model')||'',source=params.get('source')||'non_test',days=Number(params.get('days')||28);
 if(provider&&!PROVIDERS.includes(provider)||connection&&!/^[A-Za-z0-9._:-]{1,160}$/.test(connection)||model&&!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)||!['non_test','admin_test','all'].includes(source)||![1,7,28,56].includes(days))throw new TypeError('Invalid analytics scope');
 const to=Math.floor(now/1000)*1000;
 return {provider,connection,model,source,days,from:new Date(to-days*86400000).toISOString(),to:new Date(to).toISOString(),bucketSeconds:days===1?300:3600};
}
export async function getImageQuotaAnalytics(query,now=Date.now()){
 query=parseImageAnalyticsQuery(new URLSearchParams({view:'analytics',provider:query.provider||'',connection:query.connection||'',model:query.model||'',source:query.source||'non_test',days:String(query.days)}),now);
 const db=await getAdapter();if(!['node:sqlite','better-sqlite3','bun:sqlite'].includes(db.driver))throw new TypeError('Durable history required');
 const evidenceClauses=["provider IN ('antigravity','codex','gemini')",'dispatchedAt>=?','dispatchedAt<?'],args=[query.from,query.to];
 for(const [key,column]of [['provider','provider'],['connection','connectionId'],['model','model']])if(query[key]){evidenceClauses.push(`${column}=?`);args.push(query[key]);}
 const clauses=[...evidenceClauses];
 if(query.source==='non_test')clauses.push("entryPoint <> 'admin_model_sample'");
 else if(query.source==='admin_test')clauses.push("entryPoint = 'admin_model_sample'");
 const where=clauses.join(' AND '),evidenceWhere=evidenceClauses.join(' AND '),from=Date.parse(query.from),step=query.bucketSeconds*1000;
 return db.transaction(()=>{
  const total=db.get(`SELECT ${measures},MIN(dispatchedAt) AS firstAt,MAX(dispatchedAt) AS lastAt FROM imageQuotaRequestSubmissions WHERE ${where}`,args);
  const contextArgs=[new Date(from-604800000).toISOString(),...args.slice(1)];
  const grouped=db.all(`SELECT CAST((CAST(ROUND((julianday(dispatchedAt)-2440587.5)*86400000) AS INTEGER)-?)/? AS INTEGER) AS bucket,${measures},MIN(dispatchedAt) AS firstAt FROM imageQuotaRequestSubmissions WHERE ${where} GROUP BY bucket`,[from-604800000,step,...contextArgs]);
  const byBucket=new Map(grouped.map(row=>[Number(row.bucket),row]));
  const offset=604800000/step;
  const prefix=[{dispatches:0,succeeded:0}];
  for(let i=0;i<offset+query.days*86400000/step;i++){const count=counts(byBucket.get(i)),last=prefix.at(-1);prefix.push({dispatches:last.dispatches+count.dispatches,succeeded:last.succeeded+count.succeeded});}
  const buckets=Array.from({length:Math.ceil((Date.parse(query.to)-from)/step)},(_,i)=>({from:new Date(from+i*step).toISOString(),to:new Date(Math.min(Date.parse(query.to),from+(i+1)*step)).toISOString(),counts:counts(byBucket.get(i+offset)),rolling:Object.fromEntries([1,5,24,168].map(hours=>{const end=i+offset+1,start=end-hours*3600000/step;return [hours,{dispatches:prefix[end].dispatches-prefix[start].dispatches,succeeded:prefix[end].succeeded-prefix[start].succeeded}];}))}));
  const categories=db.all(`SELECT provider,connectionId,model,${measures} FROM imageQuotaRequestSubmissions WHERE ${where} GROUP BY provider,connectionId,model ORDER BY dispatches DESC,provider,connectionId,model LIMIT 1001`,args);
  // Read each recorded quota identity once; never fit a shared limit from one credential's traffic alone.
  const identities=db.all(`SELECT provider,supplierIdentity,identityGeneration,model,COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE ${evidenceWhere} GROUP BY provider,supplierIdentity,identityGeneration,model ORDER BY n DESC,provider,supplierIdentity,identityGeneration,model LIMIT 101`,args);
  const seen=new Set(),estimates=[];
  for(const group of identities.slice(0,100)){
   const selected=readImageLearningScope(db,group.provider,group.supplierIdentity,group.identityGeneration,group.model,{from:query.from,to:query.to});
   const groupKey=JSON.stringify([group.provider,group.supplierIdentity,group.identityGeneration,selected.predictionModel]);
   if(seen.has(groupKey))continue;seen.add(groupKey);
   const sample=selected.events;
   const learning=estimateImageQuotaLearning(sample,{truncated:selected.truncated});
   if(selected.scope.ambiguous){learning.estimate={...learning.estimate,state:'ambiguous',windowSeconds:null,callLimit:null,reason:'Multiple quota constraints observed. A single consumption-window fit is unsafe.'};learning.diagnostics.fits=[];learning.diagnostics.fixedResetFits=[];learning.learnedNextCheck=null;}
   const safeFrom=learning.diagnostics.safePeriod?.from;
   const fitSample=learning.diagnostics.safePeriod?.afterUncertainty?sample.filter(event=>Date.parse(event.dispatchedAt)>=Date.parse(safeFrom)):sample;
   const waits=sample.filter(row=>row.outcome==='quota_rejected'&&row.retryAt&&Date.parse(row.retryAt)>=Date.parse(row.completedAt||row.dispatchedAt)).map(row=>(Date.parse(row.retryAt)-Date.parse(row.completedAt||row.dispatchedAt))/1000).sort((a,b)=>a-b);
   estimates.push({provider:group.provider,model:selected.model,quotaScope:selected.scope,quotaRef:ref(groupKey),connectionIds:[...new Set(sample.map(event=>event.connectionId))],...learning,
    evidencePoints:fitSample.filter(event=>["succeeded","quota_rejected","outcome_unknown","in_flight"].includes(event.outcome)).slice(-40).map(event=>({at:event.dispatchedAt,completedAt:event.completedAt,outcome:event.outcome,model:event.model})),
    sampleCounts:Object.fromEntries(OUTCOMES.map(outcome=>[outcome,fitSample.filter(event=>event.outcome===outcome).length])),
    forecastChecks:imageQuotaLearningPredictionChecks(db,group.provider,group.supplierIdentity,group.identityGeneration,selected.predictionModel),
    coverage:{calls:sample.length,sample:fitSample.length,sampleTruncated:selected.truncated,firstAt:sample[0]?.dispatchedAt||null,lastAt:sample.at(-1)?.dispatchedAt||null,credentials:new Set(sample.map(event=>event.connectionId)).size},
    retryWaitSeconds:waits.length?{min:waits[0],median:waits[Math.floor((waits.length-1)/2)],max:waits.at(-1),samples:waits.length}:null});
  }

  return {schema:'image_quota_analytics.v1',generatedAt:new Date(now).toISOString(),scope:{provider:query.provider||null,connection:query.connection||null,model:query.model||null,source:query.source},
   range:{from:query.from,to:query.to,bucketSeconds:query.bucketSeconds,days:query.days},counts:counts(total),buckets,
   categories:categories.slice(0,1000).map(row=>({provider:row.provider,connectionId:row.connectionId,model:row.model,counts:counts(row)})),categoriesTruncated:categories.length>1000,
   estimates,estimatesTruncated:identities.length>100,quality:{contextFirstAt:grouped.map(row=>row.firstAt).filter(Boolean).sort()[0]||null,firstAt:total?.firstAt||null,lastAt:total?.lastAt||null,coverage:'retained_records_only',externalUsageObserved:false,estimateScope:'recorded_quota_identity_and_model'}};
 });
}
