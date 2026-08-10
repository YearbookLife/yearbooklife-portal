import { VercelRequest, VercelResponse } from '@vercel/node';

// ============================================================================
// STALE LOGIN CLEANUP
// Deletes abandoned Supabase logins (e.g. old admins who never returned after
// an admin change). Runs monthly. Conservative on purpose.
//
//  *** DRY_RUN IS CURRENTLY TRUE — NOTHING IS ACTUALLY DELETED. ***
//  When you trust it, set DRY_RUN = false to enable real deletion.
//  (There is no rush: no account will even be old enough to delete until 2027.)
// ============================================================================
const DRY_RUN = true;

// A login is "stale" if it hasn't been signed into for this many months,
// OR was created this long ago and was never signed into at all.
const STALE_MONTHS = 18;

// Safety valve: never delete more than this many accounts in a single run.
// (If a bug ever selected too many, this caps the damage.)
const MAX_DELETES_PER_RUN = 100;

// Only actually do the work about once a month, since Vercel's free tier runs
// crons daily. We act only when the day-of-month is 1 (i.e. ~once a month).
// Set to 0 to run every day (used for manual testing via the URL).
const RUN_ON_DAY_OF_MONTH = 1;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server not fully configured' });
  }

  // Allow forcing a run regardless of the day, for manual testing: ?force=1
  const force = req.query.force === '1';

  // Monthly gate (skip on other days unless forced)
  const today = new Date();
  if (!force && RUN_ON_DAY_OF_MONTH > 0 && today.getUTCDate() !== RUN_ON_DAY_OF_MONTH) {
    return res.status(200).json({
      ok: true,
      ranWork: false,
      reason: `Not the monthly run day (runs on day ${RUN_ON_DAY_OF_MONTH} of each month). Add ?force=1 to run now.`
    });
  }

  const results: any = {
    dryRun: DRY_RUN,
    staleMonths: STALE_MONTHS,
    scanned: 0,
    staleFound: 0,
    deleted: 0,
    wouldDelete: [] as any[],
    errors: [] as any[]
  };

  try {
    const cutoffMs = Date.now() - STALE_MONTHS * 30 * 24 * 60 * 60 * 1000;

    // Page through all Supabase users
    let page = 1;
    const perPage = 200;
    let keepGoing = true;

    while (keepGoing) {
      const listResp = await fetch(
        `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
        { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
      );
      if (!listResp.ok) {
        const detail = await listResp.text();
        results.errors.push({ step: 'list', page, status: listResp.status, detail: detail.substring(0, 200) });
        break;
      }
      const data = await listResp.json();
      const users = (data && data.users) ? data.users : (Array.isArray(data) ? data : []);
      if (users.length === 0) { keepGoing = false; break; }

      results.scanned += users.length;

      for (const u of users) {
        if (results.deleted >= MAX_DELETES_PER_RUN) { keepGoing = false; break; }

        const createdMs = u.created_at ? new Date(u.created_at).getTime() : 0;
        const lastSignInMs = u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : 0;

        // Stale = signed in long ago, OR never signed in and created long ago
        let stale = false;
        if (lastSignInMs > 0) {
          stale = lastSignInMs < cutoffMs;
        } else {
          stale = createdMs > 0 && createdMs < cutoffMs;
        }

        if (!stale) continue;
        results.staleFound++;

        const record = {
          id: u.id,
          email: u.email,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at || '(never)'
        };

        if (DRY_RUN) {
          // Report only — do NOT delete
          if (results.wouldDelete.length < 500) results.wouldDelete.push(record);
        } else {
          // Real delete
          const delResp = await fetch(
            `${supabaseUrl}/auth/v1/admin/users/${u.id}`,
            { method: 'DELETE', headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
          );
          if (delResp.ok) {
            results.deleted++;
          } else {
            results.errors.push({ step: 'delete', id: u.id, email: u.email, status: delResp.status });
          }
        }
      }

      // Stop if we got a partial page (means we're at the end)
      if (users.length < perPage) keepGoing = false;
      else page++;
      if (page > 50) keepGoing = false; // hard stop safety (max ~10,000 users)
    }

    return res.status(200).json({ ok: true, ranWork: true, ...results });

  } catch (error) {
    console.error('cron-cleanup-stale-users error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'cleanup failed', detail: msg, results });
  }
}
