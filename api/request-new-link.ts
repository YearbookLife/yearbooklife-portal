import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * REQUEST A NEW DASHBOARD LINK
 *
 * Powers the "Send me a new link" form on the expired-link screen.
 *
 * A customer types their email address and gets a fresh invite. This covers every
 * reason a link stops working:
 *   - an email security scanner or preview pane consumed the single-use link
 *   - they clicked an older invite after a newer one replaced it
 *   - they set a password months ago and no longer remember it
 *
 * Safety notes:
 *   - Only sends to an email that is the tagged Admin (P-yb) on a qualifying,
 *     portal-activated deal. Random addresses get nothing.
 *   - Always returns the same friendly response, whether or not the email matched.
 *     That way the form can't be used to discover who is a customer.
 *   - Stamps Dashboard Invite Sent on every qualifying deal for that admin, so the
 *     nightly cron does NOT send another invite and invalidate this fresh link.
 */

const HS = 'https://api.hubapi.com';

// Must stay in sync with WON_STAGE_IDS in cron-send-invites.ts
const WON_STAGE_IDS = [
  '995123631',   // Traditional PL Pipeline -> Won (Restored)
  '997997495',   // Print Order (Renewal) -> WON
  '995003294',   // Band Book Lead -> Won
  '999965603',   // Military Book Lead -> WON
  '1000097294',  // Media Guide Lead -> WON
  '1000857003',  // Dance/Cheer Lead -> WON
  '1000822951',  // Church Directory Lead -> WON
  '999098015',   // Doggy Day Care Lead -> WON
  '43137964',    // Print Order (Renewal) -> Multi-Year
  '1398312509',  // Primary Lead Pipeline (Instaquote) -> Closed WON
  '115016114',   // Traditional PL Pipeline -> Supplement Won (Restored)
  '115012142',   // Print Order (Renewal) -> Supplement Won
  '1410223525'   // Primary Lead Pipeline (Instaquote) -> Supplement WON
];

// Never send more than this many invites from one request
const MAX_DEALS_PER_REQUEST = 10;

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

function isAdmin(yearbookTitle: any): boolean {
  const tags = String(yearbookTitle || '').split(/[,;]/).map(t => t.trim().toLowerCase());
  return tags.indexOf('p-yb') !== -1;
}

function isActivatedPortal(raw: any): boolean {
  const v = String(raw || '').trim().toLowerCase();
  return v === 'true' || v === 'yes';
}

// Clear any existing Supabase login so the fresh invite creates a clean one
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

// The same message goes back whether or not we found the customer, so this form
// can't be used to work out who is and isn't a YearbookLife customer.
const FRIENDLY = {
  ok: true,
  message: "If that email is on file as a yearbook administrator, a new link is on its way. It should arrive within a few minutes \u2014 please check your spam folder too."
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!hubspotToken || !supabaseUrl || !serviceKey) {
    return res.status(500).json({ ok: false, message: 'Server not fully configured' });
  }

  try {
    // Accept the email from a posted form body or a ?email= query
    let email = '';
    if (req.body && (req.body as any).email) {
      email = String((req.body as any).email);
    } else if (req.query.email) {
      email = String(req.query.email);
    }
    email = email.trim().toLowerCase();

    // Basic shape check. Anything obviously not an email gets the friendly reply.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(200).json(FRIENDLY);
    }

    // 1) Find the contact record for this email
    const contactSearch = await hs('/crm/v3/objects/contacts/search', hubspotToken, {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email', 'yearbook_title'],
        limit: 1
      })
    });
    if (!contactSearch.ok) return res.status(200).json(FRIENDLY);

    const contacts = (await contactSearch.json()).results || [];
    if (contacts.length === 0) return res.status(200).json(FRIENDLY);

    const contact = contacts[0];
    const contactId = contact.id;

    // 2) Must be tagged as the yearbook Admin
    if (!isAdmin((contact.properties || {}).yearbook_title)) {
      return res.status(200).json(FRIENDLY);
    }

    // 3) Find their deals
    const assocResp = await hs(`/crm/v3/objects/contacts/${contactId}/associations/deals`, hubspotToken);
    if (!assocResp.ok) return res.status(200).json(FRIENDLY);
    const dealRefs = (await assocResp.json()).results || [];

    // 4) Keep only qualifying, portal-activated deals
    const qualifyingDealIds: string[] = [];
    for (const ref of dealRefs.slice(0, MAX_DEALS_PER_REQUEST)) {
      const dealId = ref.toObjectId || ref.id;
      if (!dealId) continue;
      const dResp = await hs(`/crm/v3/objects/deals/${dealId}?properties=dealstage,portal_activated`, hubspotToken);
      if (!dResp.ok) continue;
      const dProps = (await dResp.json()).properties || {};
      if (WON_STAGE_IDS.indexOf(String(dProps.dealstage)) === -1) continue;
      if (!isActivatedPortal(dProps.portal_activated)) continue;
      qualifyingDealIds.push(String(dealId));
    }

    // No live dashboard for this person -> friendly reply, no email sent
    if (qualifyingDealIds.length === 0) {
      return res.status(200).json(FRIENDLY);
    }

    // 5) Clear any existing login, then send ONE fresh invite
    const delResult = await deleteExistingUser(supabaseUrl, serviceKey, email);

    const inviteResp = await fetch(`${supabaseUrl}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email: email })
    });

    // 6) Stamp every qualifying deal so tonight's cron does NOT send another invite
    //    and invalidate the link we just sent. This is the important bit.
    if (inviteResp.ok) {
      const now = new Date();
      const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      for (const dealId of qualifyingDealIds) {
        await hs(`/crm/v3/objects/deals/${dealId}`, hubspotToken, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { dashboard_invite_sent: utcMidnight } })
        });
      }
    } else {
      const detail = await inviteResp.text();
      console.error('request-new-link invite failed for', email, inviteResp.status,
        'deleteResult=' + delResult, detail.substring(0, 200));
    }

    return res.status(200).json(FRIENDLY);

  } catch (error) {
    console.error('request-new-link error:', error);
    // Still friendly to the customer; the detail is in the Vercel logs
    return res.status(200).json(FRIENDLY);
  }
}
