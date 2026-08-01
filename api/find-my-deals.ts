import { VercelRequest, VercelResponse } from '@vercel/node';

// Given a logged-in user's email, find the deal(s) where:
//   - that email is an associated contact on the deal
//   - that contact is tagged as Admin (Yearbook Title contains "Admin")
//   - the deal has Portal Activated = Yes
// Returns a list of active deals so the portal can route the user.

const HS = 'https://api.hubapi.com';

async function hs(path: string, token: string, options: any = {}) {
  const resp = await fetch(HS + path, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  return resp;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const email = ((req.query.email as string) || '').trim().toLowerCase();
    const token = process.env.HUBSPOT_ACCESS_TOKEN;

    if (!email) {
      return res.status(400).json({ error: 'email parameter required' });
    }
    if (!token) {
      return res.status(400).json({ error: 'HubSpot token not configured' });
    }

    // 1) Find the contact by email
    const searchResp = await hs('/crm/v3/objects/contacts/search', token, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: 'email', operator: 'EQ', value: email }]
        }],
        properties: ['email', 'yearbook_title', 'firstname', 'lastname'],
        limit: 10
      })
    });

    if (!searchResp.ok) {
      const detail = await searchResp.text();
      return res.status(searchResp.status).json({
        error: 'Contact lookup failed', status: searchResp.status, detail
      });
    }

    const searchData = await searchResp.json();
    const contacts = searchData.results || [];

    if (contacts.length === 0) {
      // No contact with that email — no dashboards
      return res.status(200).json({ deals: [] });
    }

    // 2) For each matching contact, get their associated deals
    const activeDeals: any[] = [];
    const seenDealIds = new Set<string>();

    for (const contact of contacts) {
      const contactId = contact.id;

      // Get deals associated with this contact
      const assocResp = await hs(
        `/crm/v3/objects/contacts/${contactId}/associations/deals`,
        token
      );
      if (!assocResp.ok) continue;

      const assocData = await assocResp.json();
      const dealRefs = assocData.results || [];

      for (const ref of dealRefs) {
        const dealId = ref.toObjectId || ref.id;
        if (!dealId || seenDealIds.has(String(dealId))) continue;
        seenDealIds.add(String(dealId));

        // 3) Read the deal's portal_activated + name
        const dealResp = await hs(
          `/crm/v3/objects/deals/${dealId}?properties=dealname,portal_activated`,
          token
        );
        if (!dealResp.ok) continue;

        const deal = await dealResp.json();
        const props = deal.properties || {};
        const activated = String(props.portal_activated || '').trim().toLowerCase();

        if (activated === 'yes') {
          activeDeals.push({
            dealId: String(dealId),
            dealName: props.dealname || 'Your Yearbook'
          });
        }
      }
    }

    return res.status(200).json({ deals: activeDeals });

  } catch (error) {
    console.error('find-my-deals error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'Lookup failed', detail: msg });
  }
}
