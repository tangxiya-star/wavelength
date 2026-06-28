// Minimal admin auth: username/password login issues an HMAC-signed, expiring
// session token. Admin endpoints accept either that token or the master
// ADMIN_TOKEN (handy for curl/scripts).
//
// Uses the Web Crypto API (crypto.subtle / btoa), which Node 18+ exposes
// globally — so this module is unchanged from the original Worker version
// apart from `requireAdmin` taking the master token directly instead of
// reading it off `c.env`.

import type { MiddlewareHandler } from 'hono';

async function hmac(payload: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(payload));
  let bin = '';
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function issueSession(key: string, ttlMs = 8 * 3600 * 1000): Promise<string> {
  const exp = String(Date.now() + ttlMs);
  return `${exp}.${await hmac(exp, key)}`;
}

export async function verifySession(token: string, key: string): Promise<boolean> {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(exp, key));
}

/** Guard admin endpoints: Bearer must be the master token or a valid session. */
export function requireAdmin(masterToken: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token && masterToken && (safeEqual(token, masterToken) || (await verifySession(token, masterToken)))) {
      return next();
    }
    return c.json({ error: 'unauthorized' }, 401);
  };
}
