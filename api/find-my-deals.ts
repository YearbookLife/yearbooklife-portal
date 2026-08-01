import { VercelRequest, VercelResponse } from '@vercel/node';

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

  const debug: any = { steps: [] };

  try {
    const email = ((req.query.email as string) || '').trim().toLowerCase();
    const token = process.env.HUBSPOT_ACCESS_TOKEN;
    const wantDebug = req.query.debug === '1';

    if (!email) return res.status(400).json({ error: 'email parameter required' });
    if (!token) return res.status(400).json({ error: 'HubSpot token not configured' });

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
      return res.status(searchResp.status).json({ error: 'Contact lookup failed', status: searchResp.status, detail });
    }

    const searchData = await searchResp.json();
    const contacts = searchData.results || [];
    debug.steps.push({ step: 'contact_search', found: contacts.length, contacts: contacts.map((c: any) => ({ id: c.id, email: c.properties?.email, yearbook_title: c.properties?.yearbook_title })) });

    if (contacts.length === 0) {
      return res.status(200).json(wantDebug ? { deals: [], debug } : { deals: [] });
    }

    const activeDeals: any[] = [];
    const seenDealIds = new Set<string>();

    for (const contact of contacts) {
      const contactId = contact.id;

      // Try the associations endpoint
      const assocResp = await hs(`/crm/v3/objects/contacts/${contactId}/associations/deals`, token);
      const assocRaw = await assocResp.text();
      debug.steps.push({ step: 'associations', contactId, ok: assocResp.ok, status: assocResp.status, raw: assocRaw.substring(0, 500) });

      if (!assocResp.ok) continue;

      let assocData: any = {};
      try { assocData = JSON.parse(assocRaw); } catch (e) {}
      const dealRefs = assocData.results || [];

      for (const ref of dealRefs) {
        const dealId = ref.toObjectId || ref.id;
        if (!dealId || seenDealIds.has(String(dealId))) continue;
        seenDealIds.add(String(dealId));

        const dealResp = await hs(`/crm/v3/objects/deals/${dealId}?properties=dealname,portal_activated`, token);
        if (!dealResp.ok) { debug.steps.push({ step: 'deal_read_fail', dealId, status: dealResp.status }); continue; }

        const deal = await dealResp.json();
        const props = deal.properties || {};
        const activated = String(props.portal_activated || '').trim().toLowerCase();
        debug.steps.push({ step: 'deal_check', dealId, dealName: props.dealname, portal_activated_raw: props.portal_activated, normalized: activated });

        if (activated === 'yes') {
          activeDeals.push({ dealId: String(dealId), dealName: props.dealname || 'Your Yearbook' });
        }
      }
    }

    return res.status(200).json(wantDebug ? { deals: activeDeals, debug } : { deals: activeDeals });

  } catch (error) {
    console.error('find-my-deals error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'Lookup failed', detail: msg, debug });
  }
}
