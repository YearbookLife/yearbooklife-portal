import { VercelRequest, VercelResponse } from '@vercel/node';
import {
  guard, body, cleanEmail, staffEmails, dbSelect, dbUpdate, eq, sha256, randomToken,
  createLoginLink, sendEmail, emailLayout, esc, baseUrl, setCookies, sessionCookie, clearSessionCookie,
  deviceCookie, readCookies, readSession, DEVICE_COOKIE, MAX_DEVICES, LICENSE_DAYS, ADMIN_SESSION_MS,
  PHOTOGRAPHER_SESSION_MS, STAFF_SESSION_MS, LOGIN_LINK_MS, licenseState, daysLeft, logEvent,
  currentAdmin, ADMIN_BLOCK_MESSAGES, Session, browserTag
} from '../lib/pp';

/**
 * PORTRAITPOP ACCOUNTS: SIGN-IN
 *
 * POST { action: 'request-link', email }  -> emails sign-in link(s). Same reply whether or not the
 *                                            email is on file, so it can't be used to look people up.
 * POST { action: 'consume', token }        -> spends a link and signs this browser in.
 * POST { action: 'logout' }
 * GET                                      -> who is signed in here?
 *
 * Accounts here are separate from the customer dashboard: no Supabase Auth, no HubSpot login.
 */

const FRIENDLY = {
  ok: true,
  message: 'If that email has a PortraitPop account, a sign-in link is on its way. It should arrive within a few minutes. Please check your spam folder too.'
};

