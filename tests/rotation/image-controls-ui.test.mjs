import test,{after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,Module} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const req=createRequire(new URL('../package.json',import.meta.url)),{JSDOM}=req('jsdom'),esbuild=req('esbuild');
const dom=new JSDOM('<html><body></body></html>',{url:'http://localhost/'});
for(const key of ['window','document','HTMLElement','sessionStorage','Event','MutationObserver'])globalThis[key]=dom.window[key];
Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
globalThis.requestAnimationFrame=fn=>setTimeout(fn,0);globalThis.cancelAnimationFrame=clearTimeout;
const React=req('react'),{render,screen,fireEvent,waitFor,cleanup,act}=req('@testing-library/react');
async function component(name,exportName="default"){
 const result=await esbuild.build({entryPoints:[resolve(repo,'src/app/(dashboard)/dashboard/quota',name+'.js')],write:false,bundle:true,format:'cjs',platform:'node',jsx:'automatic',loader:{'.js':'jsx'},plugins:[{name:'ui-fixture',setup(build){
 build.onResolve({filter:/\.module\.css$/},()=>({path:'styles',namespace:'mock'}));
 build.onResolve({filter:/^@\//},a=>({path:resolve(repo,'src',a.path.slice(2)+(extname(a.path)?'':'.js'))}));
 build.onResolve({filter:/^(react|react-dom)(\/.*)?$/},a=>({path:req.resolve(a.path),external:true}));
 build.onResolve({filter:/ImageRouting$|ImageQuotaPanel$|^next\/dynamic$/},a=>name==='ImageManagementDialog'?{path:a.path,namespace:'dialog-child'}:undefined);
 build.onLoad({filter:/.*/,namespace:'dialog-child'},a=>({loader:'jsx',contents:a.path==='next/dynamic'?'export default function dynamic(){return function Loading(){return null}}':'import React from "react";export default function Panel(){return <input aria-label="Rotation input"/>}'}));
 build.onResolve({filter:/ImageTestButton$|ImageHelp$|ProviderIcon$/},a=>({path:a.path,namespace:'mock'}));
 build.onLoad({filter:/.*/,namespace:'mock'},a=>({loader:'jsx',contents:a.path==='styles'?'export default {}':a.path.endsWith('ImageHelp')?'import React from "react";export default function Help({label,children}){return <details><summary>{label}</summary>{children}</details>}':a.path.endsWith('ImageTestButton')?'import React from "react";export default function Test(){return <button>Test model</button>}':'export default function Icon(){return null}'}));
 }}]});const m=new Module(resolve(repo,'tests/rotation/image-controls-bundle.cjs'));m.filename=resolve(repo,'tests/rotation/image-controls-bundle.cjs');m._compile(result.outputFiles[0].text,m.filename);return m.exports[exportName];
}
const account={connectionId:'a',provider:'codex',quotaGroupId:'shared',accountLabel:'Alpha',routeState:'eligible_unreported',manualPolicy:{state:'paused',revision:3},modelPolicies:[{model:'m1',state:'paused',revision:2}],learning:{models:[{model:'m1',counts:{calls24h:2,callsTotal:4}},{model:'m2',counts:{calls24h:1,callsTotal:2}}]}};
test('shared account control exposes preserved child switches and never fabricates unknown quota meters',async()=>{
 const Controls=await component('ImageAccountControls'),calls=[];
 const state={catalog:[],drafts:{},busyId:null,model:'',togglePolicy:(row,model)=>calls.push(model),tests:{}};
 render(React.createElement(Controls,{row:account,state}));
 assert.equal(screen.getByRole('switch',{name:'Enable all image models on Alpha'}).getAttribute('aria-checked'),'false');
 fireEvent.click(screen.getByRole('button',{name:'Actions for m1'}));assert.ok(screen.getByRole('group',{name:'Secondary actions for m1'}));
 assert.equal(screen.getByRole('switch',{name:'Enable m1 on Alpha'}).getAttribute('aria-checked'),'false');
 fireEvent.keyDown(document,{key:'Escape'});
 fireEvent.click(screen.getByRole('button',{name:'Actions for m2'}));assert.ok(screen.getByRole('group',{name:'Secondary actions for m2'}));
 assert.equal(screen.getByRole('switch',{name:'Disable m2 on Alpha'}).getAttribute('aria-checked'),'true');
 fireEvent.click(screen.getByRole('switch',{name:'Enable all image models on Alpha'}));assert.deepEqual(calls,[null]);
 assert.equal(screen.queryByRole('meter'),null);
});
test('bulk permission deduplicates repeated accounts, preserves model scope and stops on unknown outcome',async()=>{
 const Bulk=await component('ImageBulkPermission'),calls=[];
 const rows=[account,{...account,connectionId:'a'}, {...account,connectionId:'b',quotaGroupId:'other',accountLabel:'Beta'},{...account,connectionId:'c',quotaGroupId:'third',accountLabel:'Gamma'}];
 const state={drafts:{},togglePolicy:async(row,model,action)=>{calls.push([row.connectionId,model,action]);return calls.length===2?{ok:false,unknown:true}:{ok:true};}};
 render(React.createElement(Bulk,{accounts:rows,state}));fireEvent.click(screen.getByRole('button',{name:'Allow shown accounts'}));
 await waitFor(()=>assert.ok(screen.getByText(/stopped: check unconfirmed switch/)));
 assert.deepEqual(calls,[['a',null,'resume'],['b',null,'resume']]);assert.equal(account.modelPolicies[0].state,'paused');
});
test('image rotation can use provider settings or save a custom override and fences uncertain saves',async()=>{
 const Routing=await component('ImageRouting');const calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push(options);if(options.method==='PATCH')throw Error('Lost save response');return Response.json({schema:'image_routing.v1',revision:'a'.repeat(64),config:{version:1,rules:[]},textSequences:{},automation:{quotaReads:{configured:false,running:false},imageRecovery:{scheduled:false}}});};
 render(React.createElement(Routing,{initialProvider:'codex',state:{catalog:[{provider:'codex',id:'img',capabilities:{generation:true,editing:true}}]}}));
 await waitFor(()=>assert.equal(screen.getByRole('combobox',{name:'Image rotation settings'}).value,'provider'));
 assert.equal(screen.queryByRole('combobox',{name:'Image account order'}),null);
 fireEvent.change(screen.getByRole('combobox',{name:'Image rotation settings'}),{target:{value:'custom'}});
 assert.equal(screen.getByRole('combobox',{name:'Image account order'}).value,'text');
 fireEvent.change(screen.getByRole('combobox',{name:'Image account order'}),{target:{value:'none'}});
 fireEvent.click(screen.getByRole('button',{name:'Save image rotation'}));await waitFor(()=>assert.equal(screen.getByRole('button',{name:'Save image rotation'}).disabled,true));
 const rule=JSON.parse(calls.find(c=>c.method==='PATCH').body).config.rules[0];
 assert.equal(rule.strategy,'round-robin');assert.equal(rule.accountPreference.mode,'none');
 assert.equal(screen.getByRole('switch',{name:'Try next account on quota limit'}).checked,true);
 assert.equal(calls.filter(c=>c.method==='PATCH').length,1);
});
test('legacy image override can return to provider strategy without losing its inherited sequence',async()=>{
 const Routing=await component('ImageRouting'),calls=[],legacy={operation:'generate',provider:'codex',model:'*',strategy:'round-robin',stickyRequests:2,accountPreference:{mode:'text'}};
 globalThis.fetch=async(url,options={})=>{calls.push(options);if(options.method==='PATCH')return Response.json({schema:'image_routing.v1',revision:'b'.repeat(64),config:{version:1,rules:[{...legacy,strategy:'provider',stickyRequests:1}]},textSequences:{},automation:{}});return Response.json({schema:'image_routing.v1',revision:'a'.repeat(64),config:{version:1,rules:[legacy]},textSequences:{},automation:{}});};
 render(React.createElement(Routing,{initialProvider:'codex',state:{catalog:[{provider:'codex',id:'img',capabilities:{generation:true,editing:true}}]}}));
 await waitFor(()=>assert.equal(screen.getByRole('combobox',{name:'Image rotation settings'}).value,'custom'));
 fireEvent.change(screen.getByRole('combobox',{name:'Image rotation settings'}),{target:{value:'provider'}});
 fireEvent.click(screen.getByRole('button',{name:'Save image rotation'}));
 await waitFor(()=>assert.equal(calls.filter(call=>call.method==='PATCH').length,1));
 const rule=JSON.parse(calls.find(call=>call.method==='PATCH').body).config.rules[0];
 assert.equal(rule.strategy,'provider');assert.deepEqual(rule.accountPreference,{mode:'text'});
});
test('activity opens inside the model action tray; pointer exit closes only the tray',async()=>{
 const Row=await component('../../../../shared/components/QuotaModelRow');
 render(React.createElement(Row,{id:'image:one',name:'One',status:'Unknown',measurement:'Unknown',allow:React.createElement('button',null,'Allow one'),actions:React.createElement('button',null,'Test one'),analysis:React.createElement('p',null,'Scoped chart')}));
 const arrow=screen.getByRole('button',{name:'Actions for One'});
 fireEvent.pointerDown(arrow);fireEvent.click(arrow);
 assert.ok(screen.getByRole('group',{name:'Secondary actions for One'}));
 fireEvent.click(screen.getByRole('button',{name:'Activity for One'}));
 assert.ok(screen.getByRole('group',{name:'Secondary actions for One'}));
 assert.equal(screen.getByRole('button',{name:'Activity for One'}).getAttribute('aria-expanded'),'true');
 assert.ok(screen.getByText('Scoped chart'));
 fireEvent.pointerLeave(arrow);
 await waitFor(()=>assert.equal(Boolean(screen.queryByRole('group',{name:'Secondary actions for One'})),false));
 assert.ok(screen.getByText('Scoped chart'));
});
test('text model switch saves one guarded command and retains it after an unknown response',async()=>{
 const Text=await component('TextModelRows'),calls=[];
 globalThis.fetch=async(url,options={})=>{calls.push([url,options]);if(options.method==='PATCH')throw Error('Save unconfirmed');return Response.json({connectionId:'text-one',provider:'codex',revision:2,models:[{id:'gpt-6.1-sol',allowed:true}]});};
 render(React.createElement(Text,{connection:{id:'text-one',provider:'codex',name:'Alpha'},models:[{id:'gpt-6.1-sol',name:'GPT'}],selectedModelIds:['gpt-6.1-sol']}));
 fireEvent.click(screen.getByRole('button',{name:'Actions for GPT'}));
 await waitFor(()=>assert.ok(screen.getByRole('group',{name:'Secondary actions for GPT'})));
 const toggle=await screen.findByRole('switch',{name:'Disable text model gpt-6.1-sol on Alpha'});
 await waitFor(()=>assert.equal(toggle.disabled,false));fireEvent.click(toggle);
 await waitFor(()=>assert.ok(screen.getByRole('alert')));
 fireEvent.click(toggle);await waitFor(()=>assert.equal(calls.filter(([,options])=>options.method==='PATCH').length,2));
 const commands=calls.filter(([,options])=>options.method==='PATCH').map(([,options])=>JSON.parse(options.body));assert.deepEqual(commands[0],commands[1]);assert.equal(commands[0].expectedRevision,2);assert.equal(commands[0].allowed,false);
});
test('each display group has its own corner popup; internal choices and idle time do not dismiss it',async()=>{
 const Overlay=await component('QuotaCardDetailsOverlay');let changes=0;
 const groups=Object.fromEntries(['summary','text','images'].map(key=>[key,{visible:true,choices:[{key:'one',name:key+' one',visible:false,onToggle:()=>changes++}]}]));
 let controls;render(React.createElement(Overlay,{name:'Alpha',groups,controlsRef:value=>{controls=value;},onToggleGroup:()=>changes++}));
 for(const group of ['Summary','Text','Images'])assert.ok(screen.getByRole('button',{name:group+' display options for Alpha'}));
 controls.choose('text');
 await waitFor(()=>assert.equal(document.activeElement.getAttribute('aria-label'),'Hide text for Alpha'));
 const popup=screen.getByRole('group',{name:'Text display options for Alpha'});
 fireEvent.click(screen.getByRole('button',{name:'Show text one'}));fireEvent.click(screen.getByRole('button',{name:'Hide text for Alpha'}));
 assert.equal(changes,2);await new Promise(resolve=>setTimeout(resolve,3100));assert.equal(Boolean(screen.queryByRole('group',{name:'Text display options for Alpha'})),true);
 fireEvent.pointerEnter(popup);fireEvent.pointerDown(popup);fireEvent.pointerMove(document.body);
 await waitFor(()=>assert.equal(Boolean(screen.queryByRole('group',{name:'Text display options for Alpha'})),false));
 controls.choose('images');await screen.findByRole('group',{name:'Images display options for Alpha'});fireEvent.pointerDown(document.body);
 assert.equal(Boolean(screen.queryByRole('group',{name:'Images display options for Alpha'})),false);
});
test('below-card actions reveal their section and list only hidden rows; choosing moves a row into the card',async()=>{
 const Overlay=await component('QuotaCardDetailsOverlay'),revealed=[];
 function Probe(){const[visible,setVisible]=React.useState(false);const groups=Object.fromEntries(['summary','text','images'].map(key=>[key,{visible:false,choices:[{key:'hidden',name:'Hidden model',visible,onToggle:()=>setVisible(true)},{key:'shown',name:'Shown model',visible:true,onToggle:()=>assert.fail('Already shown row must not be offered')}]}]));return React.createElement(Overlay,{name:'Section',groups,onToggleGroup:()=>{},onEnsureGroupVisible:key=>revealed.push(key)});}
 render(React.createElement(Probe));
 fireEvent.click(screen.getByRole('button',{name:'Text display options for Section'}));
 assert.deepEqual(revealed,['text']);assert.ok(screen.getByRole('group',{name:'Text display options for Section'}));
 assert.equal(screen.queryByRole('button',{name:'Show Shown model'}),null);
 fireEvent.click(screen.getByRole('button',{name:'Show Hidden model'}));
 assert.deepEqual(revealed,['text']);assert.equal(screen.queryByRole('button',{name:'Show Hidden model'}),null);
 assert.ok(screen.getByText('All rows are shown.'));assert.ok(screen.getByRole('group',{name:'Text display options for Section'}));
 fireEvent.keyDown(document,{key:'Escape'});assert.equal(screen.queryByRole('group',{name:'Text display options for Section'}),null);
});
test('hover previews expire without a click, while an interacted popup stays open',async()=>{
 const Overlay=await component('QuotaCardDetailsOverlay');
 const groups=Object.fromEntries(['summary','text','images'].map(key=>[key,{visible:true,choices:[]}]));
 render(React.createElement(Overlay,{name:'Hover',groups,onToggleGroup:()=>{}}));
 const trigger=screen.getByRole('button',{name:'Text display options for Hover'});
 fireEvent.pointerEnter(trigger,{pointerType:'mouse'});
 await screen.findByRole('group',{name:'Text display options for Hover'});
 await new Promise(resolve=>setTimeout(resolve,2350));assert.equal(Boolean(screen.queryByRole('group',{name:'Text display options for Hover'})),false);
 fireEvent.pointerEnter(trigger,{pointerType:'mouse'});await screen.findByRole('group',{name:'Text display options for Hover'});
 fireEvent.click(screen.getByRole('button',{name:'Hide text for Hover'}));
 await new Promise(resolve=>setTimeout(resolve,2350));assert.ok(screen.getByRole('group',{name:'Text display options for Hover'}));
 fireEvent.pointerDown(document.body);assert.equal(Boolean(screen.queryByRole('group',{name:'Text display options for Hover'})),false);
});
test('header actions initially align to the end and preserve deliberate horizontal scrolling',async()=>{
 const Actions=await component('../../../../shared/components/QuotaCardActions'),oldObserver=globalThis.ResizeObserver;
 const oldWidth=Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype,'scrollWidth'),oldClient=Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype,'clientWidth');let resize;
 Object.defineProperty(dom.window.HTMLElement.prototype,'scrollWidth',{configurable:true,get(){return 600;}});Object.defineProperty(dom.window.HTMLElement.prototype,'clientWidth',{configurable:true,get(){return 200;}});
 globalThis.ResizeObserver=class{constructor(fn){resize=fn;}observe(){}disconnect(){}};
 try{
  render(React.createElement(Actions,null,React.createElement('button',null,'Enable account')));const node=screen.getByRole('group',{name:'Account actions'});assert.equal(node.scrollLeft,600);
  node.scrollLeft=120;fireEvent.scroll(node);resize();assert.equal(node.scrollLeft,120);
  node.scrollLeft=400;fireEvent.scroll(node);resize();assert.equal(node.scrollLeft,600);
 }finally{cleanup();globalThis.ResizeObserver=oldObserver;for(const [key,descriptor]of [['scrollWidth',oldWidth],['clientWidth',oldClient]]){if(descriptor)Object.defineProperty(dom.window.HTMLElement.prototype,key,descriptor);else delete dom.window.HTMLElement.prototype[key];}}
});
test('compact image test-all reviews only eligible account models before dispatch',async()=>{
 const Batch=await component('ImageTestBatchButton');let modalOpens=0;dom.window.HTMLDialogElement.prototype.showModal=function(){modalOpens++;this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 const row={connectionId:'account-a',provider:'codex',accountLabel:'Alpha',accountEnabled:true,routeState:'eligible_unreported',modelPolicies:[{model:'paused',state:'paused'}]};
 const rows=['ready','paused','held'].map(model=>({account:row,entry:{capabilities:{generation:true}},model}));let calls=0,sent;
 const runner={blockedTargets:[],busy:false,unknown:false,isBlocked:(id,model)=>model==='held',run:async targets=>{calls++;sent=targets;return{id:'synthetic'};}};
 render(React.createElement('dialog',{open:true,'aria-label':'Image management'},React.createElement(Batch,{rows,label:'Test all image models',scope:'Alpha',runner,compact:true})));
 const trigger=screen.getByRole('button',{name:'Test all image models'});fireEvent.pointerDown(trigger,{pointerType:'touch'});fireEvent.pointerUp(trigger,{pointerType:'touch'});fireEvent.click(trigger);assert.equal(calls,0);assert.ok(screen.getByRole('dialog',{name:'Test all image models'}));assert.equal(modalOpens,1);
 const start=screen.getByRole('button',{name:'Start 1'});fireEvent.pointerDown(start,{pointerType:'touch'});fireEvent.pointerUp(start,{pointerType:'touch'});fireEvent.click(start);await waitFor(()=>assert.equal(calls,1));assert.deepEqual(sent.map(row=>[row.connectionId,row.model]),[['account-a','ready']]);
});
afterEach(cleanup);after(()=>dom.window.close());

test('model arrow supports hover opening and testing reveals a scoped live chart',async()=>{
 const Row=await component('../../../../shared/components/QuotaModelRow');
 const view=render(React.createElement(Row,{id:'image:live',name:'Live',measurement:'45%',analysis:React.createElement('p',null,'Live account chart')}));
 fireEvent.pointerEnter(screen.getByRole('button',{name:'Actions for Live'}),{pointerType:'mouse'});
 await screen.findByRole('group',{name:'Secondary actions for Live'});
 view.rerender(React.createElement(Row,{id:'image:live',name:'Live',measurement:'45%',testing:true,analysis:React.createElement('p',null,'Live account chart')}));
 await screen.findByRole('region',{name:'Analysis for Live'});assert.ok(document.querySelector('.quota-model-testing'));
});

test('test-all reveals the running model activity only on its own account and the handle closes it',async()=>{
 const Card=await component('ImageAccountCard');const row={...account,accountEnabled:true,modelPolicies:[],manualPolicy:null};
 globalThis.fetch=async()=>Response.json({});
 const state={catalog:[{id:'m1',provider:'codex',capabilities:{generation:true}}],drafts:{},tests:{job:{items:[{connectionId:'a',model:'m1',state:'running'}]},busy:true,resultFor:(id,model)=>id==='a'&&model==='m1'?{state:'running'}:null}};
 const view=render(React.createElement(Card,{connection:{id:'a',provider:'codex'},row,state,selectedModelIds:[]}));
 const arrow=screen.getByRole('button',{name:'Actions for m1'});await waitFor(()=>assert.equal(arrow.getAttribute('aria-expanded'),'true'));assert.ok(document.querySelector('.quota-model-testing'));
 fireEvent.click(arrow);assert.equal(arrow.getAttribute('aria-expanded'),'false');assert.equal(document.querySelector('.quota-model-chart').classList.contains('is-open'),false);assert.equal(screen.queryByRole('group',{name:'Secondary actions for m1'}),null);
 view.rerender(React.createElement(Card,{connection:{id:'b',provider:'codex'},row:{...row,connectionId:'b'},state,selectedModelIds:[]}));assert.equal(screen.queryByRole('group',{name:'Secondary actions for m1'}),null);assert.equal(document.querySelector('.quota-model-chart')?.classList.contains('is-open')??false,false);
});

test('disabled model measurements dim without disabling recovery controls; action strip remains compact',async()=>{
 const Row=await component('../../../../shared/components/QuotaModelRow');
 render(React.createElement(Row,{id:'text:off',name:'Off model',disabled:true,measurement:'25%',allow:React.createElement('button',null,'Enable model'),actions:React.createElement('button',null,'Advanced action')}));
 assert.ok(document.querySelector('[data-model-disabled="true"].quota-model-disabled'));
 fireEvent.click(screen.getByRole('button',{name:'Actions for Off model'}));
 const strip=document.querySelector('.quota-model-action-strip');assert.ok(strip.contains(screen.getByRole('button',{name:'Enable model'})));fireEvent.click(screen.getByRole('button',{name:'Activity for Off model'}));assert.ok(screen.getByRole('button',{name:'Advanced action'}));
 assert.equal(screen.queryByRole('button',{name:'More actions for Off model'}),null);
 assert.equal(strip.closest('.quota-model-item'),document.querySelector('.quota-model-item'));assert.equal(document.querySelector('.quota-model-actions-panel').parentElement,document.querySelector('.quota-model-bar'));
});

test('compact image test stays guarded by its own confirmation dialog',async()=>{
 const Button=await component('ImageTestButton'),calls=[];
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 const runner={resultFor:()=>null,run:async(...args)=>{calls.push(args);return {};}};
 render(React.createElement(Button,{compact:true,row:{connectionId:'a',accountLabel:'Alpha',provider:'codex',accountEnabled:true,routeState:'eligible_unreported'},model:'image-one',runner}));
 const trigger=screen.getByRole('button',{name:'Test image image-one on Alpha'});fireEvent.pointerDown(trigger,{pointerType:'touch'});fireEvent.pointerUp(trigger,{pointerType:'touch'});fireEvent.click(trigger);
 assert.ok(screen.getByRole('dialog',{name:'Confirm image test'}));assert.equal(calls.length,0);
 const cancel=screen.getByRole('button',{name:'Cancel'});fireEvent.pointerDown(cancel,{pointerType:'touch'});fireEvent.pointerUp(cancel,{pointerType:'touch'});fireEvent.click(cancel);assert.equal(calls.length,0);
 fireEvent.pointerDown(trigger,{pointerType:'touch'});fireEvent.pointerUp(trigger,{pointerType:'touch'});fireEvent.click(trigger);
 fireEvent.change(screen.getByRole('combobox',{name:'Image request count'}),{target:{value:'3'}});
 const run=screen.getByRole('button',{name:'Run 3 requests'});fireEvent.pointerDown(run,{pointerType:'touch'});fireEvent.pointerUp(run,{pointerType:'touch'});fireEvent.click(run);
 await waitFor(()=>assert.equal(calls.length,1));assert.deepEqual(calls[0],[[{connectionId:'a',accountLabel:'Alpha',provider:'codex',model:'image-one'}],null,{requestMode:'count',requestCount:3}]);
 fireEvent.click(trigger);fireEvent.click(screen.getByRole('radio',{name:'Stop at confirmed quota limit'}));
 fireEvent.change(screen.getByRole('combobox',{name:'Confirmed quota limit hits'}),{target:{value:'2'}});
 fireEvent.change(screen.getByRole('combobox',{name:'Maximum image requests'}),{target:{value:'50'}});
 fireEvent.click(screen.getByRole('button',{name:'Stop after 2 quota hits'}));
 await waitFor(()=>assert.equal(calls.length,2));assert.deepEqual(calls[1],[[{connectionId:'a',accountLabel:'Alpha',provider:'codex',model:'image-one'}],null,{requestMode:'until_quota',requestCount:50,quotaLimitHits:2}]);
});

test('card action changes do not rerender sibling cards or the page',async()=>{
 const Interaction=await component('QuotaCardInteraction');let pageRenders=0;const renders=Array(20).fill(0);
 function Page(){pageRenders++;return React.createElement('div',null,...renders.map((_,index)=>React.createElement(Interaction,{key:index},state=>{renders[index]++;return React.createElement('button',{onClick:()=>state.setTray(state.tray?null:'model')},`Card ${index} ${state.tray||'closed'}`);})));}
 render(React.createElement(Page));const before=[...renders];
 fireEvent.click(screen.getByRole('button',{name:'Card 3 closed'}));
 assert.equal(pageRenders,1);assert.equal(renders[3],before[3]+1);assert.deepEqual(renders.filter((_,i)=>i!==3),before.filter((_,i)=>i!==3));
 fireEvent.click(screen.getByRole('button',{name:'Card 3 model'}));assert.equal(pageRenders,1);
});
test('countdown ticks update only the counter and keep a single timer',async()=>{
 Object.defineProperty(document,'hidden',{configurable:true,value:false});
 const Counter=await component('QuotaRefreshCountdown');let pageRenders=0;
 function Page(){pageRenders++;return React.createElement(Counter,{active:true,seconds:60,resetKey:0});}
 const view=render(React.createElement(Page));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1100));});
 assert.ok(screen.getByText('(59s)'));assert.equal(pageRenders,1);
 view.unmount();delete document.hidden;
});
test('unchanged image job polls do not commit another page render',async()=>{
 const useRunner=await component('useImageTestRunner');let commits=0,calls=0;
 globalThis.fetch=async()=>{calls++;return Response.json({schema:'admin_image_tests.v1',run:null,blockedTargets:[]});};
 function Probe(){const state=useRunner(()=>{},[]);return React.createElement('button',{onClick:()=>void state.refresh()},state.statusKnown?'Ready':'Loading');}
 render(React.createElement(React.Profiler,{id:'poll',onRender:()=>commits++},React.createElement(Probe)));
 await waitFor(()=>assert.ok(screen.getByRole('button',{name:'Ready'})));
 const before=commits;
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Ready'}));await new Promise(resolve=>setTimeout(resolve,20));});
 assert.ok(calls>=2);assert.equal(commits,before);
});
test('checking an earlier held result reports unresolved evidence and never dispatches generation',async()=>{
 const useRunner=await component('useImageTestRunner'),calls=[];
 const old={id:'old',state:'cancelled',revision:2,items:[{state:'unknown'}]},blocked=[{runId:'old',connectionId:'a',model:'m1'}];
 let confirmed=false;
 globalThis.fetch=async(url,options={})=>{
  calls.push({url,method:options.method||'GET'});
  if(options.method==='PATCH')return Response.json({schema:'admin_image_tests.v1',run:confirmed?{...old,revision:3,items:[{state:'succeeded'}]}:old,blockedTargets:confirmed?[]:blocked});
  return Response.json({schema:'admin_image_tests.v1',run:url.includes('?id=')?old:null,blockedTargets:confirmed?[]:blocked});
 };
 function Probe(){const state=useRunner(()=>{},[]);return React.createElement('div',null,React.createElement('button',{disabled:!state.statusKnown||!!state.checkingHeld,onClick:()=>state.reconcileHeld('old')},'Check'),React.createElement('p',null,state.recoveryNotice));}
 render(React.createElement(Probe));await waitFor(()=>assert.equal(screen.getByRole('button',{name:'Check'}).disabled,false));
 fireEvent.click(screen.getByRole('button',{name:'Check'}));
 await waitFor(()=>assert.ok(screen.getByText('1 result is still unconfirmed. No new request sent.')));
 confirmed=true;fireEvent.click(screen.getByRole('button',{name:'Check'}));
 await waitFor(()=>assert.ok(screen.getByText('Saved result confirmed. Recovery hold cleared.')));
 assert.equal(calls.some(call=>call.method==='POST'),false);
 assert.equal(calls.filter(call=>call.method==='PATCH').length,2);
});
test('blocked batch controls offer local recovery and closing never dispatches another test',async()=>{
 const Batch=await component('ImageTestBatchButton');let starts=0,checks=0,closes=0;
 const job={id:'held-run',state:'needs_review',revision:1,items:[{state:'succeeded',model:'done'},{state:'unknown',model:'held'}]};
 function Probe(){const[closed,setClosed]=React.useState(false);const runner={job:{...job,state:closed?'cancelled':'needs_review'},statusKnown:true,busy:false,unknown:!closed,blockedTargets:[{runId:job.id,connectionId:'a',model:'held'}],isBlocked:()=>false,run:()=>starts++,refresh:()=>{},reconcile:()=>checks++,close:()=>{closes++;setClosed(true);}};return React.createElement(Batch,{rows:[{account:{connectionId:'a',provider:'codex',accountLabel:'Alpha',accountEnabled:true},entry:{capabilities:{generation:true}},model:'ready'}],runner,label:'Test models',scope:'Alpha'});}
 render(React.createElement('dialog',{open:true,'aria-label':'Image management'},React.createElement(Probe)));assert.equal(screen.queryByRole('button',{name:/Test models/}),null);
 const review=screen.getByRole('button',{name:/Review run/});assert.equal(review.disabled,false);fireEvent.pointerDown(review,{pointerType:'touch'});fireEvent.pointerUp(review,{pointerType:'touch'});fireEvent.click(review);assert.ok(screen.getByRole('dialog',{name:'Review image test run'}));
 const reconcile=screen.getByRole('button',{name:'Check saved result'});fireEvent.pointerDown(reconcile,{pointerType:'touch'});fireEvent.pointerUp(reconcile,{pointerType:'touch'});fireEvent.click(reconcile);assert.equal(checks,1);
 const closeRun=screen.getByRole('button',{name:'Release batch'});fireEvent.pointerDown(closeRun,{pointerType:'touch'});fireEvent.pointerUp(closeRun,{pointerType:'touch'});fireEvent.click(closeRun);assert.equal(closes,1);assert.equal(starts,0);
 assert.equal(screen.getByRole('button',{name:/Test models/}).disabled,false);assert.ok(screen.getByText(/This account\/model stay blocked/));
 const dismiss=screen.getByRole('button',{name:'Close run review'});fireEvent.pointerDown(dismiss,{pointerType:'touch'});fireEvent.pointerUp(dismiss,{pointerType:'touch'});fireEvent.click(dismiss);assert.equal(screen.queryByRole('dialog',{name:'Review image test run'}),null);
});
test('unavailable status opens refresh recovery without offering to clear a hold',async()=>{
 const Recovery=await component('ImageTestRunRecovery');let refreshes=0;
 render(React.createElement(Recovery,{runner:{unknown:true,statusKnown:false,job:null,error:'Status unavailable',refresh:()=>refreshes++}}));
 fireEvent.click(screen.getByRole('button',{name:'Review run'}));fireEvent.click(screen.getByRole('button',{name:'Recheck'}));assert.equal(refreshes,1);
 assert.equal(screen.queryByRole('button',{name:'Release batch'}),null);
});

