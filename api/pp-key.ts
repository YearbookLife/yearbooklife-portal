import { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { ppEnabled, configured, currentAdmin, noStore, sameOrigin } from '../lib/pp';

/**
 * SAVED-WORK KEY FOR LICENSED SCHOOL ADMINS
 *
 * Same idea as api/portraitpop-key.ts for the dashboard: the school admin's
 * saved work is encrypted in their browser with a key only this route hands
 * out, and only to the signed-in admin of an active license. Each license has
 * its own key and storage slot. When the license ends or the admin is
 * removed, the key stops being handed out, so the saved work can no longer
 * be opened.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!ppEnabled() || !configured().ok) return res.status(503).json({ ok: false });
  if (!sameOrigin(req)) return res.status(403).json({ ok: false });

  try {
    const a = await currentAdmin(req);
    if (a.ok === false) return res.status(a.reason === 'error' ? 500 : 401).json({ ok: false, error: a.reason });

    const secret = String(process.env.PP_LICENSE_SECRET);
    const account = String(a.license.id);
    const key = crypto.createHmac('sha256', secret).update('portraitpop-work-key|v1|license|' + account).digest('base64');
    const id = crypto.createHmac('sha256', secret).update('portraitpop-work-id|v1|license|' + account).digest('base64url').slice(0, 22);
    return res.status(200).json({ ok: true, key, id });
  } catch (e) {
    console.error('pp-key error:', e);
    return res.status(500).json({ ok: false, error: 'server-error' });
  }
}
