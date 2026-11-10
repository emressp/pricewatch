import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { tokensEqual } from './tokens.js';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const SESSION_COOKIE = 'pw_session';
export const CSRF_COOKIE = 'pw_csrf';
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 32, SCRYPT_PARAMS)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hex] = parts;
  const hash = await scrypt(password, salt, 32, SCRYPT_PARAMS);
  const expected = Buffer.from(hex, 'hex');
  if (expected.length !== hash.length) return false;
  return timingSafeEqual(expected, hash);
}

export function newSessionToken() {
  return randomBytes(32).toString('hex');
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

export function sessionCookie(token, { secure = false } = {}) {
  const maxAge = Math.floor(SESSION_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function csrfCookie(token, { secure = false } = {}) {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 24 * 60 * 60}${secure ? '; Secure' : ''}`;
}

export function issueCsrf(req, res, { secure = false } = {}) {
  const existing = readCookie(req.headers.cookie, CSRF_COOKIE);
  if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  const token = randomBytes(32).toString('hex');
  res.append('Set-Cookie', csrfCookie(token, { secure }));
  return token;
}

export function csrfMatches(req) {
  const cookie = readCookie(req.headers.cookie, CSRF_COOKIE);
  const provided = String(req.body?._csrf || req.headers['x-csrf-token'] || '');
  return tokensEqual(cookie, provided);
}
