import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const directory = mkdtempSync(path.join(tmpdir(), 'pocket-live-'));
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: 'public-web-mcp-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp-server.js')], env: { ...process.env, POCKET_DATA_DIR: directory }, stderr: 'pipe' });
const call = async (name, args = {}) => {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, response.content?.[0]?.text);
  return response.structuredContent;
};
try {
  await client.connect(transport);
  console.log(`Discovered ${(await client.listTools()).tools.length} MCP tools.`);
  for (const engine of ['http', 'browser']) {
    let run = await call('call-actor', { actorId: 'text', input: { urls: ['https://example.com'], maxPages: 1, engine }, waitSeconds: 20 });
    for (let attempt = 0; ['queued', 'running'].includes(run.status) && attempt < 3; attempt++) run = await call('get-actor-run', { runId: run.id, waitSeconds: 20 });
    if (run.status !== 'succeeded') console.error(JSON.stringify(await call('get-run-log', { runId: run.id })));
    assert.equal(run.status, 'succeeded');
    const dataset = await call('get-dataset-items', { datasetId: run.defaultDatasetId });
    assert.equal(dataset.items[0].title, 'Example Domain');
    console.log(`${engine}: MCP call-actor -> get-dataset-items -> Example Domain, ${dataset.count} row.`);
  }
} finally { await client.close(); rmSync(directory, { recursive: true, force: true }); }
