import { realpath, stat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseSession } from './parser.ts';
import { analyze } from './analysis.ts';
import { renderReport } from './report.ts';

export async function main(args: string[]): Promise<void> {
  if (args.includes('--help') || args.length === 0) { console.log('ContextLens — local Codex rollout profiler\nUsage: npm start -- SESSION.jsonl --out REPORT.html [--share-safe]\nOutput must be a new file. Input is never modified. Node >=22.18.'); return; }
  const input = args[0]; let output = '', safe = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--out' && args[i+1]) output = args[++i];
    else if (args[i] === '--share-safe') safe = true;
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (!output) throw new Error('Specify --out REPORT.html.');
  const source = await realpath(input);
  if (!(await stat(source)).isFile()) throw new Error('Input must be a regular file.');
  const existingOutput = await realpath(output).catch(() => resolve(output));
  if (existingOutput === source) throw new Error('Output cannot replace the input.');
  const parsed = await parseSession(source);
  const html = renderReport(analyze(parsed), safe);
  // Exclusive creation also blocks symlinks, existing reports and input hard links.
  const file = await open(output, 'wx', 0o600);
  try { await file.writeFile(html); } finally { await file.close(); }
  console.log(`Saved ${safe ? 'share-safe' : 'private'} report. ${parsed.events.length} events, ${parsed.skipped} skipped records, ${parsed.warnings.length} diagnostics.${parsed.limited ? ' Partial analysis: limits reached.' : ''}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(`ContextLens: ${error.message}`); process.exitCode = 1; });
