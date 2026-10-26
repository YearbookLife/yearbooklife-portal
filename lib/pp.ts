import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

/**
 * SHARED CODE FOR THE PORTRAITPOP PHOTOGRAPHER LICENSING PROGRAM
 *
 * Used only by the api/pp-*.ts routes. Nothing in the customer dashboard imports
 * this file, and this file imports nothing from the dashboard.
 *
 * Kept separate from the dashboard on purpose:
 *   - its own signing key (PP_LICENSE_SECRET, NOT PORTRAITPOP_SECRET)
 *   - its own accounts (Supabase tables pp_*, NOT Supabase Auth users)
 *   - its own on/off switch (PP_ENABLED)
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const LICENSE_DAYS = 60;              // a license runs 60 days from the admin's first sign-in
export const REMINDER_DAYS_BEFORE = 7;       // reminder email this many days before it ends
export const MAX_DEVICES = 2;                // devices allowed per school admin
export const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const PHOTOGRAPHER_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const STAFF_SESSION_MS = 12 * 60 * 60 * 1000;
export const LOGIN_LINK_MS = 30 * 60 * 1000;            // "email me a link" links
export const INVITE_LINK_MS = 30 * 24 * 60 * 60 * 1000; // first invite to a school admin

export const SESSION_COOKIE = 'pp_sess';
export const DEVICE_COOKIE = 'pp_dev';

/** Price per license for an order of this size. Every license in the order is
 *  charged at the tier price. Returns null at 200+ ("call for pricing"). */
export function unitPriceFor(quantity: number): number | null {
  const q = Math.floor(Number(quantity) || 0);
  if (q < 1) return null;
  if (q <= 4) return 80;
  if (q <= 19) return 75;
  if (q <= 49) return 70;
  if (q <= 99) return 65;
  if (q <= 199) return 60;
  return null;
}

/** Program on/off switch. Anything other than PP_ENABLED=true keeps it off. */
export function ppEnabled(): boolean {
  return String(process.env.PP_ENABLED || '').trim().toLowerCase() === 'true';
}

export function staffEmails(): string[] {
  return String(process.env.PP_STAFF_EMAILS || '')
    .split(/[,;\s]+/).map(e => e.trim().toLowerCase()).filter(Boolean);
}

export function alertEmail(): string {
  return String(process.env.PP_ALERT_EMAIL || 'heather@yearbooklife.com').trim();
}

export function baseUrl(req?: VercelRequest): string {
  if (process.env.PP_BASE_URL) return String(process.env.PP_BASE_URL).replace(/\/+$/, '');
  const host = req && (req.headers['x-forwarded-host'] || req.headers.host);
  if (host) return 'https://' + String(host).split(',')[0].trim();
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return 'https://yearbooklife-portal.vercel.app';
}

// ---------------------------------------------------------------------------
// Signed values (sessions). base64url(JSON) + "." + HMAC-SHA256
// ---------------------------------------------------------------------------

function getSecret(): string | null {
  const s = process.env.PP_LICENSE_SECRET;
  return (s && s.length >= 32) ? s : null;
}

export function configured(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!getSecret()) missing.push('PP_LICENSE_SECRET (32+ characters)');
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return { ok: missing.length === 0, missing };
}

export interface Session {
  r: 'photographer' | 'admin' | 'staff';
  e: string;          // email
  p?: string;         // photographer id
  l?: string;         // license id (school admins)
  s?: string;         // session id (school admins: must match the license)
  d?: string;         // device id
  u?: string;         // fingerprint of the browser that signed in
  x: number;          // expires (ms)
}

