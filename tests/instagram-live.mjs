// Opt-in live test: node tests/instagram-live.mjs <Instagram URL> [maxPosts]
// Uses the normal local data directory so results remain available to both clients.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const client = new Client({ name: 'instagram-live-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp-server.js', import.meta.url))], env: { ...process.env }, stderr: 'pipe' });
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent;
}
try {
  await client.connect(transport);
  let job = await call('analyze-instagram', { url: process.argv[2], maxPosts: Number(process.argv[3] || 30), waitSeconds: 1 });
  console.log(JSON.stringify({ runId: job.id, status: job.status }));
  while (['queued', 'running'].includes(job.status)) {
    job = await call('get-actor-run', { runId: job.id, waitSeconds: 20 });
    const log = await call('get-run-log', { runId: job.id, limit: 1 });
    console.log(JSON.stringify({ status: job.status, rows: job.rowCount, last: log.logs.at(-1)?.message }));
  }
  const report = await call('get-instagram-analysis', { runId: job.id });
  console.log(JSON.stringify(report, null, 2));
  if (job.status === 'failed') process.exitCode = 1;
} finally { await client.close(); }
