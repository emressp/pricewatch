export const DEFAULT_DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Northwind Supply</title>
  <style>.ad { color: #b91c1c; }</style>
</head>
<body>
  <div class="cookie-banner">We use cookies. <button type="button">Accept all cookies</button></div>
  <p class="timestamp">Last updated: 2026-11-01T08:00:00Z</p>
  <p>Last updated: 2026-11-01T08:00:00Z</p>
  <p class="ad">Advertisement — sponsored camping gear</p>
  <h1>Northwind Supply</h1>
  <p>Wholesale gear for independent outdoor shops.</p>
  <ul>
    <li>Field notebook — $12/mo</li>
    <li>Trail kit — $29/mo</li>
    <li>Base camp bundle — $49/mo</li>
  </ul>
  <p>Ships in 2 business days.</p>
  <p>Session token: abcdef1234567890abcdef1234567890</p>
  <script>window.__session = "11111111111111111111111111111111";</script>
  <input type="hidden" name="csrf" value="csrf=tok_bbbbbbbbbbbbbbbbbbbbbbbbbbbb" />
</body>
</html>
`;

export const CHANGED_DEMO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Northwind Supply</title>
</head>
<body>
  <div class="cookie-banner">We use cookies. <button type="button">Accept all cookies</button></div>
  <p class="timestamp">Last updated: 2026-11-09T18:45:00Z</p>
  <p>Last updated: 2026-11-09T18:45:00Z</p>
  <p class="ad">Advertisement — flash sale on tents</p>
  <h1>Northwind Supply</h1>
  <p>Wholesale gear for independent outdoor shops.</p>
  <ul>
    <li>Field notebook — $12/mo</li>
    <li>Trail kit — $34/mo</li>
    <li>Expedition pack — $79/mo</li>
  </ul>
  <p>Ships in 5 business days.</p>
  <p>Session token: ffffffffffffffffffffffffffffffff</p>
  <script>window.__session = "22222222222222222222222222222222";</script>
  <input type="hidden" name="csrf" value="csrf=tok_cccccccccccccccccccccccccccc" />
</body>
</html>
`;
