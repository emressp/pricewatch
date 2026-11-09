import { diffPrices } from './prices.js';

export function diffLines(before, after) {
  const a = before ? String(before).split('\n') : [];
  const b = after ? String(after).split('\n') : [];
  if (a.length * b.length > 800_000) return coarseDiff(a, b);
  return compact(align(a, b));
}

function align(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'eq', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: 'del', text: a[i] });
      i += 1;
    } else {
      ops.push({ op: 'add', text: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ op: 'del', text: a[i++] });
  while (j < m) ops.push({ op: 'add', text: b[j++] });
  return ops;
}

function coarseDiff(a, b) {
  const inB = new Set(b);
  const inA = new Set(a);
  const ops = [];
  for (const line of a) if (!inB.has(line)) ops.push({ op: 'del', text: line });
  for (const line of b) if (!inA.has(line)) ops.push({ op: 'add', text: line });
  return ops.slice(0, 200);
}

function compact(ops, context = 1) {
  const show = ops.map(() => false);
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].op === 'eq') continue;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k += 1) {
      show[k] = true;
    }
  }
  const out = [];
  let skipped = 0;
  const pushSkip = () => {
    if (!skipped) return;
    out.push({ op: 'skip', text: `${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
    skipped = 0;
  };
  for (let i = 0; i < ops.length; i += 1) {
    if (!show[i]) {
      skipped += 1;
      continue;
    }
    pushSkip();
    out.push(ops[i]);
  }
  if (skipped && out.length) pushSkip();
  return out;
}

function describePriceChange(change) {
  if (change.type === 'changed') return `${change.label}: ${change.from} → ${change.to}`;
  if (change.type === 'added') return `Added ${change.label} (${change.to})`;
  return `Removed ${change.label} (${change.from})`;
}

export function summarize(priceChanges, added, removed) {
  if (priceChanges.length) {
    const bits = priceChanges.slice(0, 4).map(describePriceChange);
    if (priceChanges.length > 4) bits.push(`+${priceChanges.length - 4} more price changes`);
    return bits.join('; ');
  }
  if (!added && !removed) return 'Content changed';
  const addedLabel = `${added} line${added === 1 ? '' : 's'} added`;
  return `Content changed (${addedLabel}, ${removed} removed)`;
}

export function buildChange(previous, next) {
  const priceChanges = diffPrices(previous?.prices || [], next?.prices || []);
  const before = previous?.text || '';
  const after = next?.text || '';
  if (before === after && priceChanges.length === 0) return null;
  const lines = before === after ? [] : diffLines(before, after);
  const added = lines.filter((line) => line.op === 'add').length;
  const removed = lines.filter((line) => line.op === 'del').length;
  return {
    summary: summarize(priceChanges, added, removed),
    priceChanges,
    lines,
    added,
    removed,
  };
}

export function renderEmail({ monitor, diff, changeUrl }) {
  const label = monitor.label || monitor.url;
  let subjectCore = diff.priceChanges?.length ? diff.summary : `${label} changed`;
  if (subjectCore.length > 110) subjectCore = `${subjectCore.slice(0, 107)}...`;
  const shown = [];
  for (const line of diff.lines || []) {
    if (shown.length >= 80) {
      shown.push('… diff truncated. Open the link for the full change.');
      break;
    }
    if (line.op === 'skip') shown.push(`  … ${line.text}`);
    else if (line.op === 'add') shown.push(`+ ${line.text}`);
    else if (line.op === 'del') shown.push(`- ${line.text}`);
    else shown.push(`  ${line.text}`);
  }
  const parts = [
    'A page you watch with Pricewatch changed.',
    '',
    label,
    monitor.url,
    '',
    diff.summary,
    '',
  ];
  if (shown.length) {
    parts.push('Old vs new:', ...shown, '');
  }
  parts.push(`View the full diff: ${changeUrl}`, '', 'You get this email because this URL is in your Pricewatch Change Monitor.');
  return {
    subject: `Pricewatch: ${subjectCore}`,
    text: parts.join('\n'),
  };
}
