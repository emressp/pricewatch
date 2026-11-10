import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { canonicalPriceText, extractPrices } from './prices.js';

const MAX_TEXT = 200_000;
const MAX_PRICES = 500;

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul',
]);

const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'template', 'head']);

const NOISE_ATTR = /(^|[^a-z0-9])(ads?|advertisements?|advert|sponsored?|cookie([_-]?(banner|consent|notice|popup))?|gdpr|onetrust|timestamps?)([^a-z0-9]|$)/i;

function loadHtml(html) {
  if (typeof cheerio.load === 'function') return cheerio.load(html);
  if (cheerio.default && typeof cheerio.default.load === 'function') return cheerio.default.load(html);
  throw new Error('HTML parser is unavailable');
}

function isNoiseElement(el) {
  if (!el || el.type !== 'tag') return false;
  const name = String(el.name || '').toLowerCase();
  if (name === 'time') return true;
  const attrs = el.attribs || {};
  if (attrs['data-ad'] != null || attrs['data-timestamp'] != null) return true;
  return NOISE_ATTR.test(attrs.class || '') || NOISE_ATTR.test(attrs.id || '');
}

function stripNoiseTokens(value) {
  let text = String(value || '').replace(/\u00a0/g, ' ');
  const patterns = [
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    /\b(?:csrf|xsrf|session(?:id)?|nonce)[=:]\s*\S+/gi,
    /\b[0-9a-f]{24,}\b/gi,
    /\b(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{32,}={0,2}\b/g,
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  ];
  for (const pattern of patterns) text = text.replace(pattern, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function isNoiseLine(value) {
  const text = value.trim();
  if (!text) return true;
  if (/cookie (policy|consent|settings|preferences|banner)/i.test(text)) return true;
  if (/^(we |this site )?uses? cookies\b/i.test(text)) return true;
  if (/^accept (all )?cookies\b/i.test(text)) return true;
  if (/^(advertisement|sponsored( content)?|promoted)$/i.test(text)) return true;
  if (/^(last\s+)?(updated|modified|published|checked|refreshed|generated)\b/i.test(text)) return true;
  if (/^as of\b/i.test(text)) return true;
  if (/^session( token)?\b/i.test(text) && !/[$€£]/.test(text)) return true;
  if (/^csrf\b/i.test(text) && !/[$€£]/.test(text)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(text) && text.length < 40) return true;
  if (!/[a-z0-9$€£]/i.test(text)) return true;
  return false;
}

function cleanLine(raw) {
  const text = stripNoiseTokens(raw);
  if (!text || isNoiseLine(text)) return '';
  return text;
}

function flush(state, lines) {
  if (!state.buf.length) return;
  const text = cleanLine(state.buf.join(' '));
  state.buf = [];
  if (text) lines.push(text);
}

function walk(node, state, lines) {
  if (!node) return;
  if (node.type === 'text') {
    const text = String(node.data ?? node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (text) state.buf.push(text);
    return;
  }
  if (node.type !== 'tag') return;
  const name = String(node.name || '').toLowerCase();
  if (SKIP.has(name)) return;
  if (name === 'br' || name === 'hr') {
    flush(state, lines);
    return;
  }
  const block = BLOCK.has(name);
  if (block) flush(state, lines);
  for (const child of node.children || []) walk(child, state, lines);
  if (block) flush(state, lines);
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function extractContent(html, { selector = '', mode = 'all' } = {}) {
  let $;
  try {
    $ = loadHtml(String(html || ''));
  } catch (err) {
    return { ok: false, error: err.message || 'Could not read the page HTML' };
  }

  $('script, style, noscript, svg, canvas, iframe, template, head').remove();
  $('input[type="hidden"]').remove();

  const wanted = String(selector || '').trim();
  let selection;
  try {
    selection = wanted ? $(wanted) : $('body');
  } catch {
    return { ok: false, error: 'That CSS selector is not valid.' };
  }
  if (wanted && selection.length === 0) {
    return { ok: false, error: `Selector matched no elements: ${wanted}` };
  }
  if (!wanted && selection.length === 0) selection = $.root();

  const doomed = [];
  selection.find('*').each((_, el) => {
    if (isNoiseElement(el)) doomed.push(el);
  });
  for (const el of doomed) $(el).remove();

  const lines = [];
  const state = { buf: [] };
  selection.each((_, el) => {
    walk(el, state, lines);
    flush(state, lines);
  });

  const prices = extractPrices(lines).slice(0, MAX_PRICES);
  const resolvedMode = mode === 'price' ? 'price' : 'all';
  let text = resolvedMode === 'price' ? canonicalPriceText(prices) : lines.join('\n');
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

  return {
    ok: true,
    mode: resolvedMode,
    text,
    prices,
    hash: hashText(text),
    lineCount: text ? text.split('\n').length : 0,
  };
}
