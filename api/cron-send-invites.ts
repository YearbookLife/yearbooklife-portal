import { VercelRequest, VercelResponse } from '@vercel/node';

const HS = 'https://api.hubapi.com';

// The 8 Won-type stage IDs that should trigger a dashboard invite.
// (From the pipeline list we pulled.)
const WON_STAGE_IDS = [
  '995123631',   // Traditional PL Pipeline -> Won (Restored)
  '997997495',   // Print Order (Renewal) -> WON
  '995003294',   // Band Book Lead -> Won
  '999965603',   // Military Book Lead -> WON
  '1000097294',  // Media Guide Lead -> WON
  '1000850703',  // Dance/Cheer Lead -> WON
  '1000822951',  // Church Directory Lead -> WON
  '999098015'    // Doggy Day Care Lead -> WON
];

const DELAY_HOURS = 0; // TEMPORARILY 0 FOR TESTING — set back to 12 before go-live!

// ============ SAFETY: TEST MODE ============
// While TEST_MODE is true, the function ONLY processes deals whose ID is in
// TEST_DEAL_IDS. Every other deal is ignored, so real customers are never touched.
// When you're ready to go live for everyone, set TEST_MODE = false.
const TEST_MODE = true;
const TEST_DEAL_IDS = ['62706477603']; // add more test deal IDs here as needed
// ===========================================

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!hubspotToken || !supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server not fully configured' });
  }

  const results: any = { testMode: TEST_MODE, checked: 0, invited: [], skipped: [], errors: [] };

  try {
    const cutoff = Date.now() - DELAY_HOURS * 60 * 60 * 1000; // must have entered Won stage before this

    // 1) Find deals to consider.
    // In TEST MODE we look up ONLY the specific test deals (so testing is reliable and
    // doesn't depend on where they fall in a 100-deal scan). In live mode we scan Won stages.
    let searchBody: any;
    if (TEST_MODE) {
      searchBody = {
        filterGroups: [{
          filters: [
            { propertyName: 'hs_object_id', operator: 'IN', values: TEST_DEAL_IDS }
          ]
        }],
        properties: ['dealname', 'dealstage', 'portal_activated', 'hs_date_entered_current_stage', 'dashboard_invite_sent'],
        limit: 100
      };
    } else {
      searchBody = {
        filterGroups: [{
          filters: [
            { propertyName: 'dealstage', operator: 'IN', values: WON_STAGE_IDS },
            { propertyName: 'dashboard_invite_sent', operator: 'NOT_HAS_PROPERTY' }
          ]
        }],
        properties: ['dealname', 'dealstage', 'portal_activated', 'hs_date_entered_current_stage', 'dashboard_invite_sent'],
        limit: 100
      };
    }

    const searchResp = await hs('/crm/v3/objects/deals/search', hubspotToken, {
      method: 'POST',
      body: JSON.stringify(searchBody)
    });

    if (!searchResp.ok) {
      const detail = await searchResp.text();
      return res.status(searchResp.status).json({ error: 'Deal search failed', detail });
    }

    const deals = (await searchResp.json()).results || [];
    results.checked = deals.length;

    for (const deal of deals) {
      const dealId = deal.id;
      const props = deal.properties || {};

      // SAFETY: in test mode, only process explicitly-allowed test deals
      if (TEST_MODE && TEST_DEAL_IDS.indexOf(String(dealId)) === -1) {
        results.skipped.push({ dealId, reason: 'test mode - not an allowed test deal' });
        continue;
      }

      // Must be portal-activated
      if (!isActivatedPortal(props.portal_activated)) {
        results.skipped.push({ dealId, reason: 'portal not activated' });
        continue;
      }

      // Must have been in the Won stage for at least DELAY_HOURS
      const enteredStr = props.hs_date_entered_current_stage;
      const enteredMs = enteredStr ? new Date(enteredStr).getTime() : 0;
      if (!enteredMs || enteredMs > cutoff) {
        results.skipped.push({
          dealId,
          reason: 'still within delay window',
          enteredStage: enteredStr,
          enteredMs,
          cutoff,
          nowMs: Date.now(),
          delayHours: DELAY_HOURS
        });
        continue;
      }

      // Find the Admin contact's email
      const assocResp = await hs(`/crm/v3/objects/deals/${dealId}/associations/contacts`, hubspotToken);
      if (!assocResp.ok) { results.skipped.push({ dealId, reason: 'assoc read failed' }); continue; }
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

      if (!adminEmail) { results.skipped.push({ dealId, reason: 'no admin email' }); continue; }

      // Send the Supabase invite
      const inviteResp = await fetch(`${supabaseUrl}/auth/v1/invite`, {
        method: 'POST',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email: adminEmail })
      });

      const inviteOk = inviteResp.ok;
      const inviteText = await inviteResp.text();

      // Stamp dashboard_invite_sent regardless of "already exists" so we don't loop forever.
      // (If the invite genuinely failed for another reason, we log it.)
      const alreadyExists = inviteText.toLowerCase().includes('already') || inviteText.toLowerCase().includes('registered');

      if (inviteOk || alreadyExists) {
        const now = new Date();
        const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        await hs(`/crm/v3/objects/deals/${dealId}`, hubspotToken, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { dashboard_invite_sent: utcMidnight } })
        });
        results.invited.push({ dealId, adminEmail, note: inviteOk ? 'invited' : 'already existed (stamped anyway)' });
      } else {
        results.errors.push({ dealId, adminEmail, status: inviteResp.status, detail: inviteText.substring(0, 200) });
      }
    }

    return res.status(200).json({ ok: true, ...results });

  } catch (error) {
    console.error('cron-send-invites error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'cron failed', detail: msg, results });
  }
}
