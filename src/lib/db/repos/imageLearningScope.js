import {createHash} from 'node:crypto';

const observations=event=>{try{const value=JSON.parse(event.quotaObservations||'[]');return Array.isArray(value)?value:[];}catch{return [];}};
const scopeKey=row=>JSON.stringify([row.quotaGroupId,row.constraintId]);

// Only explicit wildcard observations establish a quota shared across models.
export function selectImageLearningScope(history,model){
 // Generic Codex subscription limits protect admission, but do not establish an image-model cap.
 history=history.map(event=>event.provider==='codex'&&event.outcome==='quota_rejected'&&!observations(event).some(row=>['image_gen','imagegen_premium'].includes(row.constraintId))?{...event,outcome:'provider_rejected'}:event);
 const shared=history.filter(event=>event.outcome==='quota_rejected').flatMap(event=>observations(event)).filter(row=>row.appliesToModels?.includes('*')&&row.quotaGroupId&&row.constraintId);
 const scopes=[...new Map(shared.map(row=>[scopeKey(row),row])).values()];
 // Multiple simultaneous constraints need a multi-constraint consumption model, not one pooled fit.
 const constraint=scopes.length===1?scopes[0]:null;
 const events=history.filter(event=>constraint
  ? event.outcome!=='quota_rejected'||observations(event).some(row=>scopeKey(row)===scopeKey(constraint)&&row.appliesToModels?.includes('*'))
  : event.model===model).map(event=>({...event,retrySource:observations(event).find(row=>row.retryAt===event.retryAt)?.source}));
 const sharedKey=constraint?createHash('sha256').update(scopeKey(constraint)).digest('hex').slice(0,24):null;
 return {events,model:constraint?'*':model,predictionModel:constraint?`scope:${sharedKey}`:model,
  scope:{kind:constraint?'shared_image_quota':'model',models:[...new Set(events.map(event=>event.model))].sort(),
   quotaGroupId:constraint?.quotaGroupId||null,constraintId:constraint?.constraintId||null,
   ambiguous:scopes.length>1}};
}

export function readImageLearningScope(db,provider,identity,generation,model,{from=null,to=null,limit=2000,connectionIds=[]}={}){
 const ids=[...new Set(connectionIds.filter(id=>typeof id==='string'&&id.length))];
 const clauses=['provider=?',ids.length?`((supplierIdentity=? AND identityGeneration=?) OR (supplierIdentity IS NULL AND connectionId IN (${ids.map(()=>'?').join(',')})))`:'supplierIdentity=? AND identityGeneration=?'];
 const args=[provider,identity,generation,...(ids.length?ids:[])];
 if(from){clauses.push('dispatchedAt>=?');args.push(from);}if(to){clauses.push('dispatchedAt<?');args.push(to);}
 const where=clauses.join(' AND ');
 const total=Number(db.get(`SELECT COUNT(*) AS n FROM imageQuotaRequestSubmissions WHERE ${where}`,args).n);
 const history=db.all(`SELECT id,connectionId,model,dispatchedAt,completedAt,outcome,httpStatus,retryAt,confidence,quotaObservations,outputCount FROM imageQuotaRequestSubmissions WHERE ${where} ORDER BY dispatchedAt DESC,id DESC LIMIT ?`,[...args,limit]).reverse();
 const selected=selectImageLearningScope(history.map(event=>({...event,provider})),model);
 return {...selected,truncated:total>history.length||Boolean(from),identityCalls:total};
}
