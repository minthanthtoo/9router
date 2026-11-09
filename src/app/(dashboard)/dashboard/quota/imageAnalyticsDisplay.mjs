export function analyticsComparisons(rows,dimension,accounts=[]){
 const groups=new Map();
 for(const row of rows||[]){
  const key=dimension==='provider'?row.provider:dimension==='account'?JSON.stringify([row.provider,row.connectionId]):JSON.stringify([row.provider,row.model]);
  if(!groups.has(key))groups.set(key,{key,provider:row.provider,label:dimension==='provider'?row.provider:dimension==='account'?(accounts.find(a=>a.connectionId===row.connectionId&&a.provider===row.provider)?.accountLabel||'Archived account'):row.model,counts:{dispatches:0,succeeded:0,quota_rejected:0,images:0,outcome_unknown:0}});
  const group=groups.get(key);for(const measure of Object.keys(group.counts))group.counts[measure]+=row.counts[measure]||0;
 }
 return [...groups.values()].sort((a,b)=>b.counts.dispatches-a.counts.dispatches||a.key.localeCompare(b.key));
}
export function analyticsLine(values,width=800,height=130){
 const max=Math.max(1,...values.filter(Number.isFinite)),last=Math.max(1,values.length-1);
 return values.map((value,i)=>Number.isFinite(value)?`${i/last*width},${height-value/max*height}`:null).filter(Boolean).join(' ');
}

// Keep missing observations as gaps; never draw a connection across unknown history.
export function analyticsPath(values,width=800,height=130,left=0,top=0){
 const max=Math.max(1,...values.filter(Number.isFinite)),last=Math.max(1,values.length-1);
 let previous=null,path='';
 values.forEach((value,index)=>{
  if(!Number.isFinite(value)){previous=null;return;}
  const x=left+index/last*width,y=top+height-value/max*height;
  path+=previous===null?`M${x},${y}`:`H${x}V${y}`;
  previous=value;
 });
 return path;
}
