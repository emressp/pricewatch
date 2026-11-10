import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChange, diffLines, renderEmail } from '../src/diff.js';
import { extractContent } from '../src/extract.js';
import { CHANGED_DEMO_HTML, DEFAULT_DEMO_HTML } from '../src/demo-page.js';

test('price and product changes render as a readable old-vs-new diff', () => {
  const before = extractContent(DEFAULT_DEMO_HTML, { mode: 'price' });
  const after = extractContent(CHANGED_DEMO_HTML, { mode: 'price' });
  const change = buildChange(before, after);
  assert.equal(
    change.summary,
    'Trail kit: $29/mo → $34/mo; Added Expedition pack ($79/mo); Removed Base camp bundle ($49/mo)',
  );
  assert.ok(change.lines.some((line) => line.op === 'del' && line.text.includes('$29/mo')));
  assert.ok(change.lines.some((line) => line.op === 'add' && line.text.includes('$34/mo')));
  assert.ok(change.lines.some((line) => line.op === 'add' && line.text.includes('Expedition pack')));
  assert.ok(change.lines.some((line) => line.op === 'del' && line.text.includes('Base camp bundle')));
  const email = renderEmail({
    monitor: { label: 'Northwind', url: 'http://127.0.0.1/demo/page' },
    diff: change,
    changeUrl: 'http://127.0.0.1/app/changes/1',
  });
  assert.match(email.subject, /Trail kit: \$29\/mo → \$34\/mo/);
  assert.match(email.text, /Old vs new:/);
  assert.match(email.text, /-\s.*\$29\/mo/);
  assert.match(email.text, /\+\s.*\$34\/mo/);
  assert.match(email.text, /http:\/\/127\.0\.0\.1\/app\/changes\/1/);
  assert.doesNotMatch(email.text, /2026-11-09T18:45:00Z/);
  assert.doesNotMatch(email.text, /5 business days/);
});

test('information changes are described when prices stay put', () => {
  const before = extractContent('<html><body><h1>Store</h1><p>Ships in 2 business days.</p><p>Notebook — $12/mo</p></body></html>');
  const after = extractContent('<html><body><h1>Store</h1><p>Ships in 5 business days.</p><p>Notebook — $12/mo</p></body></html>');
  const change = buildChange(before, after);
  assert.equal(change.priceChanges.length, 0);
  assert.equal(change.summary, 'Content changed (1 line added, 1 removed)');
  assert.ok(change.lines.some((line) => line.op === 'del' && /2 business days/.test(line.text)));
  assert.ok(change.lines.some((line) => line.op === 'add' && /5 business days/.test(line.text)));
});

test('identical snapshots are not a change, and line diffs keep context', () => {
  const snap = { text: 'Plans\nPro — $19/mo\nStarter — $9/mo', prices: [] };
  assert.equal(buildChange(snap, { ...snap }), null);
  const lines = diffLines('Plans\nPro — $19/mo\nStarter — $9/mo', 'Plans\nPro — $29/mo\nStarter — $9/mo');
  assert.deepEqual(lines.map((line) => line.op), ['eq', 'del', 'add', 'eq']);
  assert.equal(lines[1].text, 'Pro — $19/mo');
  assert.equal(lines[2].text, 'Pro — $29/mo');
});
