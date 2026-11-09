export function pinnedQuotaSegments(segments,pins) {
 const disabled=segments.flatMap(segment=>segment.connections).filter(connection=>connection.isActive===false);
 const active=disabled.length?segments.map(segment=>({...segment,connections:segment.connections.filter(connection=>connection.isActive!==false)})).filter(segment=>segment.connections.length):segments;
 const ids=new Set(pins),pinned=active.flatMap(segment=>segment.connections).filter(connection=>ids.has(connection.id));
 const ordered=pinned.length?[{key:'pinned',connections:pinned,boundaries:[]},...active.map(segment=>({...segment,connections:segment.connections.filter(connection=>!ids.has(connection.id))})).filter(segment=>segment.connections.length)]:active;
 return disabled.length?[...ordered,{key:'disabled',rotationName:'Disabled accounts',connections:disabled,boundaries:[]}]:ordered;
}
export function toggleQuotaPin(pins,id) {
 return pins.includes(id)?pins.filter(value=>value!==id):[...pins,id];
}
