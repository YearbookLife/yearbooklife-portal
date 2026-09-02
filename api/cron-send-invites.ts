import { VercelRequest, VercelResponse } from '@vercel/node';
import nodemailer from 'nodemailer';

const HS = 'https://api.hubapi.com';

// The Won-type stage IDs that should trigger a dashboard invite.
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

const DELAY_HOURS = 4; // Deals close by 5PM; sweep is 11PM (6h later), so same-day deals still go out that night. Small buffer for late edge cases.

// ============ SAFETY: TEST MODE ============
// While TEST_MODE is true, the function ONLY processes deals whose ID is in
// TEST_DEAL_IDS. Every other deal is ignored, so real customers are never touched.
// When you're ready to go live for everyone, set TEST_MODE = false.
const TEST_MODE = false;
const TEST_DEAL_IDS = ['62706477603']; // add more test deal IDs here as needed
// ===========================================

// Cap so we drip-feed the backlog at go-live.
// NOTE: this must stay at or below the Supabase email rate limit
// (Supabase dashboard -> Authentication -> Rate Limits -> "Rate limit for sending emails").
// Anything above that limit fails with a 429 and simply retries the next night.
const MAX_INVITES_PER_RUN = 75;

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

// Delete-at-renewal: before sending a fresh invite, remove any EXISTING Supabase
// login for this email so the customer gets a clean new setup. This is safe for
// everyone: first-time customers have no existing login (nothing happens); returning
// customers get their old login cleared so the new invite creates a fresh one.
async function deleteExistingUser(supabaseUrl: string, serviceKey: string, email: string): Promise<string> {
  try {
    // Look up the user by email via the admin API
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

    // Delete that user
    const delResp = await fetch(
      supabaseUrl + '/auth/v1/admin/users/' + match.id,
      { method: 'DELETE', headers: { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey } }
    );
    return delResp.ok ? 'deleted-existing' : 'delete-failed';
  } catch (e) {
    return 'delete-error';
  }
}

// Send a short nightly summary of the cron run to the team.
// This is best-effort: if it fails, the cron still succeeds (invites already sent).
const REPORT_TO = 'heather@yearbooklife.com, production@yearbooklife.com';

