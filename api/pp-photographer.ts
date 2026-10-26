import { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guard, body, currentPhotographer, dbSelect, dbUpdate, dbRpc, eq, cleanEmail, cleanText, stateCode,
  checkYearbookLifeSchool, createLoginLink, sendEmail, emailLayout, esc, baseUrl, INVITE_LINK_MS,
  LICENSE_DAYS, licenseState, daysLeft, logEvent, alertEmail, schoolWords, dbSelectAll, recentCount
} from '../lib/pp';

// Limits per photographer, so the shared email account and HubSpot aren't overused.
const MAX_SENDS_PER_HOUR = 30;        // license sends + admin changes, including blocked tries
const MAX_SENDS_PER_DAY = 150;
const MAX_RESENDS_PER_HOUR = 20;
const SEND_KINDS = ['admin-replaced', 'send-attempt'];

async function tooMany(ph: any, kinds: string[], perHour: number, perDay?: number): Promise<boolean> {
  if (await recentCount(ph.id, kinds, 3600000) >= perHour) return true;
  if (perDay && await recentCount(ph.id, kinds, 86400000) >= perDay) return true;
  return false;
}

/**
 * PORTRAITPOP ACCOUNTS: PHOTOGRAPHER
 *
 * GET                                     -> licenses, schools and their status
 * POST { action: 'send', ... }            -> send a license to a school admin
 * POST { action: 'resend', licenseId }    -> email the admin a fresh link
 * POST { action: 'replace', licenseId, adminName, adminEmail } -> hand the school to a different admin
 * POST { action: 'remove', licenseId }    -> take access away
 * POST { action: 'reset-devices', licenseId }
 */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!guard(req, res, ['GET', 'POST'])) return;

  try {
    const me = await currentPhotographer(req);
    if (!me) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
    const ph = me.photographer;

    if (req.method === 'GET') return await summary(res, ph);

    const b = body(req);
    if (b.action === 'send') return await send(req, res, ph, b);

    // Everything else acts on one of this photographer's licenses.
    const lic = b.licenseId
      ? (await dbSelect('pp_licenses', 'id=' + eq(String(b.licenseId)) + '&photographer_id=' + eq(ph.id) + '&select=*'))[0]
      : null;
    if (!lic) return res.status(404).json({ ok: false, error: 'That school wasn’t found on your account.' });
    const state = licenseState(lic);

    if (b.action === 'resend') {
      if (await tooMany(ph, ['invite-resent'], MAX_RESENDS_PER_HOUR)) return res.status(429).json({ ok: false, error: 'Too many links sent in the last hour. Please try again later.' });
      if (state !== 'invited' && state !== 'active') return res.status(400).json({ ok: false, error: 'This school no longer has access, so there is nothing to resend.' });
      const ok = await inviteAdmin(req, ph, lic);
      await logEvent('invite-resent', { req, email: me.session.e, license_id: lic.id, photographer_id: ph.id });
      return res.status(ok ? 200 : 502).json(ok ? { ok: true, message: 'A new link was emailed to ' + lic.admin_email + '.' }
                                                : { ok: false, error: 'The email didn’t send. Please try again.' });
    }

    if (b.action === 'reset-devices') {
      if (state !== 'invited' && state !== 'active') return res.status(400).json({ ok: false, error: 'This school no longer has access.' });
      await dbUpdate('pp_licenses', 'id=' + eq(lic.id), { devices: [], session_id: null });
      await logEvent('devices-reset', { req, email: me.session.e, license_id: lic.id, photographer_id: ph.id });
      return res.status(200).json({ ok: true, message: 'Devices cleared. ' + (lic.admin_name || lic.admin_email) + ' can now sign in on up to two computers again.' });
    }

    if (b.action === 'replace') {
      if (state !== 'invited' && state !== 'active') return res.status(400).json({ ok: false, error: 'This school no longer has access.' });
      const adminEmail = cleanEmail(b.adminEmail);
      const adminName = cleanText(b.adminName, 80);
      if (!adminEmail) return res.status(400).json({ ok: false, error: 'Please enter a valid email for the new admin.' });
      if (await tooMany(ph, SEND_KINDS, MAX_SENDS_PER_HOUR, MAX_SENDS_PER_DAY)) return res.status(429).json({ ok: false, error: 'You’ve made a lot of changes in a short time. Please try again later.' });

      const check = await checkYearbookLifeSchool({
        name: lic.school_name, city: lic.school_city, state: lic.school_state, zip: lic.school_zip, adminEmail
      });
      if (check.error) return res.status(503).json({ ok: false, error: 'We couldn’t finish checking this admin just now. Nothing was changed. Please try again in a few minutes.' });
      if (check.block) {
        await logEvent('blocked-ybl', { req, email: me.session.e, license_id: lic.id, photographer_id: ph.id, detail: { detail: check.detail, adminEmail } });
        return res.status(409).json({ ok: false, error: 'That admin is with a school that already works with YearbookLife, so PortraitPop can’t be licensed to them. Nothing was changed.' });
      }

      await retireLinks(lic.id);
      const updated = (await dbUpdate('pp_licenses', 'id=' + eq(lic.id), {
        admin_email: adminEmail, admin_name: adminName, session_id: null, devices: [], invited_at: new Date().toISOString()
      }))[0];
      const ok = await inviteAdmin(req, ph, updated);
      await logEvent('admin-replaced', { req, email: me.session.e, license_id: lic.id, photographer_id: ph.id, detail: { from: lic.admin_email, to: adminEmail } });
      return res.status(200).json({ ok: true, message: lic.admin_email + ' no longer has access. ' + (ok ? 'An invitation was emailed to ' + adminEmail + '.' : 'The invitation email didn’t send. Use Resend link.') });
    }

    if (b.action === 'remove') {
      await retireLinks(lic.id);
      if (state === 'invited') {
        // Never used: the license goes back to the photographer.
        await dbUpdate('pp_licenses', 'id=' + eq(lic.id), {
          status: 'available', school_name: '', school_city: '', school_state: '', school_zip: '',
          admin_name: '', admin_email: '', invited_at: null, session_id: null, devices: [],
          ybl_flagged_at: null, ybl_flag_detail: ''
        });
        await logEvent('invite-cancelled', { req, email: me.session.e, license_id: lic.id, photographer_id: ph.id, detail: { school: lic.school_name } });
        return res.status(200).json({ ok: true, message: 'Invitation cancelled. The license was returned to your account because it was never used.' });
      }
      if (state === 'active' || state === 'expired') {
        await dbUpdate('pp_licenses', 'id=' + eq(lic.id), { status: 'revoked', revoked_at: new Date().toISOString(), session_id: null });
        await logEvent('access-removed', { req, email: me.session.e, license_id: lic.id, photographer_id: ph.id, detail: { school: lic.school_name } });
        return res.status(200).json({ ok: true, message: (lic.school_name || 'This school') + ' no longer has access.' });
      }
      return res.status(400).json({ ok: false, error: 'This school already has no access.' });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    console.error('pp-photographer error:', e);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

async function summary(res: VercelResponse, ph: any) {
  const lics = await dbSelectAll('pp_licenses', 'photographer_id=' + eq(ph.id) + '&select=*&order=created_at.desc,id');
  const counts = { available: 0, invited: 0, active: 0, expired: 0, revoked: 0, total: lics.length };
  const schools: any[] = [];
  for (const l of lics) {
    const st = licenseState(l);
    (counts as any)[st]++;
    if (st === 'available') continue;
    schools.push({
      id: l.id, code: l.code, state: st,
      school: { name: l.school_name, city: l.school_city, state: l.school_state, zip: l.school_zip },
      admin: { name: l.admin_name, email: l.admin_email },
      invitedAt: l.invited_at, activatedAt: l.activated_at, expiresAt: l.expires_at, daysLeft: daysLeft(l),
      devices: Array.isArray(l.devices) ? l.devices.length : 0
    });
  }
  return res.status(200).json({
    ok: true,
    photographer: { name: ph.name, company: ph.company, email: ph.email },
    counts, schools, licenseDays: LICENSE_DAYS
  });
}

async function retireLinks(licenseId: string) {
  await dbUpdate('pp_login_tokens', 'license_id=' + eq(licenseId) + '&used_at=is.null', { used_at: new Date().toISOString() });
}

async function inviteAdmin(req: VercelRequest, ph: any, lic: any): Promise<boolean> {
  const base = baseUrl(req);
  const url = await createLoginLink(base, lic.admin_email, 'admin', lic.id, INVITE_LINK_MS);
  const from = ph.company || ph.name || 'Your photographer';
  const hello = lic.admin_name ? 'Hi ' + esc(lic.admin_name.split(' ')[0]) + ',' : 'Hello,';
  const timing = licenseState(lic) === 'active'
    ? '<p>Your access runs until <b>' + esc(new Date(lic.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })) + '</b>.</p>'
    : '<p>Your access lasts <b>' + LICENSE_DAYS + ' days</b>, starting the first time you sign in, so sign in when you are ready to build your portrait pages.</p>';
  const html = emailLayout(base, 'You’re set up to use PortraitPop',
    '<p>' + hello + '</p>'
    + '<p><b>' + esc(from) + '</b> has given <b>' + esc(lic.school_name) + '</b> access to PortraitPop, '
    + 'which lays out your yearbook portrait pages and exports them for Canva.</p>'
    + timing
    + '<p>Student photos and names stay on your computer. They are never uploaded.</p>'
    + '<p style="font-size:13px;color:#64748b">This link is just for you and works once. Next time, go to the sign-in page and enter your email to get a new link.</p>',
    { label: 'Open my PortraitPop account', url });
  return sendEmail(lic.admin_email, 'PortraitPop access for ' + (lic.school_name || 'your school'), html);
}

async function send(req: VercelRequest, res: VercelResponse, ph: any, b: any) {
  const school = {
    name: cleanText(b.schoolName, 120),
    city: cleanText(b.city, 60),
    state: stateCode(b.state),
    zip: (String(b.zip || '').match(/\d{5}/) || [''])[0]
  };
  const adminEmail = cleanEmail(b.adminEmail);
  const adminName = cleanText(b.adminName, 80);

  if (!school.name || !schoolWords(school.name).length) return res.status(400).json({ ok: false, error: 'Please enter the school’s full name.' });
  if (!school.city) return res.status(400).json({ ok: false, error: 'Please enter the school’s city.' });
  if (!school.state) return res.status(400).json({ ok: false, error: 'Please pick the school’s state.' });
  if (!school.zip) return res.status(400).json({ ok: false, error: 'Please enter the school’s 5-digit zip code.' });
  if (!adminEmail) return res.status(400).json({ ok: false, error: 'Please enter a valid email for the school’s yearbook admin.' });

  if (await tooMany(ph, SEND_KINDS, MAX_SENDS_PER_HOUR, MAX_SENDS_PER_DAY)) {
    return res.status(429).json({ ok: false, error: 'You’ve sent a lot of licenses in a short time. Please try again later, or call YearbookLife at 888-680-0143.' });
  }

  // Quick checks before the slower HubSpot lookup.
  const key = schoolWords(school.name).sort().join(' ');
  const findDup = async () => {
    const live = await dbSelectAll('pp_licenses', 'photographer_id=' + eq(ph.id) + '&status=in.(invited,active)&select=id,status,expires_at,school_name,school_state&order=id');
    return live.find(l => (licenseState(l) === 'invited' || licenseState(l) === 'active')
      && l.school_state === school.state && schoolWords(l.school_name).sort().join(' ') === key);
  };
  const unused = await dbSelect('pp_licenses', 'photographer_id=' + eq(ph.id) + '&status=eq.available&select=id&limit=1');
  if (!unused.length) {
    return res.status(409).json({ ok: false, error: 'You don’t have any unused licenses. Call YearbookLife at 888-680-0143 to buy more.' });
  }
  const dupMsg = (d: any) => d.school_name + ' already has a PortraitPop license from you. Use Resend link or Change admin on that school instead.';
  let dup = await findDup();
  if (dup) return res.status(409).json({ ok: false, error: dupMsg(dup) });
  await logEvent('send-attempt', { req, email: ph.email, photographer_id: ph.id });

  const check = await checkYearbookLifeSchool({ ...school, adminEmail });
  if (check.error) {
    return res.status(503).json({ ok: false, error: 'We couldn’t finish checking this school just now. No license was used. Please try again in a few minutes.' });
  }
  if (check.block) {
    await logEvent('blocked-ybl', { req, email: ph.email, photographer_id: ph.id, detail: { school, adminEmail, detail: check.detail } });
    return res.status(409).json({ ok: false, blocked: true,
      error: school.name + ' already works with YearbookLife, so it can’t be given a PortraitPop license. No license was used. If you think this is a mistake, call YearbookLife at 888-680-0143.' });
  }

  // Check again: a double-click may have licensed this school while HubSpot was checked.
  dup = await findDup();
  if (dup) return res.status(409).json({ ok: false, error: dupMsg(dup) });

  const claimed = await dbRpc('pp_claim_license', { p_photographer: ph.id });
  const licenseId = Array.isArray(claimed) ? claimed[0] : claimed;
  if (!licenseId) return res.status(409).json({ ok: false, error: 'You don’t have any unused licenses. Call YearbookLife at 888-680-0143 to buy more.' });

  const now = new Date().toISOString();
  const lic = (await dbUpdate('pp_licenses', 'id=' + eq(String(licenseId)), {
    school_name: school.name, school_city: school.city, school_state: school.state, school_zip: school.zip,
    admin_name: adminName, admin_email: adminEmail, invited_at: now, session_id: null, devices: [],
    ybl_flagged_at: check.flag ? now : null, ybl_flag_detail: check.flag ? check.detail : ''
  }))[0];

  const sent = await inviteAdmin(req, ph, lic);
  await logEvent('license-sent', { req, email: ph.email, license_id: lic.id, photographer_id: ph.id, detail: { school, adminEmail, flagged: check.flag } });

  if (check.flag) {
    await sendEmail(alertEmail(), 'PortraitPop: possible YearbookLife school licensed by a photographer',
      emailLayout(baseUrl(req), 'Possible YearbookLife school',
        '<p>A photographer licensed a school that looks similar to a YearbookLife customer. It was <b>allowed</b> because the match wasn’t certain. Please take a look.</p>'
        + '<p><b>Photographer:</b> ' + esc(ph.name) + ' (' + esc(ph.company) + ', ' + esc(ph.email) + ')<br>'
        + '<b>School:</b> ' + esc(school.name) + ', ' + esc(school.city) + ', ' + esc(school.state) + ' ' + esc(school.zip) + '<br>'
        + '<b>Admin:</b> ' + esc(adminName) + ' ' + esc(adminEmail) + '<br>'
        + '<b>License:</b> ' + esc(lic.code) + '<br>'
        + '<b>Why:</b> ' + esc(check.detail) + '</p>'));
  }

  return res.status(200).json({
    ok: true,
    message: sent
      ? 'License sent. ' + adminEmail + ' will get an email to sign in. Their ' + LICENSE_DAYS + ' days start the first time they sign in.'
      : 'License assigned, but the email didn’t send. Click Resend link on that school.'
  });
}
