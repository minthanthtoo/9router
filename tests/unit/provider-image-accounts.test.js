import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({connections:vi.fn(),backfill:vi.fn()}));
vi.mock('next/server',()=>({NextResponse:{json:(body,init={})=>new Response(JSON.stringify(body),init)}}));
vi.mock('@/lib/localDb',()=>({getProviderConnections:mocks.connections}));
vi.mock('@/lib/oauth/providers',()=>({backfillCodexEmails:mocks.backfill}));
vi.mock('@/shared/constants/providers',()=>({USAGE_SUPPORTED_PROVIDERS:['antigravity','codex'],USAGE_APIKEY_PROVIDERS:[]}));
import {GET} from '../../src/app/api/providers/client/route.js';
describe('image-only account visibility',()=>{
 beforeEach(()=>{mocks.connections.mockResolvedValue([
  {id:'oauth',provider:'antigravity',authType:'oauth',isActive:true},
  {id:'gemini-api',provider:'gemini',authType:'api-key',apiKey:'never-return-this',isActive:true},
  {id:'other-api',provider:'unknown',authType:'api-key',apiKey:'never-return-this'},
 ]);});
 it('retains the existing usage-client account selection by default',async()=>{
  const r=await GET(new Request('http://localhost/api/providers/client'));const j=await r.json();
  expect(j.connections.map(c=>c.id)).toEqual(['oauth']);
 });
 it('adds image-supported accounts only when explicitly requested without credentials',async()=>{
  const r=await GET(new Request('http://localhost/api/providers/client?includeImageAccounts=true'));const j=await r.json();
  expect(j.connections.map(c=>c.id)).toEqual(['oauth','gemini-api']);
  expect(j.providerOptions).toContain('gemini');
  expect(JSON.stringify(j)).not.toContain('never-return-this');
 });
});
