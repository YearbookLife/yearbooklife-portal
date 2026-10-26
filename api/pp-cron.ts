import { VercelRequest, VercelResponse } from '@vercel/node';
import {
  ppEnabled, configured, currentStaff, dbSelect, dbUpdate, eq, licenseState, sendEmail, emailLayout, esc, baseUrl,
  alertEmail, REMINDER_DAYS_BEFORE, fetchCustomerDeals, compareDeal, logEvent, dbSelectAll, dbSelectIds
} from '../lib/pp';

/**
 * PORTRAITPOP LICENSING: NIGHTLY JOB (runs 6 AM UTC, after the dashboard's jobs)
 *
 *  1. Reminder email to the school admin and photographer about a week before a
 *     school's 60 days run out (sent once).
 *  2. Mid-season check: if a licensed school now shows up as a YearbookLife
 *     customer in HubSpot, email YearbookLife. The school's access is NOT changed.
 *  3. Unusual activity: lots of exports, or use from many different places in one
 *     day, gets reported so someone can look.
 *
 * One summary email goes to PP_ALERT_EMAIL, only when there is something to report.
 * Add ?dry=1 to see what it would do without sending or saving anything.
 */

const EXPORTS_PER_DAY_ALERT = Number(process.env.PP_EXPORT_ALERT || 40);
const LOCATIONS_PER_DAY_ALERT = 3;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!ppEnabled()) return res.status(200).json({ ok: true, skipped: 'PP_ENABLED is not true' });
  if (!configured().ok) return res.status(500).json({ ok: false, error: 'not configured' });

  // Two ways in: Vercel's scheduler (sends CRON_SECRET), or signed-in staff doing
  // a dry-run preview. Anyone else is turned away.
  const dry = String(req.query.dry || '') === '1';
  const staff = currentStaff(req);
  const secret = process.env.CRON_SECRET;
  const fromScheduler = !!secret && req.headers.authorization === 'Bearer ' + secret;
  if (!fromScheduler && !(dry && staff)) {
    if (!secret) console.error('pp-cron: CRON_SECRET is not set in Vercel, so the nightly job cannot run');
    return res.status(401).json({ ok: false });
  }
  const base = baseUrl(req);
  const report = { reminders: [] as string[], yblMatches: [] as string[], unusual: [] as string[], notes: [] as string[] };

  try {
    const lics = await dbSelectAll('pp_licenses', 'status=in.(invited,active)&select=*&order=id');
    const phIds = Array.from(new Set(lics.map(l => l.photographer_id)));
    const phs = await dbSelectIds('pp_photographers', phIds, 'select=*');
    const phById: Record<string, any> = {};
    phs.forEach(p => { phById[p.id] = p; });

    // 1) Reminders
    const soon = Date.now() + REMINDER_DAYS_BEFORE * 86400000;
    for (const l of lics) {
      if (licenseState(l) !== 'active' || l.reminder_sent_at || !l.expires_at) continue;
      if (Date.parse(l.expires_at) > soon) continue;
      const ph = phById[l.photographer_id] || {};
      const endDate = new Date(l.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      report.reminders.push(l.school_name + ' (' + l.admin_email + ') ends ' + endDate);
      if (dry) continue;
      await sendEmail(l.admin_email, 'Your PortraitPop access ends ' + endDate,
        emailLayout(base, 'Your PortraitPop access ends soon',
          '<p>PortraitPop access for <b>' + esc(l.school_name) + '</b> ends on <b>' + esc(endDate) + '</b>.</p>'
          + '<p>If you still have portrait pages to build, now is a good time to finish and export them. '
          + 'If you need more time, contact ' + esc(ph.company || ph.name || 'your photographer') + '.</p>',
          { label: 'Open PortraitPop', url: base + '/pp' }));
      if (ph.email) {
        await sendEmail(ph.email, 'PortraitPop: ' + l.school_name + ' ends ' + endDate,
          emailLayout(base, 'A school’s access ends soon',
            '<p><b>' + esc(l.school_name) + '</b> (' + esc(l.admin_email) + ') has PortraitPop until <b>' + esc(endDate) + '</b>. '
            + 'We’ve let the admin know too.</p>'));
      }
      await dbUpdate('pp_licenses', 'id=' + eq(l.id), { reminder_sent_at: new Date().toISOString() });
    }

    // 2) Mid-season YearbookLife check
    const toCheck = lics.filter(l => !l.ybl_flagged_at && licenseState(l) !== 'expired');
    if (toCheck.length) {
      const { deals, complete } = await fetchCustomerDeals(6000);
      if (!complete) report.notes.push('HubSpot check ran out of time and only looked at ' + deals.length + ' deals. Schools not matched tonight will be checked again tomorrow.');
      for (const l of toCheck) {
        const input = { name: l.school_name, city: l.school_city, state: l.school_state, zip: l.school_zip, adminEmail: l.admin_email };
        const hit = deals.find(d => compareDeal(input, d.properties || {}).block);
        if (!hit) continue;
        const detail = 'Now matches YearbookLife deal "' + String(hit.properties.dealname).trim() + '" (HubSpot deal ' + hit.id + ')';
        const ph = phById[l.photographer_id] || {};
        report.yblMatches.push(l.school_name + ', ' + l.school_city + ', ' + l.school_state + ' (license ' + l.code + ', photographer ' + (ph.name || '?') + '): ' + detail);
        if (!dry) {
          await dbUpdate('pp_licenses', 'id=' + eq(l.id), { ybl_flagged_at: new Date().toISOString(), ybl_flag_detail: detail });
          await logEvent('ybl-match-midseason', { license_id: l.id, photographer_id: l.photographer_id, detail: { detail } });
        }
      }
    }

    // 3) Unusual activity in the last 24 hours
    const since = new Date(Date.now() - 86400000).toISOString();
    const events = await dbSelectAll('pp_events', 'at=gte.' + encodeURIComponent(since)
      + '&kind=in.(export,tool-opened,signin-admin,activated,device-limit)&select=kind,license_id,ip_hash&order=id');
    const per: Record<string, { exports: number; places: Set<string>; deviceLimit: number }> = {};
    events.forEach(e => {
      if (!e.license_id) return;
      const p = per[e.license_id] || (per[e.license_id] = { exports: 0, places: new Set(), deviceLimit: 0 });
      if (e.kind === 'export') p.exports++;
      if (e.kind === 'device-limit') p.deviceLimit++;
      if (e.ip_hash) p.places.add(e.ip_hash);
    });
    const allLics = await dbSelectIds('pp_licenses', Object.keys(per), 'select=id,code,school_name,admin_email,photographer_id');
    for (const l of allLics) {
      const p = per[l.id];
      const why: string[] = [];
      if (p.exports > EXPORTS_PER_DAY_ALERT) why.push(p.exports + ' exports');
      if (p.places.size > LOCATIONS_PER_DAY_ALERT) why.push('used from ' + p.places.size + ' different internet connections');
      if (p.deviceLimit >= 3) why.push(p.deviceLimit + ' sign-ins blocked by the device limit');
      if (!why.length) continue;
      const ph = phById[l.photographer_id] || (await dbSelect('pp_photographers', 'id=' + eq(l.photographer_id) + '&select=name'))[0] || {};
      report.unusual.push(l.school_name + ' (' + l.admin_email + ', license ' + l.code + ', photographer ' + (ph.name || '?') + '): ' + why.join(', '));
      if (!dry) await logEvent('unusual-activity', { license_id: l.id, photographer_id: l.photographer_id, detail: { why } });
    }

    // Photographers repeatedly hitting the YearbookLife block (could be probing the customer list)
    const blocked = await dbSelectAll('pp_events', 'at=gte.' + encodeURIComponent(since) + '&kind=eq.blocked-ybl&select=photographer_id&order=id');
    const blockedBy: Record<string, number> = {};
    blocked.forEach(e => { if (e.photographer_id) blockedBy[e.photographer_id] = (blockedBy[e.photographer_id] || 0) + 1; });
    for (const pid of Object.keys(blockedBy)) {
      if (blockedBy[pid] < 5) continue;
      const ph = phById[pid] || (await dbSelect('pp_photographers', 'id=' + eq(pid) + '&select=name,email'))[0] || {};
      report.unusual.push((ph.name || '?') + ' (' + (ph.email || '') + ') tried ' + blockedBy[pid] + ' YearbookLife schools in the last 24 hours');
    }

    // Summary email
    const anything = report.reminders.length + report.yblMatches.length + report.unusual.length + report.notes.length;
    if (anything && !dry) {
      const section = (title: string, items: string[]) => items.length
        ? '<h3 style="font-size:15px;margin:20px 0 6px">' + esc(title) + '</h3><ul>' + items.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul>' : '';
      await sendEmail(alertEmail(), 'PortraitPop licensing: nightly report',
        emailLayout(base, 'PortraitPop licensing: nightly report',
          section('Licensed schools now with YearbookLife (access not changed)', report.yblMatches)
          + section('Unusual activity in the last 24 hours', report.unusual)
          + section('Reminder emails sent (access ending within ' + REMINDER_DAYS_BEFORE + ' days)', report.reminders)
          + section('Notes', report.notes)
          + '<p><a href="' + esc(base) + '/pp">Open the staff page</a></p>'));
    }

    // Details only go by email (or to staff on a dry run), never to an anonymous caller.
    const counts = { reminders: report.reminders.length, yblMatches: report.yblMatches.length, unusual: report.unusual.length, notes: report.notes.length };
    return res.status(200).json(staff ? { ok: true, dry, ...report } : { ok: true, ...counts });
  } catch (e) {
    console.error('pp-cron error:', e);
    return res.status(500).json({ ok: false, error: 'nightly job failed; see Vercel logs' });
  }
}