test('compact image percentages fit the row while meters retain precise reported and estimated values',async()=>{
 const Group=await component('ImageCardModelGroup');const value=99.993336;
 const props={connection:{id:'a',provider:'codex'},row:{connectionId:'a',providerUsageEvidence:{observedAt:new Date().toISOString(),windows:[{scope:'image',model:'img',remainingPercentage:value}]}},modelRows:[{model:'img'}],state:{catalog:[],drafts:{}}};
 const view=render(React.createElement(Group,props));assert.ok(screen.getByText('100%'));assert.equal(screen.getByRole('meter').getAttribute('aria-valuenow'),String(value));assert.equal(screen.getByText('100%').getAttribute('title'),`${value}%`);
 view.rerender(React.createElement(Group,{...props,row:{connectionId:'a'},modelRows:[{model:'img',estimate:{state:'estimated',remainingPercentage:value}}]}));assert.ok(screen.getByText('~100%'));assert.equal(screen.getByRole('meter').getAttribute('aria-valuenow'),String(value));
});

test('a reveal picker follows its parent card when newly shown rows expand the card',async()=>{
 const Overlay=await component('QuotaCardDetailsOverlay');const previous=globalThis.ResizeObserver,rect=dom.window.HTMLElement.prototype.getBoundingClientRect,observed=new Map();let top=100;
 globalThis.ResizeObserver=class{constructor(fn){this.fn=fn;}observe(node){observed.set(node,this.fn);}disconnect(){}};
 dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {left:10,top:this.matches('.quota-card-details-trigger')?top:0,bottom:this.matches('.quota-card-details-trigger')?top+22:80,width:360,height:80,right:370};};
 try{const groups=Object.fromEntries(['summary','text','images'].map(key=>[key,{visible:true,choices:[]}]));render(React.createElement('div',{className:'quota-account-card-stack'},React.createElement(Overlay,{name:'Growing',groups,onToggleGroup:()=>{}})));
 fireEvent.click(screen.getByRole('button',{name:'Images display options for Growing'}));const tray=screen.getByRole('group',{name:'Images display options for Growing'});assert.equal(tray.style.top,'126px');
 const owner=document.querySelector('.quota-account-card-stack');assert.ok(observed.has(owner));top=200;act(()=>observed.get(owner)());assert.equal(tray.style.top,'226px');
 }finally{dom.window.HTMLElement.prototype.getBoundingClientRect=rect;globalThis.ResizeObserver=previous;}
});

