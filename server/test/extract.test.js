import assert from 'node:assert/strict';
import test from 'node:test';
import { extractContent } from '../src/extract.js';
import { DEFAULT_DEMO_HTML } from '../src/demo-page.js';

const shop = `<!DOCTYPE html>
<html><body>
  <div class="cookie-banner">We use cookies. <button>Accept all cookies</button></div>
  <p class="timestamp">Last updated: 2026-11-01T08:00:00Z</p>
  <p>Last updated: 2026-11-01T08:00:00Z</p>
  <div class="ad">Advertisement — sponsored gear</div>
  <h1>Northwind Supply</h1>
  <div class="card"><p>Field notebook — $12/mo</p></div>
  <p>Ships in 2 business days.</p>
  <p>Session token: abcdef1234567890abcdef1234567890</p>
  <script>window.__session = "11111111111111111111111111111111";</script>
  <input type="hidden" name="csrf" value="csrf=tok_bbbbbbbbbbbbbbbbbbbbbbbbbbbb" />
</body></html>`;

test('extraction drops ads, cookies, timestamps, and session tokens', () => {
  const extracted = extractContent(shop);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.text, [
    'Northwind Supply',
    'Field notebook — $12/mo',
    'Ships in 2 business days.',
  ].join('\n'));
  assert.equal(extracted.prices.length, 1);
  assert.equal(extracted.prices[0].label, 'Field notebook');
  assert.equal(extracted.prices[0].amount, 12);
  assert.equal(extracted.prices[0].period, 'mo');
});

test('noise-only edits do not change the hash', () => {
  const later = shop
    .replaceAll('2026-11-01T08:00:00Z', '2026-11-09T18:45:00Z')
    .replaceAll('abcdef1234567890abcdef1234567890', 'ffffffffffffffffffffffffffffffff')
    .replace('sponsored gear', 'flash sale on tents')
    .replace('11111111111111111111111111111111', '22222222222222222222222222222222');
  const first = extractContent(shop);
  const second = extractContent(later);
  assert.equal(first.hash, second.hash);
});

test('a CSS selector limits the page, and a miss is an error', () => {
  const html = `<html><body>
    <section class="story"><p>About us since 1999.</p></section>
    <section class="buy"><p>Pen — $4</p></section>
  </body></html>`;
  const scoped = extractContent(html, { selector: '.buy' });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.text, 'Pen — $4');
  assert.equal(scoped.prices[0].amount, 4);
  const missing = extractContent(html, { selector: '.missing' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /matched no elements/);
});

test('price-only mode ignores copy that is not a price', () => {
  const before = extractContent(DEFAULT_DEMO_HTML, { mode: 'price' });
  const copyOnly = DEFAULT_DEMO_HTML.replace('Ships in 2 business days.', 'Ships in 5 business days.');
  const after = extractContent(copyOnly, { mode: 'price' });
  assert.equal(before.hash, after.hash);
  assert.match(before.text, /Trail kit — \$29\/mo/);
  assert.doesNotMatch(before.text, /Ships/);
  assert.doesNotMatch(before.text, /cookie/i);
  const priced = extractContent(copyOnly.replace('$29/mo', '$34/mo'), { mode: 'price' });
  assert.notEqual(before.hash, priced.hash);
});

test('euro prices and thousands separators parse', () => {
  const extracted = extractContent('<p>Desk — €19,99</p><p>Chair — $1,299.00</p><p>Lamp — 12.99 USD</p>');
  assert.equal(extracted.prices[0].currency, 'EUR');
  assert.equal(extracted.prices[0].amount, 19.99);
  assert.equal(extracted.prices[1].currency, 'USD');
  assert.equal(extracted.prices[1].amount, 1299);
  assert.equal(extracted.prices[2].amount, 12.99);
});
