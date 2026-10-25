import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSession } from '../src/parser.ts';
import { analyze } from '../src/analysis.ts';
import { renderReport } from '../src/report.ts';
import { main } from '../src/cli.ts';

const row = (payload: unknown) => JSON.stringify({ type: 'response_item', payload });
const call = (id: string, command: string, output: unknown, workdir = '/demo') => [row({ type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: command, workdir }) }), row({ type: 'function_call_output', call_id: id, output })];
async function fixture(lines: string[]) { const dir = await mkdtemp(join(tmpdir(), 'contextlens-test-')); const path = join(dir, 'session.jsonl'); await writeFile(path, lines.join('\n')); return { dir, path }; }

test('parses text variants and ignores mirrored event messages', async () => {
  const { path } = await fixture([...call('a', 'cat a.ts', [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'private' }]), JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } })]);
  const s = await parseSession(path); assert.equal(s.events.length, 1); assert.equal(s.events[0].chars, 5); assert.equal(s.events[0].read, 'a.ts'); assert.match(s.warnings.join(' '), /non-text/);
});
test('detects exact duplicate outputs and changed versus unchanged reads', async () => {
  const { path } = await fixture([...call('a', 'cat a.ts', 'one'), ...call('b', 'cat a.ts', 'one'), ...call('c', 'cat b.ts', 'one'), ...call('d', 'cat b.ts', 'two')]);
  const a = analyze(await parseSession(path)); assert.equal(a.findings.filter(f => f.category === 'duplicate').length, 1); assert.ok(a.findings.some(f => f.title.endsWith('unchanged returned content'))); assert.ok(a.findings.some(f => f.title.endsWith('changed returned content') && !f.title.endsWith('unchanged returned content')));
});
test('compares read bodies despite changing Codex wrappers, but duplicates use full output', async () => {
  const wrapped = (id: number) => `Chunk ID: ${id}\nWall time: ${id} seconds\nProcess exited with code 0\nFinal output:\nhello`;
  const { path } = await fixture([...call('a', 'cat a.ts', wrapped(1)), ...call('b', 'cat a.ts', wrapped(2))]);
  const a = analyze(await parseSession(path)); assert.ok(a.findings.some(f => f.title.includes('unchanged'))); assert.ok(!a.findings.some(f => f.category === 'duplicate'));
});
test('does not conflate different working directories or arbitrary tools', async () => {
  const { path } = await fixture([...call('a', 'cat a.ts', 'one', '/first'), ...call('b', 'cat a.ts', 'one', '/second'), row({ type: 'function_call', name: 'arbitrary', call_id: 'c', arguments: '{"cmd":"cat secret"}' }), row({ type: 'function_call_output', call_id: 'c', output: 'one' })]);
  const s = await parseSession(path); assert.equal(s.events[2].read, undefined); assert.ok(!analyze(s).findings.some(f=>f.category === 'read'));
});
test('excludes glob reads and sed writes; metadata cap remains explicit', async () => {
  const { path } = await fixture([...call('a', 'cat *.ts', 'one'), ...call('b', "sed -i 's/a/b/' a.ts", 'two'), JSON.stringify({ type: 'session_meta', payload: { base_instructions: 'late instruction' } })]);
  const s = await parseSession(path, { maxEvents: 2 }); assert.ok(s.events.every(e=>!e.read)); assert.equal(s.limited, true); assert.equal(s.skipped, 1);
});
test('failure and retry findings require explicit execution wrapper evidence', async () => {
  const { path } = await fixture([...call('a', 'npm test', 'Chunk ID: a\nProcess exited with code 1\nFinal output:\nfailed'), ...call('b', 'npm test', 'Chunk ID: b\nProcess exited with code 1\nFinal output:\nfailed'), ...call('c', 'npm test', 'Chunk ID: c\nProcess exited with code 0\nFinal output:\npassed'), ...call('d', 'cat README.md', 'Process exited with code 1\nThis phrase is file content.')]);
  const a = analyze(await parseSession(path)); assert.equal(a.session.events.filter(e=>e.failed).length, 2); assert.equal(a.findings.find(f=>f.category==='retry')?.events.length, 3);
});
test('malformed, oversized, partial and unknown records recover; null arguments do not crash', async () => {
  const { path } = await fixture(['{broken', 'x'.repeat(600), JSON.stringify({ type: 'session_meta', payload: { version: 99 } }), row({ type: 'function_call', name: 'exec_command', call_id: 'a', arguments: 'null' }), row({ type: 'function_call_output', call_id: 'a', output: 'ok' }), '{unfinished']);
  const s = await parseSession(path, { maxRecordBytes: 500 }); assert.equal(s.events.length, 1); assert.equal(s.skipped, 3); assert.match(s.warnings.join(' '), /version/);
});
test('deep valid untrusted content cannot overflow extraction stack', async () => {
  const deep = '{"type":"response_item","payload":{"type":"message","role":"user","content":' + '['.repeat(10000) + '"nested text"' + ']'.repeat(10000) + '}}';
  const { path } = await fixture([deep, ...call('a', 'cat a.ts', 'next record')]);
  const s = await parseSession(path); assert.equal(s.events.length, 2); assert.equal(s.events[0].text, 'nested text'); assert.equal(s.events[1].text, 'next record');
});
test('non-string typed content cannot invoke coercion and later records still parse', async () => {
  const { path } = await fixture([row({ type: 'message', role: 'user', content: [{ type: { toString: null }, text: 'omit malformed typed content' }] }), ...call('a', 'cat a.ts', 'valid later output')]);
  const s = await parseSession(path); assert.equal(s.events.length, 2); assert.equal(s.events[0].text, ''); assert.equal(s.events[1].text, 'valid later output');
});
test('observable base instructions counted; absent instructions unavailable; event limit is explicit', async () => {
  const { path } = await fixture([JSON.stringify({ type: 'session_meta', payload: { base_instructions: { text: 'Guidance' } } }), ...call('a', 'echo ok', 'ok'), ...call('b', 'echo ok', 'ok')]);
  const a = analyze(await parseSession(path, { maxEvents: 2 })); assert.equal(a.instructionChars, 8); assert.equal(a.session.limited, true); assert.match(renderReport(analyze({events: [],warnings: [],lines: 0,skipped: 0,limited: false})), /Unavailable/);
});
test('HTML escapes hostile evidence and safe export omits all untrusted text', async () => {
  const secret = 'PRIVATE_SENTINEL_938';
  const attack = `</script><img src=x onerror=alert('${secret}')>`;
  const { path } = await fixture([...call('a', `cat ${secret}`, attack), row({ type: 'message', role: 'user', content: [{ type: 'input_text', text: secret }] })]);
  const a = analyze(await parseSession(path)); a.session.warnings.push(secret);
  const html = renderReport(a); assert.ok(html.includes('&lt;/script&gt;&lt;img')); assert.ok(!html.includes(attack)); assert.ok(!/<details[^>]*\bopen\b/.test(html));
  const safe = renderReport(a, true); assert.ok(!safe.includes(secret)); assert.ok(!safe.includes('exec_command')); assert.ok(!safe.includes('onerror')); assert.ok(!safe.includes(a.session.events[0].hash)); assert.ok(!safe.includes('/demo')); assert.ok(safe.includes('Automated redaction cannot guarantee'));
});
test('CLI creates private and share-safe reports; blocks existing output, symlink and input overwrite', async () => {
  const { dir, path } = await fixture(call('a', 'cat a.ts', 'hello'));
  const before = await readFile(path, 'utf8'); const out = join(dir, 'report.html'); await main([path, '--out', out]); assert.match(await readFile(out, 'utf8'), /ContextLens/);
  await assert.rejects(main([path, '--out', out]), /EEXIST/); await assert.rejects(main([path, '--out', path]), /replace/);
  const link = join(dir, 'link.html'); await symlink(path, link); await assert.rejects(main([path, '--out', link]), /replace/);
  const safe = join(dir, 'safe.html'); await main([path, '--out', safe, '--share-safe']); assert.ok(!(await readFile(safe, 'utf8')).includes('hello')); assert.equal(await readFile(path, 'utf8'), before);
  await assert.rejects(main([path, '--bad']), /Unknown/);
});
