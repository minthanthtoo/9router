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

// Visible groups are availability only; nested sort partitions still determine order.
export function availabilityQuotaSegments(segments, pins, quotaData, enabled, authoritative = false) {
 const ordered=pinnedQuotaSegments(segments,pins,false).flatMap(segment=>segment.connections);
 if(!enabled)return ordered.length?[{key:'all',connections:ordered,boundaries:[]}]:[];
 const unavailable=new Set(segments.filter(segment=>['waiting','unavailable','disabled'].includes(segment.key)).flatMap(segment=>segment.connections.map(c=>c.id)));
 for(const segment of segments)for(const id of segment.unavailableIds||[])unavailable.add(id);
 const groups=[{key:'ready',rotationName:'Ready',connections:[],boundaries:[]},{key:'unavailable',rotationName:'Unavailable',connections:[],boundaries:[]}];
 for(const connection of ordered){
  const blocked=connection.isActive===false||unavailable.has(connection.id)||!authoritative&&['session','weekly'].some(window=>getConnectionQuotaRemaining(connection,quotaData,window)===0);
  groups[blocked?1:0].connections.push(connection);
 }
 return groups.filter(group=>group.connections.length);
}
