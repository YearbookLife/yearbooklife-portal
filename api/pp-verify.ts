import { VercelRequest, VercelResponse } from '@vercel/node';
import { ppEnabled, configured, currentAdmin, ADMIN_BLOCK_MESSAGES, noStore, sameOrigin, logEvent } from '../lib/pp';

/**
 * EXPORT CHECK FOR LICENSED SCHOOL ADMINS
 *
 * PortraitPop (served by /api/pp-tool) calls this right before it builds a PDF.
 * It reads the HttpOnly sign-in cookie, so a copy of the page opened on another
 * computer has nothing to send and is refused. Fails closed on any problem.
 *
 * Each yes is logged as one export, which is how usage is counted. No student
 * data is sent here.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, valid: false });
  if (!ppEnabled() || !configured().ok) return res.status(503).json({ ok: false, valid: false, error: 'not-available' });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false, valid: false });

  try {
    const a = await currentAdmin(req);
    if (a.ok === false) {
      if (a.reason === 'error') return res.status(500).json({ ok: false, valid: false, error: 'server-error' });
      return res.status(401).json({ ok: false, valid: false, error: a.reason, message: ADMIN_BLOCK_MESSAGES[a.reason] });
    }
    await logEvent('export', { req, email: a.session.e, license_id: a.license.id, photographer_id: a.photographer.id, device: a.session.d });
    return res.status(200).json({ ok: true, valid: true, expiresAt: a.license.expires_at });
  } catch (e) {
    console.error('pp-verify error:', e);
    return res.status(500).json({ ok: false, valid: false, error: 'server-error' });
  }
}