export function sign(payload: object): string {
  const secret = getSecret();
  if (!secret) throw new Error('PP_LICENSE_SECRET missing');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

export function unsign<T = any>(value: any): T | null {
  try {
    const secret = getSecret();
    if (!secret) return null;
    const raw = String(value || '');
    const dot = raw.indexOf('.');
    if (dot < 1) return null;
    const body = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (sig.length !== expect.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || typeof data.x !== 'number' || Date.now() > data.x) return null;
    return data as T;
  } catch (e) {
    return null;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Short, readable license code stamped into PDFs, e.g. PP-7KQ4-M2XD */
export function newLicenseCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return 'PP-' + s.slice(0, 4) + '-' + s.slice(4);
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function readCookies(req: VercelRequest): Record<string, string> {
  const out: Record<string, string> = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch (e) { out[k] = v; }
  });
  return out;
}

function cookieString(name: string, value: string, maxAgeSeconds: number): string {
  return name + '=' + encodeURIComponent(value)
    + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + Math.max(0, Math.floor(maxAgeSeconds));
}

export function setCookies(res: VercelResponse, cookies: string[]) {
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? existing.map(String) : (existing ? [String(existing)] : []);
  res.setHeader('Set-Cookie', list.concat(cookies));
}

export function sessionCookie(session: Session): string {
  return cookieString(SESSION_COOKIE, sign(session), (session.x - Date.now()) / 1000);
}

export function clearSessionCookie(): string {
  return cookieString(SESSION_COOKIE, '', 0);
}

export function deviceCookie(deviceId: string): string {
  return cookieString(DEVICE_COOKIE, deviceId, 400 * 24 * 60 * 60);
}

/** Rough browser fingerprint. A sign-in cookie copied into a different browser won't match. */
export function browserTag(req: VercelRequest): string {
  return sha256('ua|' + String(req.headers['user-agent'] || '')).slice(0, 12);
}

export function readSession(req: VercelRequest): Session | null {
  return unsign<Session>(readCookies(req)[SESSION_COOKIE]);
}

/** Blocks cross-site form posts. Our pages always send same-origin requests. */
export function sameOrigin(req: VercelRequest): boolean {
  const origin = String(req.headers.origin || '');
  if (!origin) return true; // same-origin fetches from some browsers omit it on POST
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

export function noStore(res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

// ---------------------------------------------------------------------------
// Database (Supabase REST, server key only)
// ---------------------------------------------------------------------------

function dbHeaders(extra: Record<string, string> = {}) {
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  return { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', ...extra };
}

function dbUrl(path: string) {
  return String(process.env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/' + path;
}

async function dbFetch(path: string, init: any = {}): Promise<any> {
  const resp = await fetch(dbUrl(path), { ...init, headers: dbHeaders(init.headers || {}) });
  const text = await resp.text();
  if (!resp.ok) throw new Error('db ' + resp.status + ' ' + path.split('?')[0] + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

/** GET rows. query is PostgREST syntax, e.g. "email=eq.x@y.com&select=*" */
export async function dbSelect(table: string, query: string): Promise<any[]> {
  return (await dbFetch(table + '?' + query)) || [];
}

/** Like dbSelect but follows past Supabase's 1,000-row page size. */
export async function dbSelectAll(table: string, query: string, pageSize = 1000): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < 200000; offset += pageSize) {
    const page = await dbSelect(table, query + '&limit=' + pageSize + '&offset=' + offset);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

/** Runs a query with an id=in.(...) filter in chunks, so the address never gets too long. */
export async function dbSelectIds(table: string, ids: string[], rest: string): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).map(id => encodeURIComponent(id)).join(',');
    out.push(...await dbSelect(table, 'id=in.(' + chunk + ')&' + rest));
  }
  return out;
}

/** How many events of these kinds this photographer caused recently. */
export async function recentCount(photographerId: string, kinds: string[], sinceMs: number): Promise<number> {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const rows = await dbSelect('pp_events', 'photographer_id=' + eq(photographerId)
    + '&kind=in.(' + kinds.join(',') + ')&at=gte.' + encodeURIComponent(since) + '&select=id&limit=1000');
  return rows.length;
}

export async function dbInsert(table: string, rows: any): Promise<any[]> {
  return (await dbFetch(table, {
    method: 'POST', body: JSON.stringify(rows), headers: { 'Prefer': 'return=representation' }
  })) || [];
}

export async function dbUpdate(table: string, query: string, patch: any): Promise<any[]> {
  return (await dbFetch(table + '?' + query, {
    method: 'PATCH', body: JSON.stringify(patch), headers: { 'Prefer': 'return=representation' }
  })) || [];
}

export async function dbRpc(fn: string, args: any): Promise<any> {
  return dbFetch('rpc/' + fn, { method: 'POST', body: JSON.stringify(args) });
}

export function eq(value: string): string {
  return 'eq.' + encodeURIComponent(value);
}

// ---------------------------------------------------------------------------
// Usage log
// ---------------------------------------------------------------------------

export function ipHash(req?: VercelRequest): string {
  if (!req) return '';
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
  if (!ip) return '';
  // Salted and shortened: enough to count distinct locations, not to identify anyone.
  return sha256((process.env.PP_LICENSE_SECRET || '') + '|ip|' + ip).slice(0, 16);
}

export async function logEvent(kind: string, fields: {
  req?: VercelRequest; license_id?: string | null; photographer_id?: string | null;
  email?: string; device?: string; detail?: any;
}) {
  try {
    await dbInsert('pp_events', {
      kind,
      license_id: fields.license_id || null,
      photographer_id: fields.photographer_id || null,
      email: fields.email || '',
      ip_hash: ipHash(fields.req),
      device: (fields.device || '').slice(0, 16),
      detail: fields.detail || {}
    });
  } catch (e) {
    console.warn('pp logEvent failed (ignored):', e);
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export function esc(s: any): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function emailLayout(base: string, heading: string, bodyHtml: string, button?: { label: string; url: string }): string {
  const btn = button
    ? '<p style="margin:28px 0"><a href="' + esc(button.url) + '" style="background:#FF6A00;color:#ffffff;'
      + 'text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px;display:inline-block">'
      + esc(button.label) + '</a></p>'
      + '<p style="font-size:13px;color:#64748b">If the button doesn\'t work, copy this address into your browser:<br>'
      + '<span style="word-break:break-all">' + esc(button.url) + '</span></p>'
    : '';
  return '<div style="background:#D9F4F2;padding:28px 12px;font-family:Arial,Helvetica,sans-serif">'
    + '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:32px 30px;color:#0B2840">'
    + '<img src="' + esc(base) + '/portraitpop-logo.png" alt="PortraitPop by YearbookLife" width="150" style="display:block;margin:0 0 20px">'
    + '<h1 style="font-size:21px;margin:0 0 14px;color:#0B2840">' + esc(heading) + '</h1>'
    + '<div style="font-size:15px;line-height:1.6;color:#334155">' + bodyHtml + '</div>'
    + btn
    + '<p style="font-size:12px;color:#94a3b8;margin-top:28px">PortraitPop by YearbookLife &middot; 888-680-0143</p>'
    + '</div></div>';
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) { console.error('pp email: GMAIL_USER / GMAIL_APP_PASSWORD not set'); return false; }
  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass }
    });
    await transporter.sendMail({ from: 'PortraitPop by YearbookLife <' + user + '>', to, subject, html });
    return true;
  } catch (e) {
    console.error('pp email failed:', e);
    return false;
  }
}

/** Creates a single-use sign-in link and returns its URL. */
export async function createLoginLink(base: string, email: string, role: Session['r'],
                                      licenseId: string | null, lifetimeMs: number): Promise<string> {
  const token = randomToken();
  await dbInsert('pp_login_tokens', {
    token_hash: sha256(token),
    email: email.toLowerCase(),
    role,
    license_id: licenseId,
    expires_at: new Date(Date.now() + lifetimeMs).toISOString()
  });
  // Lands on a page with a "Sign in" button. Email security scanners follow
  // links but don't press buttons, so they can't use up the link.
  return base + '/pp/signin#t=' + token;
}

// ---------------------------------------------------------------------------
// Licenses
// ---------------------------------------------------------------------------

/** What a license looks like right now, with expiry worked out. */
export function licenseState(lic: any): 'available' | 'invited' | 'active' | 'expired' | 'revoked' {
  if (!lic) return 'revoked';
  if (lic.status === 'active' && lic.expires_at && Date.parse(lic.expires_at) <= Date.now()) return 'expired';
  return lic.status;
}

export function daysLeft(lic: any): number | null {
  if (!lic || !lic.expires_at) return null;
  return Math.max(0, Math.ceil((Date.parse(lic.expires_at) - Date.now()) / 86400000));
}

export function cleanEmail(v: any): string {
  const e = String(v || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200 ? e : '';
}

export function cleanText(v: any, max = 120): string {
  return String(v || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// "Is this already a YearbookLife school?"
//
// HubSpot deals are named like "2026-2027 Miami Arts Charter School, FL" and
// carry a shipping city/state/zip. There is no national school ID in HubSpot, so
// we compare cleaned-up names within the same state or zip code, and also check
// whether the admin's email belongs to a YearbookLife customer contact.
//
//   block -> definite match. The license is not used and nothing is sent.
//   flag  -> close but not certain. Allowed, and YearbookLife gets an email.
// ---------------------------------------------------------------------------

// Must stay in sync with WON_STAGE_IDS in api/cron-send-invites.ts
const WON_STAGE_IDS = [
  '995123631', '997997495', '995003294', '999965603', '1000097294', '1000857003',
  '1000822951', '999098015', '43137964', '1398312509', '115016114', '115012142', '1410223525'
];

const STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH',
  'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR', guam: 'GU', 'virgin islands': 'VI'
};
export const STATE_CODES = Array.from(new Set(Object.values(STATES))).sort();

export function stateCode(v: any): string {
  const s = String(v || '').trim().replace(/\./g, '');
  if (!s) return '';
  if (s.length === 2) return s.toUpperCase();
  return STATES[s.toLowerCase()] || '';
}

function zip5(v: any): string {
  const m = String(v || '').match(/\d{5}/);
  return m ? m[0] : '';
}

// Words that say what kind of school it is, not which school.
const GENERIC = new Set([
  'school', 'schools', 'the', 'of', 'and', 'at', 'hs', 'ms', 'es', 'jhs', 'high', 'middle', 'elementary',
  'elem', 'junior', 'senior', 'jr', 'sr', 'academy', 'charter', 'prep', 'preparatory', 'institute',
  'center', 'learning', 'public', 'private', 'day', 'international', 'k8', 'k12', 'upper', 'lower',
  'primary', 'secondary', 'intermediate', 'magnet', 'early', 'college', 'christian', 'catholic',
  'yearbook', 'pto', 'pta', 'pso', 'campus'
]);

// Words that say which grades a school serves.
const LEVELS = new Set(['hs', 'ms', 'es', 'jhs', 'primary', 'intermediate', 'secondary', 'k8', 'k12', 'upper', 'lower']);

/** Cleans a school name into comparable words. */
export function schoolWords(name: string): string[] {
  let s = ' ' + String(name || '').toLowerCase() + ' ';
  s = s.replace(/^\s*\d{4}\s*[-–\/]\s*\d{2,4}\s+/, ' ');      // leading "2026-2027"
  s = s.replace(/,\s*[a-z .]{2,20}\s*$/, ' ');                        // trailing ", FL"
  s = s.replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ');
  s = s.replace(/\bhigh school\b/g, ' hs ')
       .replace(/\bmiddle school\b/g, ' ms ')
       .replace(/\bjunior high( school)?\b/g, ' jhs ')
       .replace(/\belementary( school)?\b/g, ' es ')
       .replace(/\belem\b/g, ' es ')
       .replace(/\bsaint\b/g, ' st ')
       .replace(/\bmount\b/g, ' mt ')
       .replace(/\bfort\b/g, ' ft ');
  return s.split(' ').filter(w => w && w !== 'school' && w !== 'the' && w !== 'of' && w !== 'and');
}

function distinctive(words: string[]): string[] {
  return words.filter(w => !GENERIC.has(w) && w.length > 1);
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  A.forEach(w => { if (B.has(w)) both++; });
  return both / (A.size + B.size - both);
}

export interface SchoolInput { name: string; city: string; state: string; zip: string; adminEmail: string; }
export interface SchoolCheck { block: boolean; flag: boolean; detail: string; error?: string; }

function currentSeasons(now = new Date()): string[] {
  const y = now.getUTCFullYear();
  const start = now.getUTCMonth() >= 6 ? y : y - 1; // school year turns over July 1
  return [start + '-' + (start + 1), (start + 1) + '-' + (start + 2)];
}

/** A won deal that counts as a current YearbookLife customer. */
function isCustomerDeal(props: any, now = new Date()): boolean {
  if (WON_STAGE_IDS.indexOf(String(props.dealstage || '')) === -1) return false;
  const name = String(props.dealname || '').trim();
  if (currentSeasons(now).some(s => name.startsWith(s))) return true;
  const closed = Date.parse(props.closedate || '');
  return !isNaN(closed) && now.getTime() - closed < 365 * 86400000;
}

async function hsFetch(path: string, body?: any): Promise<any> {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error('HUBSPOT_ACCESS_TOKEN missing');
  const resp = await fetch('https://api.hubapi.com' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!resp.ok) throw new Error('hubspot ' + resp.status + ' ' + path);
  return resp.json();
}

const WEBMAIL = new Set(['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'me.com',
  'live.com', 'msn.com', 'comcast.net', 'att.net', 'verizon.net', 'protonmail.com', 'proton.me', 'ymail.com', 'mail.com']);

const DEAL_PROPS = ['dealname', 'dealstage', 'closedate', 'books_shipping_city', 'books_shipping_state', 'books_shipping_zip'];

async function searchDeals(filters: any[], query?: string): Promise<any[]> {
  const twoYearsAgo = String(Date.now() - 730 * 86400000);
  const body: any = {
    filterGroups: [{ filters: [
      { propertyName: 'dealstage', operator: 'IN', values: WON_STAGE_IDS },
      { propertyName: 'closedate', operator: 'GTE', value: twoYearsAgo },
      ...filters
    ] }],
    properties: DEAL_PROPS,
    sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
    limit: 200
  };
  if (query) body.query = query;
  const data = await hsFetch('/crm/v3/objects/deals/search', body);
  return data.results || [];
}

/** Compares one HubSpot deal with the school being licensed. */
export function compareDeal(input: SchoolInput, props: any): { block: boolean; flag: boolean } {
  const mine = schoolWords(input.name);
  const theirs = schoolWords(props.dealname || '');
  const myState = stateCode(input.state);
  const nameState = (String(props.dealname || '').match(/,\s*([A-Za-z .]{2,20})\s*$/) || [])[1];
  const theirState = stateCode(props.books_shipping_state) || stateCode(nameState);
  const sameState = !!myState && myState === theirState;
  const sameZip = !!zip5(input.zip) && zip5(input.zip) === zip5(props.books_shipping_zip);
  const sameCity = !!input.city && String(props.books_shipping_city || '').trim().toLowerCase() === input.city.trim().toLowerCase();

  const exact = mine.slice().sort().join(' ') === theirs.slice().sort().join(' ') && mine.length > 0;
  const j = jaccard(mine, theirs);
  const dMine = distinctive(mine), dTheirs = distinctive(theirs);
  const sharesDistinctive = dMine.some(w => dTheirs.indexOf(w) !== -1);
  const allDistinctiveMatch = dMine.length > 0 && dMine.length === dTheirs.length
    && dMine.every(w => dTheirs.indexOf(w) !== -1);
  // "Lincoln Park Middle" and "Lincoln Park Elementary" are different schools.
  const lMine = mine.filter(w => LEVELS.has(w)), lTheirs = theirs.filter(w => LEVELS.has(w));
  const levelsClash = lMine.length > 0 && lTheirs.length > 0 && !lMine.some(w => lTheirs.indexOf(w) !== -1);

  const block = (exact && (sameState || sameZip || (!theirState && sameCity)))
    || (!levelsClash && sameZip && j >= 0.6 && sharesDistinctive)
    || (!levelsClash && sameState && sameCity && allDistinctiveMatch);
  const flag = !block && sharesDistinctive && (
    (sameState && j >= 0.5) || sameZip || (sameState && sameCity)
  );
  return { block, flag };
}

export async function checkYearbookLifeSchool(input: SchoolInput): Promise<SchoolCheck> {
  const found = new Map<string, any>();
  try {
    // 1) Deals whose name shares the school's most telling words
    const words = distinctive(schoolWords(input.name)).sort((a, b) => b.length - a.length).slice(0, 2);
    for (const w of words) {
      (await searchDeals([], w)).forEach(d => found.set(String(d.id), d));
    }
    // 2) Deals shipping to the same zip code
    const z = zip5(input.zip);
    if (z) {
      (await searchDeals([{ propertyName: 'books_shipping_zip', operator: 'CONTAINS_TOKEN', value: z }]))
        .forEach(d => found.set(String(d.id), d));
    }

    const flagged: string[] = [];
    for (const d of Array.from(found.values())) {
      const p = d.properties || {};
      if (!isCustomerDeal(p)) continue;
      const c = compareDeal(input, p);
      if (c.block) return { block: true, flag: false, detail: 'Matches YearbookLife deal "' + String(p.dealname).trim() + '" (HubSpot deal ' + d.id + ')' };
      if (c.flag) flagged.push('"' + String(p.dealname).trim() + '" (deal ' + d.id + ')');
    }

    // 3) Is the admin already a YearbookLife customer contact?
    const email = cleanEmail(input.adminEmail);
    if (email) {
      const cs = await hsFetch('/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        properties: ['email'], limit: 1
      });
      const contact = (cs.results || [])[0];
      if (contact) {
        const assoc = await hsFetch('/crm/v3/objects/contacts/' + contact.id + '/associations/deals');
        const ids = (assoc.results || []).map((r: any) => String(r.id || r.toObjectId)).filter(Boolean).slice(0, 100);
        if (ids.length) {
          const batch = await hsFetch('/crm/v3/objects/deals/batch/read', {
            inputs: ids.map((id: string) => ({ id })), properties: DEAL_PROPS
          });
          const hit = (batch.results || []).find((d: any) => isCustomerDeal(d.properties || {}));
          if (hit) {
            return { block: true, flag: false, detail: 'Admin email ' + email + ' is a YearbookLife customer contact on "'
              + String(hit.properties.dealname).trim() + '" (HubSpot deal ' + hit.id + ')' };
          }
        }
      }
    }

    // 4) Same email domain as a YearbookLife customer school? Districts share
    //    domains across many schools, so this only flags, never blocks.
    const domain = email ? email.split('@')[1] : '';
    if (domain && !WEBMAIL.has(domain)) {
      const cos = await hsFetch('/crm/v3/objects/companies/search', {
        filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] }],
        properties: ['name', 'domain'], limit: 5
      });
      for (const co of (cos.results || [])) {
        const assoc = await hsFetch('/crm/v3/objects/companies/' + co.id + '/associations/deals');
        const ids = (assoc.results || []).map((r: any) => String(r.id || r.toObjectId)).filter(Boolean).slice(0, 100);
        if (!ids.length) continue;
        const batch = await hsFetch('/crm/v3/objects/deals/batch/read', { inputs: ids.map((id: string) => ({ id })), properties: DEAL_PROPS });
        const hit = (batch.results || []).find((d: any) => isCustomerDeal(d.properties || {}));
        if (hit) { flagged.push('admin email domain ' + domain + ' matches YearbookLife customer "' + String(hit.properties.dealname).trim() + '" (deal ' + hit.id + ')'); break; }
      }
    }

    if (flagged.length) return { block: false, flag: true, detail: 'Possible match: ' + flagged.slice(0, 3).join('; ') };
    return { block: false, flag: false, detail: '' };
  } catch (e: any) {
    console.error('pp school check failed:', e);
    return { block: false, flag: false, detail: '', error: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function body(req: VercelRequest): any {
  const b: any = req.body;
  if (!b) return {};
  if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return {}; } }
  return b;
}

