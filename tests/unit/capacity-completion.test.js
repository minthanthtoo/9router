import { expect, it, vi } from "vitest";
import { createSSEStream } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async()=>{}), saveUsageHistory: vi.fn(async()=>{}) }));
async function completion(chunks) {
  const done=vi.fn();
  const source=new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));c.close();}});
  await new Response(source.pipeThrough(createSSEStream({mode:"passthrough",targetFormat:FORMATS.OPENAI,sourceFormat:FORMATS.OPENAI,onStreamComplete:done}))).text();
  return Boolean(done.mock.calls[0][0].reportedCompletion);
}
it("does not learn from a partial EOF, even when usage is present", async()=>{
  expect(await completion([{choices:[{delta:{content:"partial"}}],usage:{prompt_tokens:10,completion_tokens:2}}])).toBe(false);
});
it("marks provider-reported completion without changing stream output",async()=>{
  expect(await completion([{choices:[{delta:{content:"done"},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:2}}])).toBe(true);
});
