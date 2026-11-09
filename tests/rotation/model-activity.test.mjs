import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const sqlite=new DatabaseSync(':memory:');
const db={driver:'node:sqlite',all:(sql,params=[])=>sqlite.prepare(sql).all(...params)};
globalThis._dbAdapter={instance:db,initPromise:null,logged:true};
sqlite.exec('CREATE TABLE usageHistory(timestamp TEXT,provider TEXT,model TEXT,connectionId TEXT,promptTokens INTEGER,completionTokens INTEGER)');
const {readModelActivity}=await import('../../src/lib/db/repos/modelActivityRepo.js');
const now=Date.parse('2026-11-07T06:00:00Z'),conn={id:'one',provider:'codex'};
const insert=(account,provider,model,at)=>sqlite.prepare('INSERT INTO usageHistory VALUES(?,?,?,?,?,?)').run(new Date(at).toISOString(),provider,model,account,12,3);
insert('one','codex','gpt-6.1',now-60000);
insert('one','codex','cx/gpt-6.1',now-3600000);
insert('two','codex','gpt-6.1',now-60000);
insert('one','codex','gpt-5.5',now-60000);
insert('one','codex','gpt-6.1',now+60000);
insert('one','codex','gpt-6.1',now-2*86400000);
test('activity is exact account/model scope with bounded aggregates and no request content',async()=>{
 const data=await readModelActivity(conn,'gpt-6.1','24h',now);
 assert.equal(data.requests,2);assert.equal(data.promptTokens,24);assert.equal(data.completionTokens,6);
 assert.equal(data.buckets.length,25);assert.equal(data.buckets.reduce((n,row)=>n+row.requests,0),2);
 assert.equal(data.scope.connectionId,'one');assert.equal(data.coverage,'retained_usage_history');
 assert.ok(!JSON.stringify(data).includes('prompt"'));assert.ok(data.buckets.every(row=>Object.keys(row).length===4));
});
test('activity periods are validated and query size stays bounded',async()=>{
 await assert.rejects(readModelActivity(conn,'gpt-6.1','all',now),TypeError);
 assert.equal((await readModelActivity(conn,'gpt-6.1','1h',now)).buckets.length,13);
 assert.equal((await readModelActivity(conn,'gpt-6.1','7d',now)).buckets.length,29);
});
test.after(()=>sqlite.close());
