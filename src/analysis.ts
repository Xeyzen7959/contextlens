import type { Event, Session } from './parser.ts';
export type Finding = { category: string; title: string; detail: string; events: number[]; chars: number };
export type Analysis = { session: Session; findings: Finding[]; totalChars: number; toolChars: number; instructionChars: number; instructionsObserved: boolean };
export const estimatedTokens = (chars: number) => Math.ceil(chars / 4);
export function analyze(session: Session): Analysis {
  const tools = session.events.filter(e => e.kind === 'tool');
  const findings: Finding[] = [];
  const groups = (key: (e: Event) => string | undefined) => {
    const map = new Map<string, Event[]>();
    for (const e of tools) { const k = key(e); if (k !== undefined) { const group = map.get(k); if (group) group.push(e); else map.set(k, [e]); } }
    return [...map.values()].filter(v => v.length > 1);
  };
  for (const group of groups(e => e.chars ? e.hash : undefined)) findings.push({ category: 'duplicate', title: 'Exact duplicate tool output', detail: `${group.length} outputs have identical SHA-256 hashes of the complete extracted text. Consider reusing an earlier result when still valid.`, events: group.map(e => e.id), chars: group.slice(1).reduce((n, e) => n + e.chars, 0) });
  for (const group of groups(e => e.read && !e.failed ? `${e.cwd}\0${e.read}\0${e.scope}` : undefined)) {
    const unique = new Set(group.map(e => e.readHash || e.hash)).size;
    findings.push({ category: 'read', title: unique === 1 ? 'Repeated read: unchanged returned content' : 'Repeated read: changed returned content', detail: unique === 1 ? `${group.length} reads with the same path and command returned identical text. Consider focused retrieval or retaining this result. This does not prove the entire file stayed unchanged.` : `${group.length} reads with the same path and command returned ${unique} distinct outputs. Review whether edits or tool wrappers explain the change; whole-file change is not established.`, events: group.map(e => e.id), chars: group.slice(1).reduce((n, e) => n + e.chars, 0) });
  }
  for (const group of groups(e => e.command && e.failed ? `${e.cwd}\0${e.command}` : undefined)) findings.push({ category: 'failure', title: 'Repeated failed command', detail: `${group.length} matching commands have explicit nonzero exit evidence. Inspect the first failure before retrying; other failures may be unavailable.`, events: group.map(e => e.id), chars: group.reduce((n, e) => n + e.chars, 0) });
  const commands = tools.filter(e => e.command);
  for (let i = 0; i < commands.length; i++) {
    if (!commands[i].failed) continue;
    const run = [commands[i]];
    while (i + 1 < commands.length && commands[i + 1].command === run[0].command && commands[i + 1].cwd === run[0].cwd) run.push(commands[++i]);
    if (run.length > 1) findings.push({ category: 'retry', title: 'Consecutive command retry sequence', detail: `${run.length} consecutive command results repeat the same command after a failure. Commands without captured outputs and intervening non-command events may be missing. Inspect the cause before another retry.`, events: run.map(e => e.id), chars: run.reduce((n, e) => n + e.chars, 0) });
  }
  const largest = [...tools].sort((a, b) => b.chars - a.chars).slice(0, 3);
  for (const e of largest) findings.push({ category: 'size', title: e.read ? 'Large file-read response' : 'Large tool response', detail: 'Review the evidence and request a narrower range, summary, or output filter when it preserves the task. Size alone does not establish waste.', events: [e.id], chars: e.chars });
  const instructions = session.events.filter(e => e.kind === 'instruction');
  if (instructions.length) findings.push({ category: 'instruction', title: 'Observable instruction text', detail: 'Source-visible system/developer messages and metadata base instructions are measurable. Review repeated or stale guidance manually; hidden instructions and reinjection are unavailable.', events: instructions.map(e => e.id), chars: instructions.reduce((n, e) => n + e.chars, 0) });
  findings.sort((a, b) => b.chars - a.chars);
  return { session, findings, totalChars: session.events.reduce((n, e) => n + e.chars, 0), toolChars: tools.reduce((n, e) => n + e.chars, 0), instructionChars: instructions.reduce((n, e) => n + e.chars, 0), instructionsObserved: instructions.length > 0 };
}