test('hover-open strip survives pointer transfer and its handle closes the row panels',async()=>{
 const Row=await component('../../../../shared/components/QuotaModelRow');
 render(React.createElement(Row,{id:'hover',name:'Hover',measurement:'45%',actions:React.createElement('p',null,'Detailed evidence')}));
 const arrow=screen.getByRole('button',{name:'Actions for Hover'});
 fireEvent.pointerEnter(arrow,{pointerType:'mouse'});
 const panel=await screen.findByRole('group',{name:'Secondary actions for Hover'});
 fireEvent.pointerLeave(arrow,{relatedTarget:panel});fireEvent.pointerEnter(panel);
 await new Promise(resolve=>setTimeout(resolve,300));
 assert.equal(arrow.getAttribute('aria-expanded'),'true');
 assert.equal(panel.parentElement,arrow.closest('.quota-model-bar'));
 assert.equal(panel.textContent.includes('Detailed evidence'),false);
 fireEvent.click(arrow);assert.equal(arrow.getAttribute('aria-expanded'),'false');
 assert.equal(screen.queryByRole('group',{name:'Secondary actions for Hover'}),null);
 fireEvent.keyDown(document,{key:'Escape'});
 assert.equal(arrow.getAttribute('aria-expanded'),'false');
});

test('row handle closes both its action strip and expanded activity',async()=>{
 const Row=await component('../../../../shared/components/QuotaModelRow');
 render(React.createElement(Row,{id:'activity-row',name:'Activity row',analysis:React.createElement('p',null,'Activity details')}));
 const arrow=screen.getByRole('button',{name:'Actions for Activity row'});
 fireEvent.click(arrow);assert.equal(arrow.getAttribute('aria-expanded'),'true');
 const activity=screen.getByRole('button',{name:'Activity for Activity row'});
 fireEvent.click(activity);assert.equal(activity.getAttribute('aria-expanded'),'true');
 fireEvent.click(arrow);assert.equal(arrow.getAttribute('aria-expanded'),'false');
 assert.equal(activity.getAttribute('aria-expanded'),'false');
 assert.equal(document.querySelector('.quota-model-chart').classList.contains('is-open'),false);
});

