import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = path.join(root, 'connections');
const command = process.execPath;
const entry = path.join(root, 'mcp-server.js');
mkdirSync(directory, { recursive: true });
const desktop = { mcpServers: { 'pocket-crawler': { command, args: [entry] } } };
writeFileSync(path.join(directory, 'claude-desktop.json'), JSON.stringify(desktop, null, 2));
writeFileSync(path.join(directory, 'codex.toml'), `[mcp_servers.pocket-crawler]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(entry)}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 60\n`);
const psQuote = value => `'${value.replaceAll("'", "''")}'`;
const commands = [
  `codex mcp add pocket-crawler -- ${psQuote(command)} ${psQuote(entry)}`,
  `claude mcp add --scope user --transport stdio pocket-crawler -- ${psQuote(command)} ${psQuote(entry)}`,
].join('\n');
writeFileSync(path.join(directory, 'register.ps1'), commands + '\n', 'utf8');
console.log(`Connection snippets generated in ${directory}\n\n${commands}\n\nNo client settings were changed. Run the commands to register the server. Merge only the pocket-crawler entry when using an existing desktop JSON config.`);
