import { VercelRequest, VercelResponse } from '@vercel/node';
import { sendEmail, noStore } from '../lib/pp';

/**
 * PAGEPILOT "NEW BOOK" ALERT
 *
 * PagePilot calls this right after a school sends its approved Cover and Pages
 * files to YearbookLife. It emails the production team a summary with a link
 * that opens PagePilot, where staff click Inbox to download the files.
 *
 * Safety:
 *  - The recipient is fixed (PAGEPILOT_ALERT_EMAIL, default production@yearbooklife.com).
 *    Nothing in the request can change who gets the email, so this can't be used
 *    to send mail to anyone else.
 *  - No files and no student data are sent here, only the book summary and the
 *    sender's contact details. Every value is length-capped and HTML-escaped.
 *  - Only pages served from Claude (where PagePilot runs today) or from this
 *    portal may call it, and each caller is limited to a few alerts an hour.
 */

const ALERT_TO = () => String(process.env.PAGEPILOT_ALERT_EMAIL || 'production@yearbooklife.com').trim();
const INBOX_URL = () => String(process.env.PAGEPILOT_URL || 'https://claude.ai/artifact/3g5ZNubK1RtgowqV2ABQDq').trim();

function allowedOrigin(origin: string, host: string): boolean {
  if (!origin) return false;
  try {
    const h = new URL(origin).hostname;
    return h === host || h === 'claude.ai' || h.endsWith('.claude.ai') || h.endsWith('.claudeusercontent.com');
  } catch (e) { return false; }
}

// Per-instance limit: plenty for real sends, stops a page from flooding the inbox.
const hits = new Map<string, number[]>();
function limited(ip: string): boolean {
  const now = Date.now(), hour = 3600_000;
  const list = (hits.get(ip) || []).filter(t => now - t < hour);
  list.push(now); hits.set(ip, list);
  return list.length > 6;
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const cap = (v: unknown, n: number) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  noStore(res);
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '');
  if (allowedOrigin(origin, host)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!allowedOrigin(origin, host)) return res.status(403).json({ ok: false });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).json({ ok: false, error: 'rate-limited' });

  let b: any = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== 'object') return res.status(400).json({ ok: false });

  const code = cap(b.code, 20);
  if (!/^PRF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return res.status(400).json({ ok: false, error: 'bad-code' });
  const c = (b.contact && typeof b.contact === 'object') ? b.contact : {};
  const d = {
    school: cap(b.school, 120), year: cap(b.year, 20), book: cap(b.book, 60), pages: cap(b.pages, 6),
    coverSize: cap(b.coverSize, 40), approvedBy: cap(b.approvedBy, 80), press: cap(b.press, 160),
    name: cap(c.name, 80), email: cap(c.email, 120), phone: cap(c.phone, 40), city: cap(c.city, 80), qty: cap(c.qty, 8),
  };
  if (!d.school) return res.status(400).json({ ok: false });

  const row = (k: string, v: string) => v ? `<tr><td style="padding:6px 14px 6px 0;color:#5A6672;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:6px 0;color:#1F2937;font-weight:600">${esc(v)}</td></tr>` : '';
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;background:#F2F5F4;padding:24px"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">'
    + '<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#1C6A5E;font-weight:700">PagePilot</p>'
    + `<h1 style="margin:0 0 16px;font-size:22px;color:#1F2937">New book ready: ${esc(d.school)}</h1>`
    + '<table style="border-collapse:collapse;font-size:14px">'
    + row('School', d.school + (d.year ? ' · ' + d.year : ''))
    + row('Book', [d.book, d.pages ? d.pages + ' pages' : '', d.coverSize ? 'cover ' + d.coverSize : ''].filter(Boolean).join(' · '))
    + row('How many books', d.qty)
    + row('Proof', code + (d.approvedBy ? ' · approved by ' + d.approvedBy : ''))
    + row('PressCheck', d.press)
    + row('Contact', d.name) + row('Email', d.email) + row('Phone', d.phone) + row('City', d.city)
    + '</table>'
    + `<p style="margin:22px 0 8px"><a href="${esc(INBOX_URL())}" style="display:inline-block;background:#EB6E44;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:999px">Open the PagePilot inbox</a></p>`
    + '<p style="font-size:13px;color:#5A6672;margin:0">Download the Cover and Pages files from the inbox. They are checked against what the school approved before they download.</p>'
    + '<p style="font-size:12px;color:#94a3b8;margin-top:24px">PagePilot by YearbookLife · 888-680-0143</p></div></div>';

  const ok = await sendEmail(ALERT_TO(), `PagePilot: new book from ${d.school} (${code})`, html, 'PagePilot by YearbookLife');
  return res.status(ok ? 200 : 502).json({ ok });
}