test('row handle closes activity opened automatically during a test run',async()=>{
 const Row=await component('../../../../shared/components/QuotaModelRow');
 render(React.createElement(Row,{id:'testing-row',name:'Testing row',testing:true,analysis:React.createElement('p',null,'Live activity')}));
 const arrow=screen.getByRole('button',{name:'Actions for Testing row'});
 await waitFor(()=>assert.equal(arrow.getAttribute('aria-expanded'),'true'));
 assert.equal(screen.queryByRole('group',{name:'Secondary actions for Testing row'}),null);
 fireEvent.click(arrow);
 assert.equal(arrow.getAttribute('aria-expanded'),'false');
 assert.equal(document.querySelector('.quota-model-chart').classList.contains('is-open'),false);
});

test('compact activity keeps the plot and populated outcomes without a duplicate request timeline',async()=>{
 const Chart=await component('ImageActivityChart','ActivityChart');
 const data={range:{from:'2026-11-08T00:00:00Z',to:'2026-11-09T00:00:00Z'},buckets:[{from:'2026-11-08T00:00:00Z',to:'2026-11-09T00:00:00Z',counts:{dispatches:2,succeeded:2}}],events:{items:[{dispatchedAt:'2026-11-08T01:00:00Z',outcome:'succeeded',model:'m'}]}};
 render(React.createElement(Chart,{insights:data,compact:true}));
 assert.ok(screen.getByRole('img',{name:'Image submission outcomes over time'}));
 assert.ok(screen.getByText('Succeeded'));assert.equal(screen.queryByText('Quota limit'),null);
 assert.equal(screen.queryByLabelText('Recent request timeline'),null);
});
test('image activity keeps secondary controls inside its single info disclosure',async()=>{
 const Activity=await component('ImageModelActivity');
 globalThis.fetch=async()=>Response.json({schema:'image_quota_insights.v1',scope:{connectionId:'a',provider:'codex',model:'m',kind:'credential'},buckets:[],counts:{dispatches:0,images:0,outcome_unknown:0}});
 render(React.createElement(Activity,{connection:{id:'a',provider:'codex'},model:'m',context:React.createElement('button',null,'Settings')}));
 await screen.findByText('No recorded calls in this range.');
 const info=screen.getByText('Recorded activity').closest('details');
 assert.equal(info.open,false);assert.ok(info.contains(screen.getByText('Settings')));
 fireEvent.click(screen.getByText('Recorded activity'));
 assert.equal(info.open,true);
 assert.equal(screen.queryByText('Provider snapshot'),null);
});