const MAX_LINKS_PER_HOUR = 5;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!guard(req, res, ['GET', 'POST'])) return;

  try {
    if (req.method === 'GET') return await whoAmI(req, res);

    const b = body(req);
    if (b.action === 'request-link') return await requestLink(req, res, b);
    if (b.action === 'consume') return await consume(req, res, b);
    if (b.action === 'logout') {
      const s = readSession(req);
      if (s && s.r === 'admin' && s.l && s.s) {
        // Only clears the license's live session if it is still this browser's.
        await dbUpdate('pp_licenses', 'id=' + eq(s.l) + '&session_id=' + eq(s.s), { session_id: null }).catch(() => {});
      }
      setCookies(res, [clearSessionCookie()]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    console.error('pp-auth error:', e);
    return res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
}

async function whoAmI(req: VercelRequest, res: VercelResponse) {
  const s = readSession(req);
  if (!s) return res.status(200).json({ ok: true, role: null });

  if (s.r === 'admin') {
    const a = await currentAdmin(req);
    if (a.ok === false) {
      if (a.reason !== 'error') setCookies(res, [clearSessionCookie()]);
      return res.status(200).json({ ok: true, role: null, reason: a.reason, message: ADMIN_BLOCK_MESSAGES[a.reason] });
    }
    const lic = a.license;
    return res.status(200).json({
      ok: true, role: 'admin', email: s.e,
      school: { name: lic.school_name, city: lic.school_city, state: lic.school_state },
      expiresAt: lic.expires_at, daysLeft: daysLeft(lic), code: lic.code,
      photographer: { name: a.photographer.name, company: a.photographer.company, email: a.photographer.email }
    });
  }
  if (s.r === 'photographer') {
    const ph = s.p ? (await dbSelect('pp_photographers', 'id=' + eq(s.p) + '&select=id,status,email'))[0] : null;
    if (!ph || ph.status !== 'active' || String(ph.email).toLowerCase() !== s.e) {
      setCookies(res, [clearSessionCookie()]);
      return res.status(200).json({ ok: true, role: null, message: 'This photographer account is not active. Please call YearbookLife at 888-680-0143.' });
    }
    return res.status(200).json({ ok: true, role: 'photographer', email: s.e });
  }
  if (s.r === 'staff' && staffEmails().indexOf(s.e) !== -1) {
    return res.status(200).json({ ok: true, role: 'staff', email: s.e });
  }
  setCookies(res, [clearSessionCookie()]);
  return res.status(200).json({ ok: true, role: null });
}

async function requestLink(req: VercelRequest, res: VercelResponse, b: any) {
  const email = cleanEmail(b.email);
  if (!email) return res.status(200).json(FRIENDLY);

  // Simple flood control per email address.
  const since = new Date(Date.now() - 3600000).toISOString();
  const recent = await dbSelect('pp_login_tokens',
    'email=' + eq(email) + '&created_at=gte.' + encodeURIComponent(since) + '&select=token_hash');
  if (recent.length >= MAX_LINKS_PER_HOUR) return res.status(200).json(FRIENDLY);

  const base = baseUrl(req);
  const links: { label: string; url: string }[] = [];

  if (staffEmails().indexOf(email) !== -1) {
    links.push({ label: 'YearbookLife staff: manage photographers', url: await createLoginLink(base, email, 'staff', null, LOGIN_LINK_MS) });
  }

  const ph = (await dbSelect('pp_photographers', 'email=' + eq(email) + '&status=eq.active&select=id'))[0];
  if (ph) {
    links.push({ label: 'Photographer account: manage your licenses', url: await createLoginLink(base, email, 'photographer', null, LOGIN_LINK_MS) });
  }

  const lics = await dbSelect('pp_licenses',
    'admin_email=' + eq(email) + '&status=in.(invited,active)&select=id,status,expires_at,school_name,photographer_id');
  for (const lic of lics) {
    if (licenseState(lic) === 'expired') continue;
    const owner = (await dbSelect('pp_photographers', 'id=' + eq(lic.photographer_id) + '&select=status'))[0];
    if (!owner || owner.status !== 'active') continue;
    links.push({ label: 'Build portrait pages for ' + (lic.school_name || 'your school'),
                 url: await createLoginLink(base, email, 'admin', lic.id, LOGIN_LINK_MS) });
  }

  if (!links.length) return res.status(200).json(FRIENDLY);

  let html: string;
  if (links.length === 1) {
    html = emailLayout(base, 'Your PortraitPop sign-in link',
      '<p>Click the button below to sign in. The link works once and expires in 15 minutes.</p>', { label: 'Sign in to PortraitPop', url: links[0].url });
  } else {
    html = emailLayout(base, 'Your PortraitPop sign-in links',
      '<p>Your email has more than one PortraitPop account. Pick the one you want. Each link works once and expires in 15 minutes.</p>'
      + links.map(l => '<p style="margin:16px 0"><a href="' + esc(l.url) + '" style="color:#EB6E44;font-weight:700">' + esc(l.label) + '</a></p>').join(''));
  }
  await sendEmail(email, 'Your PortraitPop sign-in link', html);
  await logEvent('link-requested', { req, email });
  return res.status(200).json(FRIENDLY);
}

function failLink(res: VercelResponse, message: string, code = 'invalid') {
  return res.status(200).json({ ok: false, code, error: message });
}

async function consume(req: VercelRequest, res: VercelResponse, b: any) {
  const token = String(b.token || '').trim();
  if (!token || token.length > 200) return failLink(res, 'This sign-in link isn’t valid. Request a new one below.');

  const hash = sha256(token);
  const row = (await dbSelect('pp_login_tokens', 'token_hash=' + eq(hash) + '&select=*'))[0];
  if (!row) return failLink(res, 'This sign-in link isn’t valid. Request a new one below.');
  if (row.used_at) return failLink(res, 'This sign-in link has already been used. Request a new one below.', 'used');
  if (Date.parse(row.expires_at) <= Date.now()) return failLink(res, 'This sign-in link has expired. Request a new one below.', 'expired');

  // Spend it. The used_at=is.null condition makes this one-time even if clicked twice at once.
  const spent = await dbUpdate('pp_login_tokens', 'token_hash=' + eq(hash) + '&used_at=is.null', { used_at: new Date().toISOString() });
  if (!spent.length) return failLink(res, 'This sign-in link has already been used. Request a new one below.', 'used');

  const email = String(row.email).toLowerCase();

  if (row.role === 'staff') {
    if (staffEmails().indexOf(email) === -1) return failLink(res, 'This account no longer has staff access.');
    setCookies(res, [sessionCookie({ r: 'staff', e: email, x: Date.now() + STAFF_SESSION_MS })]);
    await logEvent('signin-staff', { req, email });
    return res.status(200).json({ ok: true, role: 'staff' });
  }

  if (row.role === 'photographer') {
    const ph = (await dbSelect('pp_photographers', 'email=' + eq(email) + '&select=*'))[0];
    if (!ph || ph.status !== 'active') return failLink(res, 'This photographer account is not active. Please call YearbookLife at 888-680-0143.', 'inactive');
    setCookies(res, [sessionCookie({ r: 'photographer', e: email, p: ph.id, x: Date.now() + PHOTOGRAPHER_SESSION_MS })]);
    await logEvent('signin-photographer', { req, email, photographer_id: ph.id });
    return res.status(200).json({ ok: true, role: 'photographer' });
  }

  // School admin
  const lic = row.license_id ? (await dbSelect('pp_licenses', 'id=' + eq(row.license_id) + '&select=*'))[0] : null;
  if (!lic || String(lic.admin_email).toLowerCase() !== email) {
    return failLink(res, 'This link is no longer active. Your photographer may have changed who has access. Please contact them.', 'removed');
  }
  const state = licenseState(lic);
  if (state === 'expired') return failLink(res, ADMIN_BLOCK_MESSAGES.expired, 'expired-license');
  if (state !== 'invited' && state !== 'active') return failLink(res, ADMIN_BLOCK_MESSAGES.removed, 'removed');
  const ph = (await dbSelect('pp_photographers', 'id=' + eq(lic.photographer_id) + '&select=*'))[0];
  if (!ph || ph.status !== 'active') return failLink(res, ADMIN_BLOCK_MESSAGES.suspended, 'suspended');

  // Device limit
  let device = readCookies(req)[DEVICE_COOKIE] || '';
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(device)) device = randomToken(18);
  const devices: any[] = Array.isArray(lic.devices) ? lic.devices.filter((d: any) => d && d.id) : [];
  const now = new Date().toISOString();
  const known = devices.find(d => d.id === device);
  if (!known && devices.length >= MAX_DEVICES) {
    await logEvent('device-limit', { req, email, license_id: lic.id, photographer_id: ph.id, device });
    setCookies(res, [deviceCookie(device)]);
    return failLink(res, 'This school’s PortraitPop account is already set up on ' + MAX_DEVICES
      + ' computers, which is the limit. Ask your photographer to reset your devices, then sign in again.', 'device-limit');
  }
  if (known) known.last = now; else devices.push({ id: device, first: now, last: now });

  // One live sign-in per license: a new session id signs out every other browser.
  const sessionId = randomToken(12);
  const patch: any = { session_id: sessionId, devices };
  if (lic.status === 'invited') {
    patch.status = 'active';
    patch.activated_at = now;
    patch.expires_at = new Date(Date.now() + LICENSE_DAYS * 86400000).toISOString();
  }
  // Only applies if nothing changed since we read it (e.g. the photographer
  // cancelled and re-sent this license to another school a moment ago).
  const applied = await dbUpdate('pp_licenses', 'id=' + eq(lic.id) + '&status=' + eq(lic.status) + '&admin_email=' + eq(String(lic.admin_email)), patch);
  if (!applied.length) return failLink(res, 'This link is no longer active. Please contact your photographer.', 'removed');

  const expiresAt = patch.expires_at || lic.expires_at;
  const session: Session = {
    r: 'admin', e: email, l: lic.id, s: sessionId, d: device, u: browserTag(req),
    x: Math.min(Date.now() + ADMIN_SESSION_MS, Date.parse(expiresAt))
  };
  setCookies(res, [sessionCookie(session), deviceCookie(device)]);
  await logEvent(lic.status === 'invited' ? 'activated' : 'signin-admin', { req, email, license_id: lic.id, photographer_id: ph.id, device });
  return res.status(200).json({ ok: true, role: 'admin' });
}
