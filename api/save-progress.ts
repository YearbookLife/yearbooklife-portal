import { VercelRequest, VercelResponse } from '@vercel/node';

// Saves the customer's self-reported book progress to their HubSpot deal.
// Called instantly when they click a progress pill on the dashboard.
//
// Only a signed-in adviser may write, and only to their OWN deal. Both are
// checked here on the server: the dashboard's own check runs in the browser
// and cannot protect anything, because this address can be called directly.

const HS = 'https://api.hubapi.com';

const ALLOWED = [
  'Not started / Need help',
  'Just started',
  'About halfway',
  'Nearly done',
  'Ready to submit'
];

async function hs(path: string, token: string, options: any = {}) {
  return fetch(HS + path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

/** Pulls the caller's Supabase access token out of the Authorization header. */
function bearerToken(req: VercelRequest): string {
  const h = String(req.headers.authorization || '');
  return h.toLowerCase().indexOf('bearer ') === 0 ? h.slice(7).trim() : '';
}

/** Confirms the caller is signed in. Returns their verified email, or null. */
async function callerEmail(req: VercelRequest): Promise<string | null> {
  try {
    const url = process.env.SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY;
    const accessToken = bearerToken(req);
    if (!url || !anon || !accessToken) return null;

    const resp = await fetch(url + '/auth/v1/user', {
      headers: { 'apikey': anon, 'Authorization': 'Bearer ' + accessToken }
    });
    if (!resp.ok) return null;

    const user = await resp.json();
    const email = user && user.email ? String(user.email).trim().toLowerCase() : '';
    return email || null;
  } catch (e) {
    return null;
  }
}

/** "P-yb" is the internal HubSpot value for the "Admin" label. */
function isAdmin(yearbookTitle: any): boolean {
  const tags = String(yearbookTitle || '').split(/[,;]/).map(t => t.trim().toLowerCase());
  return tags.indexOf('p-yb') !== -1;
}

/** Is this email the Admin contact on this deal? */
async function ownsDeal(email: string, dealId: string, token: string): Promise<boolean> {
  try {
    const assocResp = await hs(`/crm/v3/objects/deals/${dealId}/associations/contacts`, token);
    if (!assocResp.ok) return false;
    const refs = (await assocResp.json()).results || [];

    for (const ref of refs) {
      const contactId = ref.toObjectId || ref.id;
      if (!contactId) continue;

      const cResp = await hs(`/crm/v3/objects/contacts/${contactId}?properties=email,yearbook_title`, token);
      if (!cResp.ok) continue;

      const props = (await cResp.json()).properties || {};
      if (String(props.email || '').trim().toLowerCase() !== email) continue;
      if (isAdmin(props.yearbook_title)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Same-origin only; no Access-Control-Allow-Origin header is sent.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const dealId = String(body.dealId || '').trim();
    const progress = String(body.progress || '').trim();

    if (!dealId) return res.status(400).json({ error: 'dealId required' });
    if (ALLOWED.indexOf(progress) === -1) {
      return res.status(400).json({ error: 'invalid progress value' });
    }

    // ---- who is calling, and is this deal theirs? ----------------------
    const email = await callerEmail(req);
    if (!email) {
      return res.status(401).json({ error: 'Please log in to your dashboard.' });
    }

    const allowed = await ownsDeal(email, dealId, token);
    if (!allowed) {
      return res.status(403).json({ error: 'This dashboard is not associated with your account.' });
    }

    // ---- safe to write -------------------------------------------------
    const resp = await hs(`/crm/v3/objects/deals/${dealId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { book_progress: progress } })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return res.status(resp.status).json({ error: 'HubSpot update failed', detail });
    }

    return res.status(200).json({ ok: true, dealId, progress });

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    return res.status(500).json({ error: msg });
  }
}