test('unreported rows start collapsed, open anywhere on hover and dismiss on exit',async()=>{
 const Row=await component('../../../../shared/components/QuotaModelRow');let hidden=0;
 render(React.createElement(Row,{id:'unknown',name:'Unknown quota',measurement:'Unreported',onHide:()=>hidden++}));
 const row=document.querySelector('.quota-model-item');
 assert.equal(Boolean(screen.queryByRole('group',{name:'Secondary actions for Unknown quota'})),false);
 fireEvent.pointerEnter(row,{pointerType:'mouse'});
 await screen.findByRole('group',{name:'Secondary actions for Unknown quota'});
 assert.equal(Boolean(screen.queryByRole('button',{name:'Close actions for Unknown quota'})),false);
 fireEvent.click(screen.getByRole('button',{name:'Hide Unknown quota'}));assert.equal(hidden,1);
 fireEvent.pointerLeave(row,{pointerType:'mouse',relatedTarget:document.body});
 await waitFor(()=>assert.equal(Boolean(screen.queryByRole('group',{name:'Secondary actions for Unknown quota'})),false));
 fireEvent.click(screen.getByRole('button',{name:'Actions for Unknown quota'}));
 assert.ok(screen.getByRole('group',{name:'Secondary actions for Unknown quota'}));
 fireEvent.pointerDown(document.body);assert.equal(Boolean(screen.queryByRole('group',{name:'Secondary actions for Unknown quota'})),false);
});
test('card-opened image rotation escapes a hidden inert filter dock',async()=>{
 const Management=await component('ImageManagementDialog'),control={current:null};
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
 const view=render(React.createElement('div',{inert:true,style:{pointerEvents:'none',visibility:'hidden'}},React.createElement(Management,{controlsRef:control,state:{}})));
 act(()=>control.current.openRotation('codex'));
 const dialog=screen.getByRole('dialog',{name:'Image management'});assert.equal(dialog.parentElement===document.body,true);
 assert.equal(Boolean(dialog.closest('[inert]')),false);
 const input=screen.getByRole('textbox',{name:'Rotation input'});fireEvent.change(input,{target:{value:'works'}});assert.equal(input.value,'works');
 view.unmount();assert.equal(document.querySelector('dialog'),null);
});

