import {createRequire as nodeRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=nodeRequire(import.meta.url);
const candidate=fileURLToPath(new URL('../../',import.meta.url));
const {test,after,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {resolve}=require('node:path');
const requireFront=createRequire(new URL('../package.json',import.meta.url));
const esbuild=requireFront('esbuild'),{JSDOM}=requireFront('jsdom');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
for(const key of ['window','document','HTMLElement','sessionStorage','Event','MutationObserver'])global[key]=dom.window[key];
Object.defineProperty(global,'navigator',{value:dom.window.navigator,configurable:true});global.requestAnimationFrame=fn=>setTimeout(fn,0);global.cancelAnimationFrame=clearTimeout;
HTMLElement.prototype.scrollIntoView=function(){};HTMLElement.prototype.getClientRects=function(){return [{}]};

async function harness(component='RotationSequenceControl'){
 const built=await esbuild.build({entryPoints:[resolve(candidate,`src/shared/components/${component}.js`)],bundle:true,platform:'node',format:'cjs',write:false,loader:{'.js':'jsx'},jsx:'automatic',plugins:[{name:'house-fixtures',setup(build){
 build.onResolve({filter:/^@\//},args=>({path:resolve(candidate,'src',args.path.slice(2)+'.js')}));
 build.onResolve({filter:/^(react|react-dom)(\/.*)?$/},args=>({path:requireFront.resolve(args.path),external:true}));
 build.onResolve({filter:/\.module\.css$/},()=>({path:'styles',namespace:'mock'}));
 build.onResolve({filter:/^(next\/link|\.\.\/\.\/app\/\(dashboard\)\/dashboard\/quota\/ImageHelp|\.\/Modal|\.\/ProviderIcon|\.\/Button|\.\.\/constants\/models)$/},args=>({path:args.path,namespace:'mock'}));
 build.onLoad({filter:/.*/,namespace:'mock'},args=>({loader:'jsx',contents:args.path==='styles'?'export default {}':args.path.includes('models')?"export const getModelsByProviderId=()=>[{id:'gpt-6-sol',name:'GPT'}]":args.path==='./Modal'?"import React from 'react';export default function Modal({children,title}){return <div><h2>{title}</h2>{children}</div>}":args.path==='./Button'?"import React from 'react';export default function Button({children,disabled,onClick,size,variant,icon,...props}){return <button {...props} disabled={disabled} onClick={onClick}>{children}</button>}":args.path==='next/link'?"import React from 'react';export default function Link({children,href,...props}){return <a href={href} {...props}>{children}</a>}":args.path.includes('ImageHelp')?"import React from 'react';export default function Help({label,children}){return <details><summary>{label}</summary>{children}</details>}":'export default function Icon(){return null}'}));
 }}]});
 const Module=require('node:module'),m=new Module(resolve(candidate,'tests/rotation/ui-bundle.cjs'));m.filename=resolve(candidate,'tests/rotation/ui-bundle.cjs');m.paths=[];m._compile(built.outputFiles[0].text,m.filename);return m.exports.default;
}
test('editor separates activation, auto-previews cached data, ignores stale responses, and can disable after failure',async()=>{
 const React=requireFront('react'),{render,screen,fireEvent,waitFor,cleanup}=requireFront('@testing-library/react');
 const Control=await harness();let policy={version:1,enabled:false,sorts:[],resetPriority:{enabled:false,days:3,weeklyBelow:null}},calls=[],late,delay=false,fail=false;
 global.fetch=async(url,options={})=>{
 const body=options.body?JSON.parse(options.body):null;calls.push({method:options.method||'GET',body});
 if(options.method==='PATCH'){policy=body.policy;return Response.json({policy,revision:'2'})}
 if(options.method!=='POST')return Response.json({policy,revision:'1',metrics:[]});
 const metrics=['session','weekly'].flatMap(window=>['remaining','reset'].map(kind=>({key:`${window}-${kind}`,window,kind,label:`${window} ${kind}`,icon:'percent'})));
 const preview={model:body.model,sorts:body.policy.sorts,policyEnabled:body.policy.enabled,resetPriorityEnabled:body.policy.resetPriority.enabled,metrics,stages:[{id:'eligible',type:'eligible',label:'Eligible',groups:[{key:'all',ids:Array.from({length:23},(_,i)=>i===0?'a':String(i)),boundaries:[]}]},...body.policy.sorts.map((rule,i)=>({id:`sort-${i}`,type:'sort',label:`Rule ${i+1}`,rule,ruleIndex:i,groups:[{key:'all',ids:Array.from({length:23},(_,i)=>i===0?'a':String(i)),boundaries:[]}]}))],observedAt:Date.now(),validUntil:Date.now()+60000,sessionLabel:'5h',quality:{missing:0,old:0,unreported:0},creditSummary:{applicable:true,matching:0,unavailable:0},groups:[{segment:1,count:23,priority:false,boundaries:[]}],selectedCount:23,eligible:23,total:23,strategy:'round-robin',stickyRequests:1,fallback:!body.policy.enabled,rows:Array.from({length:23},(_,i)=>({id:i===0?'a':String(i),name:i===0?body.model:`${body.model} ${i+1}`,scope:'Main Codex allowance · shared across supported main text models',measurements:{'session-remaining':40,'weekly-remaining':20,'session-reset':Date.now()+3600000,'weekly-reset':Date.now()+86400000},segment:1,values:body.policy.sorts.map(()=>40),fresh:true,observedAt:Date.now(),boundaries:[]})),blocked:[],nextId:'a'};
 if(delay){delay=false;return new Promise(r=>late=()=>r(Response.json({preview})))}
 return fail?Response.json({error:'Preview failed'},{status:500}):Response.json({preview});
 };
 render(React.createElement(Control,{provider:'codex'}));fireEvent.click(screen.getByRole('button',{name:'Edit codex rotation sequence'}));
 await waitFor(()=>assert.equal(screen.getByRole('switch',{name:'Use sort sequence'}).disabled,false));
 await waitFor(()=>assert.ok(screen.getByText('23 ready')),{timeout:10000});
 assert.equal(calls.find(c=>c.body?.action==='preview').body.model,'gpt-6-sol');
 assert.equal(calls.some(c=>c.method==='PATCH'||c.body?.action==='refresh'),false);
 fireEvent.click(screen.getByRole('button',{name:'Short window left %: Off'}));
 assert.equal(screen.getByRole('switch',{name:'Use sort sequence'}).checked,false);
 fireEvent.click(screen.getByRole('button',{name:'Codex credit priority: off'}));fireEvent.click(screen.getByRole('switch',{name:'Prioritize expiring credits'}));fireEvent.click(screen.getAllByRole('button',{name:'Done'}).find(button=>button.closest('[role="dialog"]')?.getAttribute('aria-label')!=='codex account rotation'));assert.equal(screen.getByRole('switch',{name:'Use sort sequence'}).checked,false);

 await waitFor(()=>assert.ok(screen.getByText('23 ready')),{timeout:10000});
 assert.ok(calls.some(c=>c.body?.action==='preview'));assert.equal(calls.some(c=>c.body?.action==='refresh'),false);
 fireEvent.click(screen.getByRole('switch'));
 await waitFor(()=>assert.equal(screen.getByRole('button',{name:'Enable sequence'}).disabled,false),{timeout:10000});
 fireEvent.click(screen.getByRole('button',{name:'Enable sequence'}));await waitFor(()=>assert.ok(screen.getAllByText('Live: Sequence').length));
 assert.equal(screen.queryByRole('button',{name:'Compare',exact:true}),null);assert.equal(screen.queryByRole('table'),null);
 fireEvent.click(screen.getByLabelText('Change preview model'));

 fireEvent.click(screen.getByRole('button',{name:'3',exact:true}));assert.ok(screen.getAllByText('gpt-6-sol 21').length);assert.equal(document.activeElement.getAttribute('aria-label'),'Account preview');fireEvent.click(screen.getByRole('button',{name:'1',exact:true}));assert.ok(screen.getAllByText('gpt-6-sol').length);

 delay=true;fireEvent.change(screen.getByRole('combobox',{name:'Model'}),{target:{value:'old-model'}});
 await waitFor(()=>assert.ok(late),{timeout:10000});fireEvent.change(screen.getByRole('combobox',{name:'Model'}),{target:{value:'new-model'}});
 await waitFor(()=>assert.ok(screen.getByText('Next: new-model')),{timeout:10000});late();await new Promise(r=>setTimeout(r,50));assert.ok(screen.getByText('Next: new-model'));
 const beforeInvalid=calls.length;fireEvent.change(screen.getByRole('combobox',{name:'Model'}),{target:{value:'bad model!'}});
 assert.equal(screen.getByRole('combobox',{name:'Model'}).getAttribute('aria-invalid'),'true');
 assert.equal(screen.getByRole('button',{name:'Read quotas'}).disabled,true);
 fireEvent.click(screen.getByRole('button',{name:'Edit context'}));assert.equal(document.activeElement,screen.getByRole('combobox',{name:'Model'}));
 await new Promise(r=>setTimeout(r,350));assert.equal(calls.length,beforeInvalid);
 fail=true;fireEvent.change(screen.getByRole('combobox',{name:'Model'}),{target:{value:'fail-model'}});
 await waitFor(()=>assert.ok(screen.getByText('Preview failed')),{timeout:10000});fireEvent.click(screen.getByRole('switch'));
 assert.equal(screen.getByRole('button',{name:'Disable sequence'}).disabled,false);
 cleanup();render(React.createElement(Control,{provider:'claude'}));fireEvent.click(screen.getByRole('button',{name:'Edit claude rotation sequence'}));await waitFor(()=>assert.ok(screen.getByRole('switch',{name:'Use sort sequence'})));assert.equal(screen.queryByRole('button',{name:/Codex credit priority/}),null);cleanup();
});

test('board preserves account identity and explanation through compact walkthrough, shows all windows and invalidates stale context',async()=>{
 const React=requireFront('react'),{render,screen,fireEvent,cleanup}=requireFront('@testing-library/react');
 const Explorer=await harness('RotationPreviewExplorer');
 const engine=await import('../../src/shared/utils/rotationSequence.mjs');
 const utils=await import('../../src/shared/utils/rotationPreview.mjs');
 const now=Date.now(),connections=Array.from({length:6},(_,i)=>({id:String(i)}));
 const snapshots=Object.fromEntries(connections.map((c,i)=>[c.id,{provider:'codex',observedAt:now,quotas:[{id:'session',window:'session',scope:'codex:main',remaining:90-i*10,resetAt:now+[1,4,2,.5,3,1.5][i]*3600000},{id:'weekly',window:'weekly',scope:'codex:main',remaining:50-i*2,resetAt:now+86400000}]}]));
 const policy={...engine.emptyRotation(),enabled:true,sorts:[{key:'session-remaining',direction:'desc',division:'half'},{key:'session-reset',direction:'asc',division:'half'}]},events=[];
 const pool=engine.evaluateRotation(connections,snapshots,policy,{provider:'codex',model:'gpt-6-sol',now,onStep:e=>events.push(e)});
 const preview={...utils.rotationPreviewInfo(pool,snapshots,policy,{provider:'codex',model:'gpt-6-sol',now}),model:'gpt-6-sol',sorts:policy.sorts,policyEnabled:true,metrics:engine.rotationMetrics('codex'),stages:utils.rotationStages(events,policy),observedAt:now,strategy:'round-robin',stickyRequests:2,fallback:false,eligible:6,total:6,nextId:'0',blocked:[],rows:pool.segments.flatMap((g,i)=>g.rows.map(row=>({id:row.connection.id,name:'Account '+row.connection.id,segment:i+1,measurements:utils.rotationMeasurements(snapshots[row.connection.id],'codex','gpt-6-sol',now),scope:'Main Codex allowance · shared',fresh:true,observedAt:now})))};
 const {rerender}=render(React.createElement(Explorer,{preview,current:true,dirty:true,now}));
 assert.equal(screen.getAllByRole('meter').length,12);assert.equal(screen.queryByRole('button',{name:'Compare'}),null);
 const originalCard=document.querySelector('[data-account-id="0"]');
 assert.equal(screen.getAllByText('Weekly remaining').length,6);assert.ok(screen.getByText('3 preferred'));
 fireEvent.click(screen.getByLabelText('Why here: Account 0'));
 assert.ok(screen.getByText(/rank 1 of 6 in this group/));
 fireEvent.click(screen.getByRole('button',{name:'Previous step'}));
 fireEvent.click(screen.getByRole('button',{name:'Previous step'}));assert.ok(screen.getByText(/Divide each preceding group/));
 assert.ok(screen.getByLabelText('Why here: Account 0').parentElement.open);assert.equal(document.querySelector('[data-account-id="0"]'),originalCard);
 fireEvent.click(screen.getByRole('button',{name:'Final order',exact:true}));assert.ok(screen.getByLabelText('Why here: Account 0').parentElement.open);
 window.matchMedia=()=>({matches:false});fireEvent.click(screen.getByRole('button',{name:'Play steps'}));
 const pause=screen.getByRole('button',{name:'Pause'});fireEvent.pointerDown(pause);fireEvent.click(pause);assert.ok(screen.getByRole('button',{name:'Play steps'}));
 await new Promise(r=>setTimeout(r,1200));assert.equal(screen.getByRole('button',{name:'Previous step'}).disabled,true);
 window.matchMedia=()=>({matches:true});fireEvent.click(screen.getByRole('button',{name:'Play steps'}));assert.equal(screen.queryByRole('button',{name:'Pause'}),null);
 fireEvent.click(screen.getByRole('button',{name:'Final order'}));
 const next={...preview,model:'gpt-6-spark',rows:preview.rows.map(r=>({...r,scope:'Spark allowance',measurements:Object.fromEntries(Object.keys(r.measurements).map(k=>[k,null]))})),quality:{missing:0,old:0,unreported:6}};
 rerender(React.createElement(Explorer,{preview:next,current:false,dirty:true,now}));assert.ok(screen.getByText('Next: updating'));assert.ok(screen.getAllByText('Not reported').length);assert.equal(screen.queryByText(/Next if applied:/),null);assert.equal(screen.queryAllByRole('meter').length,0);
 cleanup();
});

test('wrapping sort editor preserves priority, cycle and attached split when adding or removing rules',async()=>{
 const React=requireFront('react'),{render,screen,fireEvent}=requireFront('@testing-library/react');
 const Sort=await harness('QuotaSortBar'),{rotationMetrics}=await import('../../src/shared/utils/rotationSequence.mjs');
 let latest=[];function Editor(){const [sorts,setSorts]=React.useState([]);latest=sorts;return React.createElement(Sort,{sorts,options:rotationMetrics('codex'),provider:'codex',wrap:true,onChange:setSorts});}
 render(React.createElement(Editor));
 fireEvent.change(screen.getByRole('combobox',{name:'Add sort'}),{target:{value:'weekly-reset'}});
 fireEvent.change(screen.getByRole('combobox',{name:'Add sort'}),{target:{value:'session-remaining'}});
 assert.deepEqual(latest.map(sort=>sort.key),['weekly-reset','session-remaining']);
 const split=screen.getByRole('button',{name:/Divide before Short window left %/});assert.equal(split.disabled,false);assert.equal(split.parentElement.querySelector('button[aria-pressed]').getAttribute('aria-label'),'Short window left %: Lowest first, priority 2');
 fireEvent.click(split);assert.equal(latest[1].division,'median');
 fireEvent.click(screen.getByRole('button',{name:'Weekly reset: Earliest first, priority 1'}));
 fireEvent.click(screen.getByRole('button',{name:'Weekly reset: Latest first, priority 1'}));
 assert.equal(latest.length,1);assert.ok(screen.getByRole('button',{name:'Short window left %: Lowest first, priority 1'}));
});

test('image preview exposes separate quota gates and the method inside the selected group',async()=>{
 const React=requireFront('react'),{render,screen}=requireFront('@testing-library/react');
 const Explorer=await harness('RotationPreviewExplorer'),now=Date.now();
 const preview={metrics:[],model:'image-fixture',rows:[],groups:[],stages:[],sorts:[],eligible:0,total:3,selectedCount:0,nextId:null,quality:{},strategy:'round-robin',stickyRequests:2,fallback:false,blocked:[{id:'blocked',name:'Account One',gate:'subscription',reason:'Quota exhausted'}],admission:[{id:'account',label:'Enabled accounts',ready:2},{id:'subscription',label:'Subscription allowance',ready:1,unreported:1},{id:'model',label:'Image quota & holds',ready:0}]};
 render(React.createElement(Explorer,{preview,current:true,now}));
 assert.equal(screen.getByRole('list',{name:'Image eligibility checks'}).children.length,3);
 assert.ok(screen.getByText('1 unknown'));
 assert.ok(screen.getByText('Round robin · 2 requests/account · preferred group'));
 assert.ok(screen.getByText('Subscription allowance · Quota exhausted'));
});

afterEach(()=>requireFront('@testing-library/react').cleanup());
after(()=>dom.window.close());

test('availability grouping control leads the sort bar, is disabled for one sort and toggles with multiple sorts',async()=>{
 const React=requireFront('react'),{render,screen,fireEvent,cleanup}=requireFront('@testing-library/react');
 const Bar=await harness('QuotaSortBar');
 const {emptyRotation,rotationMetrics,updateRotationSorts,availabilityGrouping}=await import('../../src/shared/utils/rotationSequence.mjs');
 function Example(){
  const [policy,setPolicy]=React.useState({...emptyRotation(),sorts:[{key:'session-reset',direction:'asc',division:'half'}]});
  return React.createElement(Bar,{sorts:policy.sorts,options:rotationMetrics('codex'),groupAvailability:availabilityGrouping(policy),onGroupAvailabilityChange:value=>setPolicy({...policy,groupAvailability:value}),onChange:sorts=>setPolicy(updateRotationSorts(policy,sorts))});
 }
 render(React.createElement(Example));
 const button=screen.getByRole('button',{name:'Group Ready and Unavailable accounts'});
 assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-pressed'),'false');
 fireEvent.click(screen.getByRole('button',{name:'Weekly reset: Off'}));
 assert.equal(button.disabled,false);assert.equal(button.getAttribute('aria-pressed'),'true');
 assert.equal(screen.getByRole('group',{name:'Sort priority'}).querySelector('button'),button);
 fireEvent.click(button);assert.equal(button.getAttribute('aria-pressed'),'false');
 cleanup();
});