/** Common opening for every pp JSON route. Returns false if it already replied. */
export function guard(req: VercelRequest, res: VercelResponse, methods: string[]): boolean {
  noStore(res);
  if (methods.indexOf(String(req.method)) === -1) { res.status(405).json({ ok: false, error: 'Method not allowed' }); return false; }
  if (!ppEnabled()) { res.status(503).json({ ok: false, error: 'PortraitPop accounts are not open yet.' }); return false; }
  const c = configured();
  if (!c.ok) { console.error('pp not configured, missing:', c.missing.join(', ')); res.status(500).json({ ok: false, error: 'PortraitPop accounts are not set up yet.' }); return false; }
  if (req.method === 'POST' && !sameOrigin(req)) { res.status(403).json({ ok: false, error: 'Blocked' }); return false; }
  return true;
}

// ---------------------------------------------------------------------------
// Who is signed in? Each check goes back to the database, so removing an admin,
// suspending a photographer, or signing in on another device takes effect on
// the very next click.
// ---------------------------------------------------------------------------

export type AdminCheck =
  | { ok: true; session: Session; license: any; photographer: any }
  | { ok: false; reason: 'signed-out' | 'signed-in-elsewhere' | 'device' | 'expired' | 'removed' | 'suspended' | 'error' };

export async function currentAdmin(req: VercelRequest): Promise<AdminCheck> {
  const session = readSession(req);
  if (!session || session.r !== 'admin' || !session.l) return { ok: false, reason: 'signed-out' };
  try {
    const lic = (await dbSelect('pp_licenses', 'id=' + eq(session.l) + '&select=*'))[0];
    if (!lic) return { ok: false, reason: 'removed' };
    if (String(lic.admin_email).toLowerCase() !== session.e) return { ok: false, reason: 'removed' };
    const state = licenseState(lic);
    if (state === 'revoked' || state === 'available') return { ok: false, reason: 'removed' };
    if (state === 'expired') return { ok: false, reason: 'expired' };
    if (!lic.session_id || lic.session_id !== session.s) return { ok: false, reason: 'signed-in-elsewhere' };
    const device = readCookies(req)[DEVICE_COOKIE] || '';
    const devices: any[] = Array.isArray(lic.devices) ? lic.devices : [];
    if (!device || device !== session.d || !devices.some(d => d && d.id === device)) return { ok: false, reason: 'device' };
    if (session.u && session.u !== browserTag(req)) return { ok: false, reason: 'device' };
    const ph = (await dbSelect('pp_photographers', 'id=' + eq(lic.photographer_id) + '&select=*'))[0];
    if (!ph || ph.status !== 'active') return { ok: false, reason: 'suspended' };
    return { ok: true, session, license: lic, photographer: ph };
  } catch (e) {
    console.error('pp currentAdmin failed:', e);
    return { ok: false, reason: 'error' };
  }
}