test('a reported retry time remains visible even without a quota percentage',async()=>{
 const Group=await component('ImageCardModelGroup');
 render(React.createElement(Group,{connection:{id:'retry-a',provider:'codex'},row:{connectionId:'retry-a'},state:{catalog:[],drafts:{}},modelRows:[{model:'retry-model',wait:{at:new Date(Date.now()+3600000).toISOString(),source:'provider'}}]}));
 assert.ok(screen.getByRole('button',{name:'Actions for retry-model'}));
 assert.equal(Boolean(screen.queryByRole('group',{name:'Secondary actions for retry-model'})),false);
});


test('display transitions commit once and respect reduced motion or unsupported browsers',async()=>{
 const transition=await component('../../../../shared/utils/quotaDisplayTransition','quotaDisplayTransition');let calls=0;
 window.matchMedia=()=>({matches:false});
 transition(()=>calls++);assert.equal(calls,1);
 let animations=0;document.startViewTransition=update=>{animations++;update();return {finished:Promise.resolve()};};
 transition(()=>calls++);assert.equal(calls,2);assert.equal(animations,1);
 await waitFor(()=>assert.equal(document.documentElement.classList.contains('quota-display-transition'),false));
 window.matchMedia=()=>({matches:true});transition(()=>calls++);assert.equal(calls,3);assert.equal(animations,1);
 delete document.startViewTransition;
});

