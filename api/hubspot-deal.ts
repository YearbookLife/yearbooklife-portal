import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * DEAL DATA FOR THE DASHBOARD
 *
 * Returns the contract details the dashboard displays.
 *
 * This route is only for a signed-in adviser asking for THEIR OWN deal. Two
 * things are checked on the server before any data is returned:
 *
 *   1. The caller holds a valid Supabase session (proves who they are).
 *   2. That person is the Admin contact on the deal they asked for
 *      (proves they are allowed to see it).
 *
 * The dashboard also checks this in the browser, but a browser check only
 * tidies up what a user sees. It cannot protect anything, because anyone can
 * call this address directly and never load the dashboard page at all. The
 * check below is the one that actually matters.
 */

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

/** Pulls the caller's Supabase access token out of the Authorization header. */
function bearerToken(req: VercelRequest): string {
  const h = String(req.headers.authorization || '');
  return h.toLowerCase().indexOf('bearer ') === 0 ? h.slice(7).trim() : '';
}

/**
 * Confirms the caller is signed into the portal, by asking Supabase to
 * validate the token. Returns their verified email, or null.
 *
 * Deliberately fails closed: a missing token, an expired one, a forged one or
 * an unreachable Supabase all return null, and the caller gets a 401.
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
    const email = user && user.email ? String(user.email).trim().toLowerCase() : '';
    return email || null;
  } catch (e) {
    return null;
  }
}

/**
 * "P-yb" is the internal HubSpot value for the "Admin" label on Yearbook Title.
 * Co-Admin ("Co-Chair") deliberately does NOT count, matching find-my-deals.
 */
function isAdmin(yearbookTitle: any): boolean {
  const tags = String(yearbookTitle || '').split(/[,;]/).map(t => t.trim().toLowerCase());
  return tags.indexOf('p-yb') !== -1;
}

/**
 * Is this email the Admin contact on this deal?
 *
 * Walks deal -> associated contacts -> match on email + Admin tag. Going in
 * this direction costs fewer HubSpot calls than listing all of someone's deals
 * when we only care about one.
 */
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
  // Same-origin only. No Access-Control-Allow-Origin header is sent, so another
  // website cannot read the response from a visitor's browser. Note this stops
  // browsers, not command-line tools - the auth check below is the real guard.
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const dealId = String(req.query.dealId || '').trim();

    if (!dealId) {
      return res.status(400).json({ error: 'dealId parameter required' });
    }

    const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ error: 'Server not configured' });
    }

    // ---- 1. Who is calling? -------------------------------------------
    const email = await callerEmail(req);
    if (!email) {
      return res.status(401).json({ error: 'Please log in to your dashboard.' });
    }

    // ---- 2. Is this deal theirs? --------------------------------------
    const allowed = await ownsDeal(email, dealId, accessToken);
    if (!allowed) {
      // Same message either way, so this cannot be used to discover which
      // deal IDs exist.
      return res.status(403).json({ error: 'This dashboard is not associated with your account.' });
    }

    // ---- 3. Safe to return the data -----------------------------------
    const dealResponse = await hs(
      `/crm/v3/objects/deals/${dealId}?properties=dealname,plan_choice,submit_date,cover_due_date,final___of_books,final___of_pages,final_binding_type,book_size,paper_weight,delivery_est_,final_base_price_per_book,multi_year_term,contract_shipping,books_shipping_address,books_shipping_address_2,books_shipping_city,books_shipping_state,books_shipping_zip,optional_item_1,optional_item_1_price,optional_item_2,optional_item_2_price,optional_item_3,optional_item_3_price,invoiceurl,canva_google_drive,canva_submission_form_link,canvacoverdimensions,cover_width,cover_height,cover_gap,urgent_portal_message,portal_message_title,portal_message_type,final_review_completed,book_progress`,
      accessToken
    );

    if (!dealResponse.ok) {
      return res.status(dealResponse.status).json({
        error: `HubSpot API error: ${dealResponse.statusText}`
      });
    }

    const dealData = await dealResponse.json();
    const properties = dealData.properties || {};

    const customerData = {
      dealId: dealId,
      dealName: properties.dealname || '',
      schoolName: properties.dealname || 'School Name',
      planChoice: normalizePlanChoice(properties.plan_choice),
      numBooks: parseInt(properties.final___of_books || '0'),
      numPages: parseInt(properties.final___of_pages || '0'),
      bindingType: properties.final_binding_type || 'N/A',
      bookSize: properties.book_size || 'N/A',
      paperWeight: properties.paper_weight || 'N/A',
      submitDate: properties.submit_date || 'TBD',
      coverDueDate: properties.cover_due_date || '',
      finalReviewCompleted: properties.final_review_completed || '',
      bookProgress: properties.book_progress || '',
      deliveryDate: properties.delivery_est_ || 'TBD',
      basePricePerBook: parseFloat(properties.final_base_price_per_book || '0'),
      multiYearTerm: properties.multi_year_term || 'N/A',
      shipping: properties.contract_shipping || 'N/A',
      shipAddress: properties.books_shipping_address || '',
      shipAddress2: properties.books_shipping_address_2 || '',
      shipCity: properties.books_shipping_city || '',
      shipState: properties.books_shipping_state || '',
      shipZip: properties.books_shipping_zip || '',
      optionalItem1: properties.optional_item_1 || '',
      optionalItem1Price: parseFloat(properties.optional_item_1_price || '0'),
      optionalItem2: properties.optional_item_2 || '',
      optionalItem2Price: parseFloat(properties.optional_item_2_price || '0'),
      optionalItem3: properties.optional_item_3 || '',
      optionalItem3Price: parseFloat(properties.optional_item_3_price || '0'),
      invoiceUrl: properties.invoiceurl || '',
      canvaGoogleDrive: properties.canva_google_drive || '',
      canvaSubmissionForm: properties.canva_submission_form_link || '',
      canvaCoverDimensions: properties.canvacoverdimensions || '',
      coverWidth: properties.cover_width || '',
      coverHeight: properties.cover_height || '',
      coverGap: properties.cover_gap || '',
      urgentMessage: properties.urgent_portal_message || '',
      messageTitle: properties.portal_message_title || '',
      messageType: properties.portal_message_type || 'info'
    };

    return res.status(200).json({ success: true, data: customerData });

  } catch (error) {
    console.error('Error fetching HubSpot deal:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({
      error: 'Failed to fetch deal data',
      details: errorMessage
    });
  }
}

function normalizePlanChoice(choice: string | undefined): string {
  if (!choice) return 'Pictavo';

  const trimmed = choice.trim();
  const normalized = trimmed.toUpperCase();

  // Total Digital variants: pass the EXACT value through so the dashboard can
  // tell the three variants apart (Total Digital / DP, Total Digital - Print It, Total Digital / W).
  if (normalized.includes('TOTAL DIGITAL')) {
    return trimmed;
  }

  // Match on keywords so any variation routes correctly:
  // e.g. "Canva (DP)", "Canva (PI)", "Canva-Print (DP)", "Canva-Print (PI)" all -> Canva
  if (normalized.includes('CANVA')) {
    return 'Canva';
  }

  if (normalized.includes('YBLIVE') || normalized.includes('YB LIVE')) {
    return 'YBLive';
  }

  if (normalized.includes('PICTAVO')) {
    return 'Pictavo';
  }

  return 'Pictavo';
}
