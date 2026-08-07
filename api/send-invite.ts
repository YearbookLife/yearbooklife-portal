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

// "P-yb" is the internal value for the "Admin" label on the Yearbook Title field
function isAdmin(yearbookTitle: any): boolean {
  const tags = String(yearbookTitle || '').split(/[,;]/).map(t => t.trim().toLowerCase());
  return tags.indexOf('p-yb') !== -1;
}
function isActivatedPortal(raw: any): boolean {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'true' || v === 'yes';
}

// Delete any existing Supabase login for this email before sending a fresh invite
// (clean slate for returning admins; harmless no-op for first-time customers).
async function deleteExistingUser(supabaseUrl: string, serviceKey: string, email: string): Promise<string> {
  try {
    const listResp = await fetch(
      supabaseUrl + '/auth/v1/admin/users?email=' + encodeURIComponent(email),
      { headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
    );
    if (!listResp.ok) return 'lookup-failed';
    const data = await listResp.json();
    const users = (data && data.users) ? data.users : (Array.isArray(data) ? data : []);
    const match = users.find(function (u: any) {
      return String(u.email || '').trim().toLowerCase() === email;
    });
    if (!match || !match.id) return 'no-existing-user';
    const delResp = await fetch(
      supabaseUrl + '/auth/v1/admin/users/' + match.id,
      { method: 'DELETE', headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
    );
    return delResp.ok ? 'deleted-existing' : 'delete-failed';
  } catch (e) {
    return 'delete-error';
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!hubspotToken || !supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server not fully configured' });
  }

  try {
    // The deal ID can come from a webhook body OR a ?dealId= query (for testing)
    let dealId = (req.query.dealId as string) || '';

    if (!dealId && req.body) {
      // HubSpot webhooks can send an array of events or an object
      const body = req.body;
      if (Array.isArray(body) && body.length > 0) {
        dealId = String(body[0].objectId || body[0].dealId || '');
      } else if (body.objectId || body.dealId) {
        dealId = String(body.objectId || body.dealId);
      } else if (body.dealId) {
        dealId = String(body.dealId);
      }
    }

    if (!dealId) {
      return res.status(400).json({ error: 'No dealId provided (in query or webhook body)' });
    }

    // 1) Confirm the deal has Portal Activated = Yes/true (safety check)
    const dealResp = await hs(`/crm/v3/objects/deals/${dealId}?properties=dealname,portal_activated`, hubspotToken);
    if (!dealResp.ok) {
      return res.status(dealResp.status).json({ error: 'Could not read deal', dealId });
    }
    const dealProps = (await dealResp.json()).properties || {};
    if (!isActivatedPortal(dealProps.portal_activated)) {
      return res.status(200).json({ skipped: true, reason: 'Portal not activated on this deal', dealId });
    }

    // 2) Find the Admin contact on this deal
    const assocResp = await hs(`/crm/v3/objects/deals/${dealId}/associations/contacts`, hubspotToken);
    if (!assocResp.ok) {
      return res.status(assocResp.status).json({ error: 'Could not read deal contacts', dealId });
    }
    const contactRefs = (await assocResp.json()).results || [];

    let adminEmail = '';
    for (const ref of contactRefs) {
      const contactId = ref.toObjectId || ref.id;
      if (!contactId) continue;
      const cResp = await hs(`/crm/v3/objects/contacts/${contactId}?properties=email,yearbook_title`, hubspotToken);
      if (!cResp.ok) continue;
      const cProps = (await cResp.json()).properties || {};
      if (isAdmin(cProps.yearbook_title) && cProps.email) {
        adminEmail = String(cProps.email).trim().toLowerCase();
        break;
      }
    }

    if (!adminEmail) {
      return res.status(200).json({ skipped: true, reason: 'No Admin contact with an email found on deal', dealId });
    }

    // Clear any existing login first (clean slate for returning admins)
    await deleteExistingUser(supabaseUrl, serviceKey, adminEmail);

    // 3) Tell Supabase to send the invite (magic link) to that email
    const inviteResp = await fetch(`${supabaseUrl}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: adminEmail })
    });

    const inviteText = await inviteResp.text();

    if (!inviteResp.ok) {
      // A common case: user already exists. Treat that as non-fatal info.
      return res.status(200).json({
        ok: false,
        dealId,
        adminEmail,
        inviteStatus: inviteResp.status,
        inviteDetail: inviteText.substring(0, 300)
      });
    }

    return res.status(200).json({ ok: true, dealId, adminEmail, invited: true });

  } catch (error) {
    console.error('send-invite error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'send-invite failed', detail: msg });
  }
}