async function sendRunReport(results: any, testMode: boolean): Promise<void> {
  try {
    const user = process.env.GMAIL_USER;       // Dashboard@yearbooklife.com
    const pass = process.env.GMAIL_APP_PASSWORD; // the 16-char app password
    if (!user || !pass) return; // no creds configured -> skip silently

    const invited = (results.invited || []).length;
    const errors = (results.errors || []).length;
    const skipped = (results.skipped || []).length;
    const checked = results.checked || 0;

    const invitedLines = (results.invited || [])
      .map(function (i: any) { return '  \u2022 ' + i.adminEmail + ' (deal ' + i.dealId + ')'; })
      .join('\n') || '  (none)';
        const errorLines = (results.errors || [])
      .map(function (e: any) { return '  \u2022 deal ' + e.dealId + ': ' + (e.detail || e.status || 'error'); })
      .join('\n') || '  (none)';

    // Group the skipped deals by reason so we can see WHY they were skipped
    const skipCounts: any = {};
    (results.skipped || []).forEach(function (s: any) {
      const r = s.reason || 'unknown';
      skipCounts[r] = (skipCounts[r] || 0) + 1;
    });
    const skippedLines = Object.keys(skipCounts)
      .map(function (r) { return '  \u2022 ' + skipCounts[r] + ' \u2014 ' + r; })
      .join('\n') || '  (none)';

    const subject = 'Dashboard Invites \u2014 ' + invited + ' sent, ' + errors + ' errors'
      + (testMode ? ' [TEST MODE]' : '');

    const body =
      'Nightly dashboard invite run summary\n' +
      '=====================================\n\n' +
      (testMode ? '*** TEST MODE IS ON \u2014 only test deals processed ***\n\n' : '') +
      'Deals checked: ' + checked + '\n' +
      'Invites sent:  ' + invited + '\n' +
      'Skipped:       ' + skipped + '\n' +
      'Errors:        ' + errors + '\n\n' +
            'Skipped (by reason):\n' + skippedLines + '\n\n' +
      'Invited:\n' + invitedLines + '\n\n' +
      'Errors:\n' + errorLines + '\n\n' +
      'Time: ' + new Date().toISOString() + '\n';

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: user, pass: pass }
    });

    await transporter.sendMail({
      from: 'YearbookLife Dashboard <' + user + '>',
      to: REPORT_TO,
      subject: subject,
      text: body
    });
  } catch (e) {
    // Never let a report failure break the cron
    console.warn('run report email failed (ignored):', e);
  }
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
    const cutoff = Date.now() - DELAY_HOURS * 60 * 60 * 1000; // closedate must be before this

    // 1) Find deals to consider.
    // TEST MODE: look up ONLY the specific test deals.
    // LIVE MODE: scan the Won stages for deals not yet invited.
    let searchBody: any;
    if (TEST_MODE) {
      searchBody = {
        filterGroups: [{
          filters: [
            { propertyName: 'hs_object_id', operator: 'IN', values: TEST_DEAL_IDS }
          ]
        }],
        properties: ['dealname', 'dealstage', 'portal_activated', 'closedate', 'dashboard_invite_sent'],
        limit: 100
      };
    } else {
            searchBody = {
        filterGroups: [{
          filters: [
            { propertyName: 'dealstage', operator: 'IN', values: WON_STAGE_IDS },
            { propertyName: 'dashboard_invite_sent', operator: 'NOT_HAS_PROPERTY' },
            // Without this, the search returns every Won deal back to 2017. Those old
            // deals have no portal_activated flag, so they get skipped every night and
            // permanently occupy all 100 slots — the queue never drains.
            { propertyName: 'portal_activated', operator: 'EQ', value: 'true' }
          ]
        }],
        // Explicit order so the backlog drains predictably, oldest first.
        sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }],
        properties: ['dealname', 'dealstage', 'portal_activated', 'closedate', 'dashboard_invite_sent'],
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

    let invitesThisRun = 0;

    for (const deal of deals) {
      const dealId = deal.id;
      const props = deal.properties || {};

      // SAFETY: in test mode, only process explicitly-allowed test deals
      if (TEST_MODE && TEST_DEAL_IDS.indexOf(String(dealId)) === -1) {
        results.skipped.push({ dealId, reason: 'test mode - not an allowed test deal' });
        continue;
      }

      // Verify the deal is actually in one of the qualifying Won/Multi-Year stages.
      // (In live mode the search already filters by stage; in test mode it does not,
      //  so this makes the test meaningful — the stage ID must genuinely match.)
      if (WON_STAGE_IDS.indexOf(String(props.dealstage)) === -1) {
        results.skipped.push({ dealId, reason: 'stage not in the qualifying list', dealstage: props.dealstage });
        continue;
      }

      // Respect the per-run cap (drip-feeds the backlog at go-live)
      if (invitesThisRun >= MAX_INVITES_PER_RUN) {
        results.skipped.push({ dealId, reason: 'per-run cap reached' });
        continue;
      }

      // Guard against re-sending: if already stamped, skip. (Belt-and-suspenders;
      // live search already excludes these, but test mode search does not.)
      if (props.dashboard_invite_sent) {
        results.skipped.push({ dealId, reason: 'invite already sent' });
        continue;
      }

      // Must be portal-activated
      if (!isActivatedPortal(props.portal_activated)) {
        results.skipped.push({ dealId, reason: 'portal not activated' });
        continue;
      }

      // Must be at least DELAY_HOURS past the close date
      const closeStr = props.closedate;
      const closeMs = closeStr ? new Date(closeStr).getTime() : 0;
      if (!closeMs) {
        results.skipped.push({ dealId, reason: 'no close date' });
        continue;
      }
      if (closeMs > cutoff) {
        results.skipped.push({ dealId, reason: 'still within delay window', closedate: closeStr });
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

      // Delete-at-renewal: clear any existing login for this email first, so a
      // returning admin gets a clean fresh setup. Harmless for first-time customers.
      const delResult = await deleteExistingUser(supabaseUrl, serviceKey, adminEmail);

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
      const alreadyExists = inviteText.toLowerCase().includes('already') || inviteText.toLowerCase().includes('registered');

      // If we could not clear the old login, "already registered" does NOT mean the
      // customer was emailed — it means the stale login blocked the invite. Treat that
      // as an error so it retries tomorrow instead of being stamped as sent.
      const deleteFailed = (delResult === 'delete-failed' || delResult === 'lookup-failed' || delResult === 'delete-error');

      if (inviteOk || (alreadyExists && !deleteFailed)) {
        const now = new Date();
        const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        await hs(`/crm/v3/objects/deals/${dealId}`, hubspotToken, {
          method: 'PATCH',
          body: JSON.stringify({ properties: { dashboard_invite_sent: utcMidnight } })
        });
        invitesThisRun++;
        results.invited.push({ dealId, adminEmail, note: inviteOk ? 'invited' : 'already existed (stamped anyway)', deleteStep: delResult });
      } else {
        results.errors.push({ dealId, adminEmail, status: inviteResp.status, detail: (deleteFailed ? 'login delete failed (' + delResult + ') \u2014 ' : '') + inviteText.substring(0, 200) });
      }
    }

    // Best-effort nightly summary email (won't block or fail the cron)
    await sendRunReport(results, TEST_MODE);

    return res.status(200).json({ ok: true, ...results });

  } catch (error) {
    console.error('cron-send-invites error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'cron failed', detail: msg, results });
  }
}
