import { VercelRequest, VercelResponse } from '@vercel/node';

const HS = 'https://api.hubapi.com';

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

// Reuse the same matching rules as find-my-deals
function isActivatedPortal(raw: any): boolean {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'true' || v === 'yes';
}
function isAdmin(yearbookTitle: any): boolean {
  const tags = String(yearbookTitle || '').split(/[,;]/).map(t => t.trim().toLowerCase());
  return tags.indexOf('p-yb') !== -1; // "P-yb" is the internal value for the "Admin" label
}

/** Pulls the caller's Supabase access token out of the Authorization header. */
function bearerToken(req: VercelRequest): string {
  const h = String(req.headers.authorization || '');
  return h.toLowerCase().indexOf('bearer ') === 0 ? h.slice(7).trim() : '';
}

/**
 * Confirms the caller is signed into the portal. Returns their verified
 * email, or null. Fails closed.
 */
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
    const e = user && user.email ? String(user.email).trim().toLowerCase() : '';
    return e || null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Same-origin only; no Access-Control-Allow-Origin header is sent.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const token = process.env.HUBSPOT_ACCESS_TOKEN;

    // The email comes from the VERIFIED session, never from the query string.
    // This route writes to HubSpot, so it must not act on an email that the
    // caller simply typed.
    const email = await callerEmail(req);
    if (!email) {
      return res.status(401).json({ error: 'Please log in to your dashboard.' });
    }

    if (!token) return res.status(500).json({ error: 'Server not configured' });

    // Find the admin contact(s) for this email
    const searchResp = await hs('/crm/v3/objects/contacts/search', token, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email', 'yearbook_title'],
        limit: 10
      })
    });
    if (!searchResp.ok) {
      return res.status(searchResp.status).json({ error: 'contact search failed' });
    }
    const contacts = (await searchResp.json()).results || [];

    // Midnight-based date stamp (HubSpot date properties expect UTC midnight ms)
    const now = new Date();
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    const stamped: string[] = [];

    for (const contact of contacts) {
      if (!isAdmin(contact.properties?.yearbook_title)) continue;

      const assocResp = await hs(`/crm/v3/objects/contacts/${contact.id}/associations/deals`, token);
      if (!assocResp.ok) continue;
      const dealRefs = (await assocResp.json()).results || [];

      for (const ref of dealRefs) {
        const dealId = ref.toObjectId || ref.id;
        if (!dealId) continue;

        // Only stamp deals whose portal is active
        const dealResp = await hs(`/crm/v3/objects/deals/${dealId}?properties=portal_activated,dashboard_activation_date`, token);
        if (!dealResp.ok) continue;
        const props = (await dealResp.json()).properties || {};
        if (!isActivatedPortal(props.portal_activated)) continue;

        // Don't overwrite an existing activation date
        if (props.dashboard_activation_date) { stamped.push(String(dealId) + ' (already set)'); continue; }

        const patch = await hs(`/crm/v3/objects/deals/${dealId}`, token, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { dashboard_activation_date: utcMidnight } })
        });
        if (patch.ok) stamped.push(String(dealId));
      }
    }

    return res.status(200).json({ ok: true, stamped });

  } catch (error) {
    console.error('mark-activated error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'mark-activated failed', detail: msg });
  }
}
