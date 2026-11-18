import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FORMATS } from '../../open-sse/translator/formats.js';

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'capacity-completion-'));
process.env.DATA_DIR = fixtureDirectory;
after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));
const { createSSEStream } = await import('../../open-sse/utils/stream.js');

async function completion(content, finishReason) {
  const choice = { delta: { content }, ...(finishReason && { finish_reason: finishReason }) };
  const chunk = { choices: [choice], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.close();
    },
  });
  const reports = [];
  const output = await new Response(source.pipeThrough(createSSEStream({
    mode: 'passthrough',
    targetFormat: FORMATS.OPENAI,
    sourceFormat: FORMATS.OPENAI,
    onStreamComplete: report => reports.push(report),
  }))).text();
  assert.equal(reports.length, 1);
  assert.ok(output.includes(JSON.stringify(choice)));
  assert.ok(output.endsWith('data: [DONE]\n\n'));
  return Boolean(reports[0].reportedCompletion);
}

test('does not learn from a partial EOF, even when usage is present', async () => {
  assert.equal(await completion('partial'), false);
});

test('marks provider-reported completion without changing stream output', async () => {
  assert.equal(await completion('done', 'stop'), true);
});
