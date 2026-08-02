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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    const email = ((req.query.email as string) || '').trim().toLowerCase();
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!email) return res.status(400).json({ error: 'email required' });
    if (!token) return res.status(400).json({ error: 'HubSpot token not configured' });

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
