const PRICE_SOURCE =
  '(?:(?:USD|EUR|GBP|CAD|AUD|US)\\s*)?[$€£]\\s?\\d{1,3}(?:[, ]\\d{3})*(?:(?:\\.\\d{1,2})|(?:,\\d{1,2}))?(?:\\s*/\\s*(?:mo|month|yr|year|week|user|seat))?|\\b\\d{1,3}(?:[, ]\\d{3})*(?:\\.\\d{2})\\s*(?:USD|EUR|GBP|dollars)\\b';

function priceRegex() {
  return new RegExp(PRICE_SOURCE, 'gi');
}

export function formatMoney(price) {
  const symbols = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' };
  const symbol = symbols[price.currency] || '$';
  const amount = price.amount;
  let rendered = '?';
  if (amount != null && Number.isFinite(amount)) {
    const cents = Math.round(amount * 100);
    rendered = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  }
  return `${symbol}${rendered}${price.period ? `/${price.period}` : ''}`;
}

function currencyOf(raw) {
  if (/\bCAD\b/i.test(raw)) return 'CAD';
  if (/\bAUD\b/i.test(raw)) return 'AUD';
  if (raw.includes('€') || /\bEUR\b/i.test(raw)) return 'EUR';
  if (raw.includes('£') || /\bGBP\b/i.test(raw)) return 'GBP';
  return 'USD';
}

function periodOf(raw) {
  if (/\/\s*(?:yr|year)\b/i.test(raw)) return 'yr';
  if (/\/\s*(?:mo|month)\b/i.test(raw)) return 'mo';
  if (/\/\s*week\b/i.test(raw)) return 'wk';
  if (/\/\s*(?:user|seat)\b/i.test(raw)) return 'user';
  return '';
}

function amountOf(raw) {
  let body = raw.replace(/\/.*$/, '');
  body = body.replace(/[^\d.,]/g, '');
  if (!body) return null;
  if (body.includes(',') && body.includes('.')) {
    if (body.lastIndexOf(',') > body.lastIndexOf('.')) {
      body = body.replace(/\./g, '').replace(',', '.');
    } else {
      body = body.replace(/,/g, '');
    }
  } else if (body.includes(',')) {
    body = /,\d{1,2}$/.test(body) ? body.replace(',', '.') : body.replace(/,/g, '');
  }
  const value = Number(body);
  return Number.isFinite(value) ? value : null;
}

export function parsePriceToken(raw) {
  const amount = amountOf(raw);
  if (amount == null) return null;
  return {
    raw: raw.trim(),
    amount,
    currency: currencyOf(raw),
    period: periodOf(raw),
  };
}

function labelFrom(line, matches) {
  let label = line;
  for (const match of matches) label = label.replace(match, ' ');
  label = label.replace(/\s+/g, ' ').trim();
  label = label.replace(/^[\s|·•:\u2013\u2014-]+/, '').replace(/[\s|·•:\u2013\u2014-]+$/, '').trim();
  return label;
}

export function extractPrices(lines) {
  const prices = [];
  for (const line of lines) {
    const matches = [...line.matchAll(priceRegex())].map((match) => match[0]);
    if (!matches.length) continue;
    const label = labelFrom(line, matches);
    for (const raw of matches) {
      const parsed = parsePriceToken(raw);
      if (!parsed) continue;
      prices.push({
        ...parsed,
        label: label || `Price ${prices.length + 1}`,
        line,
      });
    }
  }
  return prices;
}

export function canonicalPriceText(prices) {
  return prices
    .map((price) => `${price.label} \u2014 ${formatMoney(price)}`)
    .sort((a, b) => a.localeCompare(b))
    .join('\n');
}

function priceKey(price) {
  return `${price.label.toLowerCase()}|${price.currency}|${price.period}`;
}

function sameAmount(a, b) {
  if (a.amount == null || b.amount == null) return a.raw === b.raw;
  return Math.abs(a.amount - b.amount) < 0.001;
}

export function diffPrices(previousPrices, nextPrices) {
  const previous = (previousPrices || []).map((price) => ({ ...price, used: false }));
  const changes = [];
  for (const next of nextPrices || []) {
    const match = previous.find((price) => !price.used && priceKey(price) === priceKey(next));
    if (match) {
      match.used = true;
      if (!sameAmount(match, next)) {
        changes.push({
          type: 'changed',
          label: next.label,
          from: formatMoney(match),
          to: formatMoney(next),
        });
      }
    } else {
      changes.push({
        type: 'added',
        label: next.label,
        from: '',
        to: formatMoney(next),
      });
    }
  }
  for (const price of previous) {
    if (price.used) continue;
    changes.push({
      type: 'removed',
      label: price.label,
      from: formatMoney(price),
      to: '',
    });
  }
  return changes;
}
