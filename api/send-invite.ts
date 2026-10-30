import { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

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
/**
 * Find a Supabase login by email address.
 *
 * Supabase's admin users endpoint has NO "find by email" filter. Passing
 * ?email=... is silently ignored and you get back the FIRST PAGE of every user
 * in the project. The previous version of this code searched only that page, so
 * once the portal had more logins than fit on one page it reported "no such
 * user" for almost everybody. The delete was then skipped and the invite that
 * followed was rejected as already registered - which is why returning admins
 * stopped receiving their links.
 *
 * Returns the user id, null when the address genuinely has no login, and throws
 * when the lookup itself failed, so callers can tell "not there" apart from
 * "could not tell".
 */
async function findUserByEmail(supabaseUrl: string, serviceKey: string, email: string): Promise<string | null> {
  const PER_PAGE = 1000;   // Supabase's maximum
  const MAX_PAGES = 25;    // 25,000 logins; far beyond anything expected here
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const resp = await fetch(
      supabaseUrl + '/auth/v1/admin/users?per_page=' + PER_PAGE + '&page=' + page,
      { headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
    );
    if (!resp.ok) {
      throw new Error('Supabase user lookup returned status ' + resp.status);
    }

    const data = await resp.json();
    const users = (data && data.users) ? data.users : (Array.isArray(data) ? data : []);

    const match = users.find(function (u: any) {
      return String(u.email || '').trim().toLowerCase() === target;
    });
    if (match && match.id) return String(match.id);

    // A short page means that was the last one.
    if (users.length < PER_PAGE) return null;
  }

  throw new Error('Supabase user lookup gave up after ' + MAX_PAGES + ' pages');
}

/**
 * Clear any existing Supabase login so a fresh invite creates a clean one.
 *
 * Return values are unchanged from before, so every caller keeps working:
 *   'deleted-existing' | 'no-existing-user' | 'lookup-failed' |
 *   'delete-failed'    | 'delete-error'
 *
 * The important distinction is 'no-existing-user' (we looked properly and there
 * is none) versus 'lookup-failed' (we could not find out). Callers must not
 * treat the second as the first.
 */
async function deleteExistingUser(supabaseUrl: string, serviceKey: string, email: string): Promise<string> {
  let userId: string | null;
  try {
    userId = await findUserByEmail(supabaseUrl, serviceKey, email);
  } catch (e) {
    console.error('deleteExistingUser: lookup failed for', email, e instanceof Error ? e.message : e);
    return 'lookup-failed';
  }

  if (!userId) return 'no-existing-user';

  try {
    const delResp = await fetch(
      supabaseUrl + '/auth/v1/admin/users/' + userId,
      { method: 'DELETE', headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
    );
    return delResp.ok ? 'deleted-existing' : 'delete-failed';
  } catch (e) {
    return 'delete-error';
  }
}


// ---------------------------------------------------------------------------
// STAFF / AUTOMATION GUARD
//
// This route is not for customers. It is triggered by Vercel's scheduler or by
// a member of staff, so it is protected by a shared secret rather than a login.
//
// The secret is accepted two ways:
//   - "Authorization: Bearer <secret>"  (how Vercel's scheduler sends it)
//   - "?secret=<secret>"                (so it can still be run by hand)
//
// Deliberately backwards compatible: if CRON_SECRET is not set in the
// environment the route behaves exactly as it did before and logs a warning.
// Deploying this code therefore changes nothing until the variable is added,
// and deleting the variable is an instant rollback if anything misbehaves.
// ---------------------------------------------------------------------------
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch (e) {
    return false;
  }
}

function staffAuthorised(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn('CRON_SECRET is not set - this route is currently unprotected');
    return true;
  }
  const h = String(req.headers.authorization || '');
  const fromHeader = h.toLowerCase().indexOf('bearer ') === 0 ? h.slice(7).trim() : '';
  const fromQuery = String(req.query.secret || '').trim();
  return sameSecret(fromHeader, secret) || sameSecret(fromQuery, secret);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Same-origin only; no Access-Control-Allow-Origin header is sent.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // This route deletes a customer's login and emails them a new one. It is a
  // staff / webhook action, never something a visitor may trigger.
  if (!staffAuthorised(req)) {
    return res.status(401).json({ error: 'Not authorised' });
  }

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
    const delResult = await deleteExistingUser(supabaseUrl, serviceKey, adminEmail);

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
        deleteResult: delResult,
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
