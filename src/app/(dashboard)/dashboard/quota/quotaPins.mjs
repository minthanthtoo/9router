import {RESET_GROUPS} from '@/shared/utils/rotationSequence.mjs';
import {getConnectionQuotaRemaining} from '../usage/components/ProviderLimits/utils.js';
export function pinnedQuotaSegments(segments,pins,demoteDisabled = true) {
 const disabled=demoteDisabled ? segments.flatMap(segment=>segment.connections).filter(connection=>connection.isActive===false) : [];
 const active=disabled.length?segments.map(segment=>({...segment,connections:segment.connections.filter(connection=>connection.isActive!==false)})).filter(segment=>segment.connections.length):segments;
 const ids=new Set(pins),pinned=active.flatMap(segment=>segment.connections).filter(connection=>ids.has(connection.id));
 const ordered=pinned.length?[{key:'pinned',connections:pinned,boundaries:[]},...active.map(segment=>({...segment,connections:segment.connections.filter(connection=>!ids.has(connection.id))})).filter(segment=>segment.connections.length)]:active;
 return disabled.length?[...ordered,{key:'disabled',rotationName:'Disabled accounts',connections:disabled,boundaries:[]}]:ordered;
}
export function toggleQuotaPin(pins,id) {
 return pins.includes(id)?pins.filter(value=>value!==id):[...pins,id];
}

// Keep sequence boundaries visible inside optional availability groups.
export function availabilityQuotaSegments(segments, pins, quotaData, enabled, authoritative = false, preservePartitions = false) {
 if (segments.some(segment=>segment.resetGroup)) {
  return RESET_GROUPS.flatMap(({key,label})=>{
   const members=segments.filter(segment=>segment.resetGroup===key);
   const connections=members.flatMap(segment=>segment.connections);
   if(!connections.length)return [];
   const group={key,connections,boundaries:[],unavailableIds:members.flatMap(segment=>segment.unavailableIds||[])};
   return availabilityQuotaSegments([group],pins,quotaData,enabled,authoritative,false).map(segment=>({
    ...segment,key:`${key}-${segment.key}`,resetGroup:key,
    rotationName:enabled?`${label} · ${segment.key==='ready'?'Ready':'Unavailable'}`:label,
   }));
  });
 }
 const ordered = pinnedQuotaSegments(segments, pins, false);
 if (!enabled) return preservePartitions ? ordered : ordered.length ? [{key:'all',connections:ordered.flatMap(segment=>segment.connections),boundaries:[]}] : [];
 const unavailable = new Set(segments.filter(segment=>['waiting','unavailable','disabled'].includes(segment.key)).flatMap(segment=>segment.connections.map(c=>c.id)));
 for (const segment of segments) for (const id of segment.unavailableIds || []) unavailable.add(id);
 const isUnavailable = connection => connection.isActive === false || unavailable.has(connection.id) || !authoritative && ['session','weekly'].some(window=>getConnectionQuotaRemaining(connection,quotaData,window)===0);
 return [false,true].flatMap(blocked => {
  const key = blocked ? 'unavailable' : 'ready';
  const name = blocked ? 'Unavailable' : 'Ready';
  const partitions = ordered.map(segment=>({...segment,connections:segment.connections.filter(connection=>isUnavailable(connection)===blocked)})).filter(segment=>segment.connections.length);
  if (!preservePartitions) return partitions.length ? [{key,rotationName:name,connections:partitions.flatMap(segment=>segment.connections),boundaries:[]}] : [];
  return partitions.map((segment,index)=>({...segment,key:`${key}-${segment.key}`,rotationName:`${name} · ${segment.key.startsWith('reset') ? 'Expiring credit' : `Group ${index+1}`}`,availability:key}));
 });
}
