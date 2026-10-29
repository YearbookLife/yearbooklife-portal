import { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

/**
 * SAVED-WORK KEY FOR DASHBOARD ADVISERS
 *
 * PortraitPop saves an adviser's work (student names, corrections, layout) in
 * their own browser so it isn't lost. That copy is encrypted with a key that
 * only this route hands out, and only to a page holding a valid session pass.
 * The key never goes into browser storage, so anyone else using the same
 * computer finds only scrambled data.
 *
 * Each adviser email gets its own key and its own storage slot, so two advisers
 * on one computer can't open each other's work.
 *
 * No student data is sent here - only the session pass.
 */

// ---------------------------------------------------------------------------
// Pass checking. Duplicated in each PortraitPop route on purpose, so these
// functions carry no dependency on any other file in the repo.
// ---------------------------------------------------------------------------

interface PassPayload { typ: 'open' | 'session'; email: string; exp: number; }

function getSecret(): string | null {
  const s = process.env.PORTRAITPOP_SECRET;
  return (s && s.length >= 16) ? s : null;
}

function verifyPass(pass: any, secret: string, expectedType: 'open' | 'session'): PassPayload | null {
  try {
    const raw = String(pass || '');
    const dot = raw.indexOf('.');
    if (dot < 1) return null;
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (sig.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || data.typ !== expectedType) return null;
    if (typeof data.exp !== 'number' || Date.now() > data.exp) return null;
    if (!data.email) return null;
    return data as PassPayload;
  } catch (e) {
    return null;
  }
}

function sameOrigin(req: VercelRequest): boolean {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false });

  const secret = getSecret();
  if (!secret) return res.status(500).json({ ok: false, error: 'not-configured' });

  try {
    const body: any = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const payload = verifyPass(body.session, secret, 'session');
    if (!payload) return res.status(401).json({ ok: false, error: 'expired' });

    const account = String(payload.email).trim().toLowerCase();
    const key = crypto.createHmac('sha256', secret).update('portraitpop-work-key|v1|dashboard|' + account).digest('base64');
    const id = crypto.createHmac('sha256', secret).update('portraitpop-work-id|v1|dashboard|' + account).digest('base64url').slice(0, 22);
    return res.status(200).json({ ok: true, key, id });
  } catch (error) {
    console.error('portraitpop-key error:', error);
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
}
