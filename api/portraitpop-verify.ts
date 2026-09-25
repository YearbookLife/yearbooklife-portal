import { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

/**
 * VERIFY A PORTRAITPOP SESSION PASS
 *
 * PortraitPop calls this before it builds a PDF. If the eight-hour session pass has
 * expired or been tampered with, the answer is no and the tool refuses to export.
 * This is what stops a saved copy of the page working indefinitely.
 *
 * No student data is sent here - only the pass.
 *
 * The pass may arrive as { session } or { pass }, or as a query string. The tool
 * sends "session"; accepting both means a naming change on either side cannot
 * silently lock every adviser out.
 *
 * An invalid pass returns HTTP 401 AND { valid: false }, so a caller checking
 * either one gets the right answer.
 */

// ---------------------------------------------------------------------------
// Pass signing. Duplicated in each PortraitPop route on purpose, so these
// functions carry no dependency on any other file in the repo.
// ---------------------------------------------------------------------------

const OPEN_PASS_MS = 2 * 60 * 1000;
const SESSION_PASS_MS = 8 * 60 * 60 * 1000;

interface PassPayload { typ: 'open' | 'session'; email: string; exp: number; }

function getSecret(): string | null {
  const s = process.env.PORTRAITPOP_SECRET;
  return (s && s.length >= 16) ? s : null;
}

function signPass(payload: PassPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const secret = getSecret();
  if (!secret) {
    console.error('PORTRAITPOP_SECRET is missing or shorter than 16 characters');
    return res.status(500).json({ ok: false, valid: false, error: 'not-configured' });
  }

  try {
    const body: any = req.body || {};
    const pass = body.session || body.pass || req.query.session || req.query.pass || '';
    const payload = verifyPass(pass, secret, 'session');

    if (!payload) {
      return res.status(401).json({
        ok: false,
        valid: false,
        error: 'expired',
        message: 'Your PortraitPop session has ended. Please reopen it from the Quick Links tab of your dashboard.'
      });
    }

    return res.status(200).json({ ok: true, valid: true, expiresAt: payload.exp });

  } catch (error) {
    console.error('portraitpop-verify error:', error);
    return res.status(500).json({ ok: false, valid: false, error: 'server-error' });
  }
}
