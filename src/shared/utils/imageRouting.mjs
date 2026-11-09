import {emptyRotation,validateRotation} from './rotationSequence.mjs';
const OPERATIONS=['generate','edit'];
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
export function validateImageRouting(value){
 if(value==null)return {version:1,rules:[]};
 if(typeof value!=='object'||Array.isArray(value)||value.version!==1||Object.keys(value).some(key=>!['version','rules'].includes(key))||!Array.isArray(value.rules)||value.rules.length>500)throw new TypeError('Invalid image routing');
 const seen=new Set();
 const rules=value.rules.map(rule=>{
  if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).some(key=>!['operation','provider','model','strategy','stickyRequests','accountPreference','tryNextOnQuota'].includes(key)))throw new TypeError('Invalid image rule');
  const {operation,provider,model,strategy,stickyRequests}=rule;
  if(!OPERATIONS.includes(operation)||!['provider','round-robin','fill-first'].includes(strategy)||!Number.isSafeInteger(stickyRequests)||stickyRequests<1||stickyRequests>100||typeof provider!=='string'||!/^\*$|^[a-z0-9][a-z0-9_-]{0,79}$/.test(provider)||typeof model!=='string'||!/^\*$|^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model)||provider==='*'&&model!=='*')throw new TypeError('Invalid image rule');
  const key=JSON.stringify([operation,provider,model]);if(seen.has(key))throw new TypeError('Duplicate image rule');seen.add(key);
  const extra={};
  if(own(rule,'tryNextOnQuota')) {if(typeof rule.tryNextOnQuota!=='boolean')throw new TypeError('Invalid quota retry');extra.tryNextOnQuota=rule.tryNextOnQuota;}
  if(own(rule,'accountPreference')) {
   const preference=rule.accountPreference;
   if(!preference||typeof preference!=='object'||Array.isArray(preference)||!['text','custom','none'].includes(preference.mode)||Object.keys(preference).some(key=>!['mode','sequence'].includes(key))||preference.mode!=='custom'&&own(preference,'sequence'))throw new TypeError('Invalid image account preference');
   if(preference.mode==='custom'&&provider==='*')throw new TypeError('Choose a provider for a custom sequence');
   extra.accountPreference=preference.mode==='custom'?{mode:'custom',sequence:validateRotation(preference.sequence,provider)}:{mode:preference.mode};
  }
  if(strategy==='provider'&&extra.accountPreference&&extra.accountPreference.mode!=='text')throw new TypeError('Provider rotation must inherit its account sequence');
  return {operation,provider,model,strategy,stickyRequests,...extra};
 });
 return {version:1,rules:rules.sort((a,b)=>{const x=JSON.stringify(a),y=JSON.stringify(b);return x<y?-1:x>y?1:0;})};
}

export function resolveImageSelection(rule,providerOverride={},settings={}) {
 const inherit=!rule||rule.strategy==='provider';
 const strategy=inherit?(providerOverride.fallbackStrategy||settings.fallbackStrategy||'fill-first'):rule.strategy;
 const stickyRequests=strategy==='round-robin'?(inherit?(providerOverride.stickyRoundRobinLimit||settings.stickyRoundRobinLimit||3):rule.stickyRequests):1;
 return {strategy,stickyRequests};
}
export function resolveImageRouting(settings,provider,model,operation){
 if(!OPERATIONS.includes(operation))return null;
 const config=validateImageRouting(own(settings,'aurixImageRouting')?settings.aurixImageRouting:null);
 return config.rules.find(rule=>rule.operation===operation&&rule.provider===provider&&rule.model===model)
  ||config.rules.find(rule=>rule.operation===operation&&rule.provider===provider&&rule.model==='*')
  ||config.rules.find(rule=>rule.operation===operation&&rule.provider==='*')||null;
}
export function chooseImageRotation(candidates,cursor,stickyRequests){
 const sorted=[...candidates].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);if(!sorted.length)return null;
 const current=sorted.find(row=>row.id===cursor?.connectionId);
 if(current&&cursor.useCount<stickyRequests)return {connection:current,useCount:cursor.useCount+1};
 const next=sorted.find(row=>row.id>(cursor?.connectionId||''))||sorted[0];
 return {connection:next,useCount:1};
}

export function resolveImageAccountPreference(rule,textSequence,provider) {
 const preference=rule?.accountPreference;
 if(!preference||preference.mode==='text')return textSequence||emptyRotation();
 if(preference.mode==='custom')return validateRotation(preference.sequence,provider);
 return emptyRotation();
}