test('automation refresh updates status without replacing an unsaved rotation draft',async()=>{
 const Routing=await component('ImageRouting'),interval=globalThis.setInterval,clear=globalThis.clearInterval;let poll;
 globalThis.setInterval=(fn,ms)=>ms===30000?(poll=fn,{monitor:true}):interval(fn,ms);
 globalThis.clearInterval=id=>{if(!id?.monitor)clear(id);};
 let unavailable=false,heartbeatAge=0,serverSkew=0;
 globalThis.fetch=async(url,options={})=>{
  if(String(url).includes('view=automation')){if(unavailable)throw Error('offline');return Response.json({schema:'rotation_automation.v1',automation:{quotaReads:{configured:true,running:true,heartbeatAt:Date.now()-serverSkew-heartbeatAge,checkedAt:Date.now()-serverSkew,cadenceMs:60000}}});}
  return Response.json({schema:'image_routing.v1',revision:'a'.repeat(64),config:{version:1,rules:[]},automation:{quotaReads:{configured:false,running:false,checkedAt:Date.now()}}});
 };
 try{
  render(React.createElement(Routing,{state:{catalog:[]}}));
  assert.ok(screen.getByText('Automation · Checking status'));
  await waitFor(()=>assert.equal(screen.getByRole('combobox',{name:'Image rotation settings'}).value,'provider'));
  fireEvent.change(screen.getByRole('combobox',{name:'Image rotation settings'}),{target:{value:'custom'}});
  fireEvent.change(screen.getByRole('spinbutton',{name:'Sticky image requests'}),{target:{value:'7'}});
  assert.equal(typeof poll,'function');await act(async()=>{await poll();});
  assert.ok(screen.getByText('Automation · Quota reads running'));
  assert.equal(screen.getByRole('spinbutton',{name:'Sticky image requests'}).value,'7');
  heartbeatAge=600000;await act(async()=>{await poll();});assert.ok(screen.getByText('Automation · Quota reads delayed'));
  heartbeatAge=0;serverSkew=86400000;await act(async()=>{await poll();});assert.ok(screen.getByText('Automation · Quota reads running'));
  unavailable=true;await act(async()=>{await poll();});
  assert.ok(screen.getByText('Automation · Status unavailable'));
  assert.equal(screen.getByRole('combobox',{name:'Image rotation settings'}).value,'custom');
 }finally{cleanup();globalThis.setInterval=interval;globalThis.clearInterval=clear;}
});

