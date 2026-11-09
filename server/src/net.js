import net from 'node:net';

export function isLoopback(hostname) {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1') return true;
  if (host.startsWith('::ffff:')) return isLoopback(host.slice(7));
  if (net.isIP(host) === 4) return Number(host.split('.')[0]) === 127;
  return false;
}

export function isBlockedHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (/^\d+$/.test(host) || /^0x[0-9a-f.]+$/i.test(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === 'metadata.google.internal' || host === 'metadata.google.com') return true;
  if (host.startsWith('::ffff:')) return isBlockedHost(host.slice(7));
  const ipVersion = net.isIP(host);
  if (ipVersion === 6) {
    if (host === '::' || host === '::1') return true;
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
    return false;
  }
  if (ipVersion !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function normalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function assertPublicHttpUrl(input, { allowLocal = false } = {}) {
  let url;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(String(input || ''));
  } catch {
    throw new Error('Enter a valid http or https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be monitored.');
  }
  if (url.username || url.password) {
    throw new Error('URLs with a username or password are not allowed.');
  }
  url.hash = '';
  const blocked = isBlockedHost(url.hostname);
  if (blocked && !(allowLocal && isLoopback(url.hostname))) {
    throw new Error('That host is not allowed. Pricewatch only fetches public websites.');
  }
  return url;
}

async function defaultLookup(host) {
  const { lookup } = await import('node:dns/promises');
  return lookup(host, { all: true, verbatim: true });
}

export async function assertResolvedHost(url, { allowLocal = false, lookup } = {}) {
  const host = normalizeHost(url.hostname);
  if (allowLocal && isLoopback(host)) return;
  if (isBlockedHost(host)) {
    throw new Error('That host is not allowed. Pricewatch only fetches public websites.');
  }
  if (net.isIP(host)) return;
  const lookupFn = lookup || defaultLookup;
  let records;
  try {
    records = await lookupFn(host);
  } catch {
    throw new Error('Could not resolve that host.');
  }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) throw new Error('Could not resolve that host.');
  for (const record of list) {
    const address = typeof record === 'string' ? record : record.address;
    if (!address || isBlockedHost(address) || isLoopback(address)) {
      throw new Error('That host is not allowed. Pricewatch only fetches public websites.');
    }
  }
}

export function createHostLimiter({ minIntervalMs = 0 } = {}) {
  const nextAt = new Map();
  return {
    async wait(host, extraDelayMs = 0) {
      const gap = Math.max(0, Number(minIntervalMs) || 0, Number(extraDelayMs) || 0);
      const key = String(host || '').toLowerCase();
      const now = Date.now();
      const slot = Math.max(now, nextAt.get(key) || 0);
      nextAt.set(key, slot + gap);
      const hold = slot - now;
      if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
    },
  };
}

function asFetchError(err, fallback) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new Error(fallback);
  const message = String(err?.message || '');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET/i.test(message)) return new Error(fallback);
  return err;
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Page is too large to monitor.');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('Page is too large to monitor.');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Page is too large to monitor.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function fetchPage(startUrl, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let current = startUrl instanceof URL ? startUrl : new URL(startUrl);
  for (let hop = 0; hop <= 5; hop += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        headers: {
          'user-agent': options.userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (err) {
      throw asFetchError(err, 'Timed out while fetching the page.');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect without a location (HTTP ${response.status}).`);
      const next = assertPublicHttpUrl(new URL(location, current), { allowLocal: options.allowLocal });
      await assertResolvedHost(next, options);
      current = next;
      continue;
    }
    if (response.status >= 400) throw new Error(`Page returned HTTP ${response.status}.`);
    const type = response.headers.get('content-type') || '';
    const buffer = await readLimited(response, options.maxBytes);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    if (type && !/text\/html|application\/xhtml\+xml/i.test(type) && !/^\s*(<!doctype|<html)/i.test(html)) {
      throw new Error(`Unsupported content type: ${type.split(';')[0]}.`);
    }
    return { html, status: response.status, finalUrl: current.toString() };
  }
  throw new Error('Too many redirects.');
}

export async function fetchRobotsTxt(robotsUrl, options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  let current = robotsUrl instanceof URL ? robotsUrl : new URL(robotsUrl);
  const origin = current.origin;
  for (let hop = 0; hop <= 2; hop += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: 'manual',
        headers: { 'user-agent': options.userAgent, accept: 'text/plain,*/*;q=0.1' },
        signal: AbortSignal.timeout(options.timeoutMs || 8000),
      });
    } catch (err) {
      throw asFetchError(err, 'Could not read robots.txt.');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Could not read robots.txt.');
      const next = new URL(location, current);
      if (next.origin !== origin) throw new Error('robots.txt redirected off-host.');
      current = next;
      continue;
    }
    const buffer = await readLimited(response, 512_000).catch(() => {
      throw new Error('robots.txt is too large.');
    });
    return {
      status: response.status,
      body: new TextDecoder('utf-8', { fatal: false }).decode(buffer),
    };
  }
  throw new Error('Could not read robots.txt.');
}
