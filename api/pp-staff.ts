import { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guard, body, currentStaff, dbSelect, dbSelectAll, dbInsert, dbUpdate, eq, cleanEmail, cleanText, unitPriceFor,
  newLicenseCode, createLoginLink, sendEmail, emailLayout, esc, baseUrl, INVITE_LINK_MS, licenseState,
  daysLeft, logEvent
} from '../lib/pp';

/**
 * PORTRAITPOP ACCOUNTS: YEARBOOKLIFE STAFF
 *
 * Only emails listed in PP_STAFF_EMAILS can use this.
 *
 * GET                                          -> all photographers + things that need a look
 * POST { action: 'add-photographer', email, name, company, phone, notes }
 * POST { action: 'add-licenses', photographerId, quantity, unitPrice?, note }  (after the invoice is paid)
 * POST { action: 'set-status', photographerId, status: 'active'|'suspended' }
 * POST { action: 'detail', photographerId }
 * POST { action: 'lookup', code }               -> who owns the license code stamped in a PDF
 * POST { action: 'cancel-license', licenseId }
 * POST { action: 'resend-welcome', photographerId }
 */

const MAX_PER_ORDER = 1000;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!guard(req, res, ['GET', 'POST'])) return;

  try {
    const staff = currentStaff(req);
    if (!staff) return res.status(401).json({ ok: false, error: 'Please sign in again.' });

    if (req.method === 'GET') return await overview(res);

    const b = body(req);

    if (b.action === 'add-photographer') {
      const email = cleanEmail(b.email);
      if (!email) return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
      const name = cleanText(b.name, 80);
      if (!name) return res.status(400).json({ ok: false, error: 'Please enter the photographer’s name.' });
      const existing = (await dbSelect('pp_photographers', 'email=' + eq(email) + '&select=id'))[0];
      if (existing) return res.status(409).json({ ok: false, error: 'That email already has a photographer account.' });
      const ph = (await dbInsert('pp_photographers', {
        email, name, company: cleanText(b.company, 120), phone: cleanText(b.phone, 40), notes: cleanText(b.notes, 1000)
      }))[0];
      const sent = await welcome(req, ph);
      await logEvent('photographer-added', { req, email: staff.e, photographer_id: ph.id });
      return res.status(200).json({ ok: true, photographerId: ph.id,
        message: name + ' was added. ' + (sent ? 'A welcome email with a sign-in link was sent.' : 'The welcome email didn’t send. Use Resend welcome.') });
    }

    if (b.action === 'add-licenses') {
      const ph = await photographer(b.photographerId);
      if (!ph) return res.status(404).json({ ok: false, error: 'Photographer not found.' });
      const quantity = Math.floor(Number(b.quantity) || 0);
      if (quantity < 1 || quantity > MAX_PER_ORDER) return res.status(400).json({ ok: false, error: 'Enter how many licenses (1 to ' + MAX_PER_ORDER + ').' });
      let unit = unitPriceFor(quantity);
      const override = Number(b.unitPrice);
      if (b.unitPrice !== undefined && b.unitPrice !== '' && b.unitPrice !== null) {
        if (!(override >= 0) || override > 1000) return res.status(400).json({ ok: false, error: 'Enter a valid price per license.' });
        unit = override;
      }
      if (unit === null) return res.status(400).json({ ok: false, error: '200 or more licenses is "call for pricing". Enter the agreed price per license.' });
      const total = Math.round(unit * quantity * 100) / 100;
      const order = (await dbInsert('pp_orders', {
        photographer_id: ph.id, quantity, unit_price: unit, total, note: cleanText(b.note, 500), created_by: staff.e
      }))[0];
      const rows = [];
      for (let i = 0; i < quantity; i++) rows.push({ code: newLicenseCode(), photographer_id: ph.id, order_id: order.id, status: 'available' });
      await dbInsert('pp_licenses', rows);
      await logEvent('licenses-added', { req, email: staff.e, photographer_id: ph.id, detail: { quantity, unit, total } });

      const base = baseUrl(req);
      const url = await createLoginLink(base, ph.email, 'photographer', null, INVITE_LINK_MS);
      await sendEmail(ph.email, quantity + ' PortraitPop license' + (quantity === 1 ? '' : 's') + ' added to your account',
        emailLayout(base, 'Your licenses are ready',
          '<p>Hi ' + esc((ph.name || '').split(' ')[0] || 'there') + ',</p>'
          + '<p><b>' + quantity + '</b> PortraitPop license' + (quantity === 1 ? ' was' : 's were') + ' added to your account. '
          + 'Each license is for one school. Unused licenses don’t expire. Once you send one to a school, '
          + 'that school has 60 days from the admin’s first sign-in.</p>',
          { label: 'Send licenses to schools', url }));
      return res.status(200).json({ ok: true, message: quantity + ' licenses added to ' + ph.name + ' at $' + unit.toFixed(2) + ' each ($' + total.toFixed(2) + ' total).' });
    }

    if (b.action === 'set-status') {
      const ph = await photographer(b.photographerId);
      if (!ph) return res.status(404).json({ ok: false, error: 'Photographer not found.' });
      const status = b.status === 'suspended' ? 'suspended' : 'active';
      await dbUpdate('pp_photographers', 'id=' + eq(ph.id), { status });
      await logEvent('photographer-' + status, { req, email: staff.e, photographer_id: ph.id });
      return res.status(200).json({ ok: true, message: status === 'suspended'
        ? ph.name + ' is suspended. They and every school admin under them can no longer sign in or export.'
        : ph.name + ' is active again.' });
    }

    if (b.action === 'resend-welcome') {
      const ph = await photographer(b.photographerId);
      if (!ph) return res.status(404).json({ ok: false, error: 'Photographer not found.' });
      const sent = await welcome(req, ph);
      return res.status(sent ? 200 : 502).json(sent ? { ok: true, message: 'Welcome email sent to ' + ph.email + '.' } : { ok: false, error: 'The email didn’t send.' });
    }

    if (b.action === 'detail') {
      const ph = await photographer(b.photographerId);
      if (!ph) return res.status(404).json({ ok: false, error: 'Photographer not found.' });
      const [lics, orders, events] = await Promise.all([
        dbSelectAll('pp_licenses', 'photographer_id=' + eq(ph.id) + '&select=*&order=created_at.desc,id'),
        dbSelect('pp_orders', 'photographer_id=' + eq(ph.id) + '&select=*&order=created_at.desc'),
        dbSelect('pp_events', 'photographer_id=' + eq(ph.id) + '&select=at,kind,email,license_id,detail&order=at.desc&limit=100')
      ]);
      return res.status(200).json({ ok: true, photographer: ph, orders, events,
        licenses: lics.map(l => ({ ...l, state: licenseState(l), daysLeft: daysLeft(l), devices: Array.isArray(l.devices) ? l.devices.length : 0, session_id: undefined })) });
    }

    if (b.action === 'lookup') {
      const code = String(b.code || '').trim().toUpperCase();
      const lic = (await dbSelect('pp_licenses', 'code=' + eq(code) + '&select=*'))[0];
      if (!lic) return res.status(404).json({ ok: false, error: 'No license with that code.' });
      const ph = await photographer(lic.photographer_id);
      const exports = await dbSelect('pp_events', 'license_id=' + eq(lic.id) + '&kind=eq.export&select=at&order=at.desc&limit=500');
      return res.status(200).json({ ok: true, license: { ...lic, state: licenseState(lic), session_id: undefined }, photographer: ph, exportCount: exports.length });
    }

    if (b.action === 'cancel-license') {
      const lic = (await dbSelect('pp_licenses', 'id=' + eq(String(b.licenseId || '')) + '&select=*'))[0];
      if (!lic) return res.status(404).json({ ok: false, error: 'License not found.' });
      await dbUpdate('pp_licenses', 'id=' + eq(lic.id), { status: 'revoked', revoked_at: new Date().toISOString(), session_id: null });
      await dbUpdate('pp_login_tokens', 'license_id=' + eq(lic.id) + '&used_at=is.null', { used_at: new Date().toISOString() });
      await logEvent('license-cancelled-by-staff', { req, email: staff.e, license_id: lic.id, photographer_id: lic.photographer_id });
      return res.status(200).json({ ok: true, message: 'License ' + lic.code + ' cancelled.' });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    console.error('pp-staff error:', e);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

async function photographer(id: any) {
  if (!id) return null;
  return (await dbSelect('pp_photographers', 'id=' + eq(String(id)) + '&select=*'))[0] || null;
}

async function welcome(req: VercelRequest, ph: any): Promise<boolean> {
  const base = baseUrl(req);
  const url = await createLoginLink(base, ph.email, 'photographer', null, INVITE_LINK_MS);
  return sendEmail(ph.email, 'Your PortraitPop photographer account',
    emailLayout(base, 'Welcome to PortraitPop',
      '<p>Hi ' + esc((ph.name || '').split(' ')[0] || 'there') + ',</p>'
      + '<p>Your PortraitPop photographer account is ready. From your account you can send a license to each school '
      + 'you work with. The school’s yearbook admin gets their own sign-in and builds their portrait pages for Canva.</p>'
      + '<p>Next time, go to <a href="' + esc(base) + '/pp">' + esc(base.replace(/^https?:\/\//, '')) + '/pp</a> and enter your email to get a sign-in link.</p>',
      { label: 'Open my account', url }));
}

async function overview(res: VercelResponse) {
  const [phs, lics, events] = await Promise.all([
    dbSelectAll('pp_photographers', 'select=*&order=created_at.desc,id'),
    dbSelectAll('pp_licenses', 'select=id,photographer_id,status,expires_at,code,school_name,school_city,school_state,admin_email,ybl_flagged_at,ybl_flag_detail&order=id'),
    dbSelect('pp_events', 'kind=in.(blocked-ybl,device-limit,unusual-activity)&select=at,kind,email,license_id,photographer_id,detail&order=at.desc&limit=50')
  ]);
  const byPh: Record<string, any> = {};
  phs.forEach(p => { byPh[p.id] = { ...p, counts: { available: 0, invited: 0, active: 0, expired: 0, revoked: 0, total: 0 } }; });
  lics.forEach(l => {
    const p = byPh[l.photographer_id];
    if (!p) return;
    p.counts[licenseState(l)]++;
    p.counts.total++;
  });
  const flagged = lics.filter(l => l.ybl_flagged_at && licenseState(l) !== 'revoked')
    .map(l => ({ code: l.code, school: l.school_name + ', ' + l.school_city + ', ' + l.school_state, photographer: (byPh[l.photographer_id] || {}).name, detail: l.ybl_flag_detail, at: l.ybl_flagged_at }));
  const names: Record<string, string> = {};
  phs.forEach(p => { names[p.id] = p.name; });
  return res.status(200).json({
    ok: true,
    photographers: Object.values(byPh),
    flagged,
    alerts: events.map(e => ({ ...e, photographer: names[e.photographer_id] || '' }))
  });
}