test('historical unresolved results have dated inspection, scoped explanation and no generation action',async()=>{
 const Progress=await component('ImageRunProgress');let inspected=0,checked=0;
 const runner={job:{id:'current',state:'completed',items:[{state:'succeeded'}]},blockedTargets:[{runId:'old',connectionId:'a',model:'m',accountLabel:'Alpha',createdAt:'2026-11-02T19:09:15Z'}],heldReviews:{old:{checked:true,unresolved:1,evidence:[{operationId:'op',evidence:'outcome_unknown',httpStatus:200}]}},inspectHeld:()=>inspected++,reconcileHeld:()=>checked++};
 render(React.createElement(Progress,{runner,controls:true}));
 assert.ok(screen.getByText('1 historical unresolved request'));
 fireEvent.click(screen.getByRole('button',{name:'Inspect saved request for Alpha · m'}));assert.equal(inspected,1);
 assert.ok(screen.getByText(/Request was sent; output was not confirmed. HTTP 200/));
 assert.ok(screen.getByText(/Only the listed account\/model pairs are held/));
 assert.ok(document.querySelector('time[datetime="2026-11-02T19:09:15Z"]'));
 fireEvent.click(screen.getByRole('button',{name:'Check saved results for Alpha · m'}));assert.equal(checked,1);
 assert.equal(screen.queryByText('Retry generation'),null);
});

test('inspect historical request is a bounded read and leaves current run unchanged',async()=>{
 const useRunner=await component('useImageTestRunner'),calls=[];
 const current={id:'current',state:'completed',revision:1,items:[{state:'succeeded',connectionId:'a',provider:'codex',model:'m'}]},old={id:'old',state:'cancelled',revision:2,items:[{state:'unknown'}]},blocked=[{runId:'old',connectionId:'a',model:'m'}];
 globalThis.fetch=async(url,options={})=>{calls.push({url,method:options.method||'GET'});return Response.json({schema:'admin_image_tests.v1',run:String(url).includes('?id=')?old:current,blockedTargets:blocked,recovery:[{operationId:'op',evidence:'outcome_unknown',httpStatus:200}]});};
 function Probe(){const state=useRunner(()=>{},[]);return React.createElement('div',null,React.createElement('button',{onClick:()=>state.inspectHeld('old')},'Inspect'),React.createElement('p',null,state.job?.id),React.createElement('p',null,state.heldReviews.old?.evidence[0]?.evidence));}
 render(React.createElement(Probe));await waitFor(()=>assert.ok(screen.getByText('current')));
 fireEvent.click(screen.getByRole('button',{name:'Inspect'}));await waitFor(()=>assert.ok(screen.getByText('outcome_unknown')));
 assert.ok(screen.getByText('current'));assert.ok(calls.every(call=>call.method==='GET'));
});

test('segment separators reveal division details on hover, pin by click and dismiss accessibly',async()=>{
 const Segment=await component('QuotaSegmentBar');
 const boundary={mode:'gap',label:'Weekly left %',kind:'remaining',direction:'desc',min:20,max:80,missing:0,gap:{size:30,from:20,to:50}};
 const segment={key:'ready-1',availability:'ready',rotationName:'Ready · Group 1',connections:[{id:'one'}],boundaries:[boundary]};
 const navigate=[];
 const view=render(React.createElement(Segment,{segment,index:0,total:2,next:'ready-2',onNavigate:key=>navigate.push(key)}));
 const button=screen.getByRole('button',{name:'Ready · Group 1, 1 account, show division details'});
 const root=button.closest('.quota-segment-bar');
 assert.equal(root.dataset.depth,'0');
 assert.equal(screen.queryByRole('region'),null);
 fireEvent.mouseEnter(root);
 assert.ok(screen.getByRole('region',{name:'Division details for Ready · Group 1'}));
 fireEvent.mouseLeave(root);
 assert.equal(screen.queryByRole('region'),null);
 fireEvent.click(button);fireEvent.mouseLeave(root);
 assert.equal(button.getAttribute('aria-expanded'),'true');
 fireEvent.keyDown(button,{key:'Escape'});
 assert.equal(screen.queryByRole('region'),null);
 assert.equal(document.activeElement,button);
 fireEvent.click(button);fireEvent.pointerDown(document.body);
 assert.equal(screen.queryByRole('region'),null);
 fireEvent.focus(button);
 assert.ok(screen.getByRole('region'));
 fireEvent.click(screen.getByRole('button',{name:'Next segment: ready-2'}));
 assert.deepEqual(navigate,['ready-2']);
 view.unmount();
});

test('nested segment separators reflect the first changed division level',async()=>{
 const Segment=await component('QuotaSegmentBar');
 const first={mode:'half',label:'Weekly left %',kind:'remaining',direction:'desc',min:40,max:90,startRank:1,endRank:4,parentCount:8};
 const second={...first,label:'Short window left %',min:50,max:80};
 const previousSegment={availability:'ready',boundaries:[first,second]};
 const segment={key:'regular.1.2',availability:'ready',rotationName:'Ready · Group 2',connections:[{id:'one'}],boundaries:[first,{...second,min:10,max:30}]};
 render(React.createElement(Segment,{segment,previousSegment,index:1,total:2,onNavigate:()=>{}}));
 const button=screen.getByRole('button',{name:'Ready · Group 2, 1 account, show division details'});
 assert.equal(button.closest('.quota-segment-bar').dataset.depth,'2');
 assert.match(button.textContent,/Group 2/);
 assert.doesNotMatch(button.textContent,/Ready/);
 fireEvent.click(button);
 assert.ok(screen.getByLabelText('Sort level 1'));
 assert.ok(screen.getByLabelText('Sort level 2'));
});