export async function currentPhotographer(req: VercelRequest): Promise<{ session: Session; photographer: any } | null> {
  const session = readSession(req);
  if (!session || session.r !== 'photographer' || !session.p) return null;
  const ph = (await dbSelect('pp_photographers', 'id=' + eq(session.p) + '&select=*'))[0];
  if (!ph || ph.status !== 'active' || String(ph.email).toLowerCase() !== session.e) return null;
  return { session, photographer: ph };
}

export function currentStaff(req: VercelRequest): Session | null {
  const session = readSession(req);
  if (!session || session.r !== 'staff') return null;
  return staffEmails().indexOf(session.e) !== -1 ? session : null;
}

export const ADMIN_BLOCK_MESSAGES: Record<string, string> = {
  'signed-out': 'Please sign in to PortraitPop.',
  'signed-in-elsewhere': 'Your account was signed in on another computer, so this one was signed out. Sign in again to keep working here.',
  'device': 'Please sign in again on this computer.',
  'expired': 'This school’s PortraitPop license has ended. Contact your photographer if you need more time.',
  'removed': 'Your PortraitPop access was removed. Contact your photographer.',
  'suspended': 'PortraitPop isn’t available on this account right now. Contact your photographer.',
  'error': 'We couldn’t check your account just now. Please try again in a moment.'
};

/** Every current YearbookLife customer deal (for the nightly re-check). Stops
 *  early if it runs out of time and says so. */
export async function fetchCustomerDeals(budgetMs: number): Promise<{ deals: any[]; complete: boolean }> {
  const started = Date.now();
  const twoYearsAgo = String(Date.now() - 730 * 86400000);
  const deals: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    if (Date.now() - started > budgetMs) return { deals, complete: false };
    const body: any = {
      filterGroups: [{ filters: [
        { propertyName: 'dealstage', operator: 'IN', values: WON_STAGE_IDS },
        { propertyName: 'closedate', operator: 'GTE', value: twoYearsAgo }
      ] }],
      properties: DEAL_PROPS,
      sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
      limit: 200
    };
    if (after) body.after = after;
    const data = await hsFetch('/crm/v3/objects/deals/search', body);
    (data.results || []).forEach((d: any) => { if (isCustomerDeal(d.properties || {})) deals.push(d); });
    after = data.paging && data.paging.next && data.paging.next.after;
    if (!after) return { deals, complete: true };
  }
  return { deals, complete: false };
}
