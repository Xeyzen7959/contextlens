import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export type Event = { id: number; line: number; time?: string; kind: 'tool' | 'instruction' | 'message'; tool?: string; command?: string; cwd?: string; text: string; chars: number; hash: string; readHash?: string; failed?: boolean; read?: string; scope?: string };
export type Session = { events: Event[]; warnings: string[]; lines: number; skipped: number; limited: boolean };
const MAX_RECORD = 4 * 1024 * 1024;
const MAX_EVENTS = 20000;
const MAX_EXCERPT = 4000;
function textContent(value: unknown): string {
  const pending: unknown[] = [value], parts: string[] = [];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string') { if (next) parts.push(next); continue; }
    if (Array.isArray(next)) { for (let i = next.length - 1; i >= 0; i--) pending.push(next[i]); continue; }
    if (next && typeof next === 'object') {
      const v = next as Record<string, unknown>;
      if (v.type !== undefined && (typeof v.type !== 'string' || !['input_text', 'output_text', 'text'].includes(v.type))) continue;
      // Structured content contains text plus metadata; count the text once.
      if (typeof v.text === 'string') pending.push(v.text);
      else if (v.content !== undefined) pending.push(v.content);
      else if (v.output !== undefined) pending.push(v.output);
    }
  }
  return parts.join('\n');
}
function fileRead(command: string): { read: string; scope: string } | undefined {
  // shortcut: conservative single-file commands only; add a shell parser before supporting shell composition.
  const match = command.match(/^\s*(cat|head|tail|sed)\s+((?:-[A-Za-z0-9]+\s+)*(?:'[^']*'\s+)?)(?:"([^"$`]+)"|'([^']+)'|([^\s;&|<>$`]+))\s*$/);
  if (!match) return;
  const options = match[2].trim();
  if (match[1] === 'cat' && options) return;
  if (['head', 'tail'].includes(match[1]) && options && !/^-(?:n\d+|\d+)$/.test(options)) return;
  if (match[1] === 'sed' && !/^-n\s+'\d+(?:,\d+)?p'$/.test(options)) return;
  const path = match[3] || match[4] || match[5];
  if (!path || path.startsWith('-') || /[*?\[\]{}~]/.test(path)) return;
  return { read: path, scope: command.trim() };
}
export async function parseSession(path: string, options: { maxRecordBytes?: number; maxEvents?: number } = {}): Promise<Session> {
  const result: Session = { events: [], warnings: [], lines: 0, skipped: 0, limited: false };
  const calls = new Map<string, { tool: string; command: string; cwd: string; read?: string; scope?: string }>();
  let cwd = '(working directory unavailable)';
  let pending: Buffer[] = [], size = 0, oversized = false, recognized = 0;
  const limit = options.maxRecordBytes ?? MAX_RECORD;
  function warn(message: string) { if (result.warnings.length < 50) result.warnings.push(message); }
  function record(bytes: Buffer) {
    result.lines++;
    if (oversized) { result.skipped++; warn(`Line ${result.lines}: record exceeds ${limit} bytes; skipped.`); return; }
    if (!bytes.toString('utf8').trim()) return;
    let record: any;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { result.skipped++; warn(`Line ${result.lines}: malformed or partial JSON; skipped.`); return; }
    if (!record || typeof record !== 'object') { result.skipped++; return; }
    if (record.type === 'session_meta') {
      recognized++;
      if (typeof record.payload?.cwd === 'string') cwd = record.payload.cwd;
      if (record.payload?.version !== undefined && record.payload.version !== 1) warn(`Line ${result.lines}: unrecognized session version; known records parsed on a best-effort basis.`);
      const text = textContent(record.payload?.base_instructions);
      if (text) {
        if (result.events.length >= (options.maxEvents ?? MAX_EVENTS)) { result.limited = true; result.skipped++; }
        else result.events.push({ id: result.events.length + 1, line: result.lines, kind: 'instruction', text: text.slice(0, MAX_EXCERPT), chars: text.length, hash: createHash('sha256').update(text).digest('hex') });
      }
      return;
    }
    if (record.type === 'turn_context' && typeof record.payload?.cwd === 'string') { cwd = record.payload.cwd; return; }
    if (record.type !== 'response_item') return;
    recognized++;
    const p = record.payload;
    if (!p || typeof p !== 'object') { result.skipped++; warn(`Line ${result.lines}: missing response payload.`); return; }
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let args: any = {};
      if (typeof p.arguments === 'string') { try { args = JSON.parse(p.arguments); } catch { warn(`Line ${result.lines}: malformed tool arguments; command unavailable.`); } }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      const rawCommand = typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : '';
      const command = rawCommand.length <= MAX_EXCERPT ? rawCommand : '';
      if (rawCommand.length > MAX_EXCERPT) warn(`Line ${result.lines}: command exceeds retained-field limit; command analysis unavailable.`);
      if (typeof p.call_id === 'string' && p.call_id.length <= 512) {
        if (calls.size >= MAX_EVENTS) { calls.delete(calls.keys().next().value!); result.limited = true; }
        const tool = typeof p.name === 'string' ? p.name.slice(0, 100) : 'unknown';
        const shell = ['exec_command', 'shell', 'shell_command'].includes(tool);
        const rawDirectory = typeof args.workdir === 'string' ? args.workdir : typeof args.cwd === 'string' ? args.cwd : cwd;
        const workingDirectory = rawDirectory.length <= MAX_EXCERPT ? rawDirectory : '(working directory unavailable)';
        const read = shell ? fileRead(command) : undefined;
        calls.set(p.call_id, { tool, command: shell ? command : '', cwd: workingDirectory, ...(read && (workingDirectory !== '(working directory unavailable)' || read.read.startsWith('/')) ? read : {}) });
      }
      return;
    }
    let kind: Event['kind'], text = '', call: any;
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      kind = 'tool'; text = textContent(p.output); call = calls.get(p.call_id);
    } else if (p.type === 'message') {
      kind = p.role === 'developer' || p.role === 'system' ? 'instruction' : 'message'; text = textContent(p.content);
    } else { warn(`Line ${result.lines}: unsupported response item type; skipped.`); result.skipped++; return; }
    const content = kind === 'tool' ? p.output : p.content;
    if (Array.isArray(content) && content.some(v => v && typeof v === 'object' && !['input_text', 'output_text', 'text'].includes(v.type))) warn(`Line ${result.lines}: non-text content is unavailable and excluded from size estimates.`);
    if (result.events.length >= (options.maxEvents ?? MAX_EVENTS)) { result.limited = true; result.skipped++; return; }
    const shell = call && ['exec_command', 'shell', 'shell_command'].includes(call.tool);
    const wrapperHeader = /^Chunk ID:[^\n]*\n[\s\S]*?\nFinal output:\n/.exec(text)?.[0];
    const failed = kind === 'tool' && shell && (!!wrapperHeader && /^Process exited with code [1-9]\d*\s*$/m.test(wrapperHeader) || (p.output && !Array.isArray(p.output) && typeof p.output === 'object' && typeof p.output.exit_code === 'number' && p.output.exit_code !== 0));
    // Codex exec output wrapper varies per call; compare the final output body for reads only.
    const body = /^Chunk ID:[\s\S]*?\nFinal output:\n/.test(text) ? text.slice(text.indexOf('\nFinal output:\n') + 15) : text;
    result.events.push({ id: result.events.length + 1, line: result.lines, time: typeof record.timestamp === 'string' ? record.timestamp.slice(0, 100) : undefined, kind, ...call, text: text.slice(0, MAX_EXCERPT), chars: text.length, hash: createHash('sha256').update(text).digest('hex'), readHash: call?.read ? createHash('sha256').update(body).digest('hex') : undefined, failed });
  }
  for await (const chunk of createReadStream(path)) {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) {
      const part = chunk.subarray(start, i); size += part.length;
      if (size > limit) oversized = true;
      if (!oversized) pending.push(part);
      record(oversized ? Buffer.alloc(0) : Buffer.concat(pending));
      pending = []; size = 0; oversized = false; start = i + 1;
    }
    const part = chunk.subarray(start); size += part.length;
    if (size > limit) { oversized = true; pending = []; }
    if (!oversized && part.length) pending.push(part);
  }
  if (size || oversized) record(oversized ? Buffer.alloc(0) : Buffer.concat(pending));
  if (!recognized) warn('No recognized Codex rollout records found. Other session formats are unsupported.');
  if (result.limited) warn('Analysis limits reached: results are partial (maximum 20,000 retained events and pending calls).');
  return result;
}
