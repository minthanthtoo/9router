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
 const ordered = pinnedQuotaSegments(segments, pins, false);
 if (!enabled) return preservePartitions ? ordered : ordered.length ? [{key:'all',connections:ordered.flatMap(segment=>segment.connections),boundaries:[]}] : [];
 const unavailable = new Set(segments.filter(segment=>['unavailable','disabled'].includes(segment.key)).flatMap(segment=>segment.connections.map(c=>c.id)));
 const waiting = new Set(segments.filter(segment=>segment.key==='waiting').flatMap(segment=>segment.connections.map(c=>c.id)));
 for (const segment of segments) {
  for (const id of segment.unavailableIds || []) unavailable.add(id);
  for (const id of segment.waitingIds || []) waiting.add(id);
 }
 const stateFor = connection => {
  if (connection.isActive === false || unavailable.has(connection.id)) return 'unavailable';
  if (waiting.has(connection.id) || !authoritative && ['session','weekly'].some(window=>getConnectionQuotaRemaining(connection,quotaData,window)===0)) return 'waiting';
  return 'ready';
 };
 return [['ready','Ready'],['waiting','Waiting'],['unavailable','Unavailable']].flatMap(([key,name]) => {
  const partitions = ordered.map(segment=>({...segment,connections:segment.connections.filter(connection=>stateFor(connection)===key)})).filter(segment=>segment.connections.length);
  if (!preservePartitions) return partitions.length ? [{key,rotationName:name,availability:key,connections:partitions.flatMap(segment=>segment.connections),boundaries:[]}] : [];
  return partitions.map((segment,index)=>({...segment,key:`${key}-${segment.key}`,rotationName:`${name} · ${segment.key.startsWith('reset') ? 'Expiring credit' : `Group ${index+1}`}`,availability:key}));
 });
}
