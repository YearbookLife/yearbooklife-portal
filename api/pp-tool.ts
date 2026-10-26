import { VercelRequest, VercelResponse } from '@vercel/node';
import { ppEnabled, configured, currentAdmin, ADMIN_BLOCK_MESSAGES, noStore, esc, logEvent } from '../lib/pp';
import * as dashboardTool from './portraitpop';

/**
 * SERVE PORTRAITPOP TO A LICENSED SCHOOL ADMIN
 *
 * The same PortraitPop the dashboard uses (one copy of the tool, so updates
 * happen once). The HTML is borrowed from api/portraitpop.ts at runtime.
 *
 * Differences from the dashboard route:
 *   - No pass in the address and no pass inside the page. The sign-in lives in an
 *     HttpOnly cookie the page's own code can't read, so a saved or emailed copy
 *     of this page has nothing to export with.
 *   - Every exported PDF is stamped (in its file properties) with the school's
 *     license code, so a shared login can be traced back.
 *   - The "session ended" wording points to the PortraitPop account page instead
 *     of the YearbookLife dashboard.
 *
 * If api/portraitpop.ts is ever regenerated without "export" on
 * PORTRAITPOP_HTML_B64, this route shows a friendly error and the dashboard
 * keeps working exactly as before.
 */

function page(res: VercelResponse, status: number, title: string, message: string) {
  noStore(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send('<!DOCTYPE html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="robots" content="noindex, nofollow"><title>PortraitPop</title><style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#D9F4F2;'
    + 'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;color:#0B2840}'
    + '.card{background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.08);padding:38px 34px;max-width:440px;text-align:center}'
    + 'h1{margin:0 0 12px;font-size:21px}p{margin:0 0 22px;font-size:15px;color:#475569;line-height:1.6}'
    + 'a{display:inline-block;background:#FF6A00;color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:10px}'
    + '</style></head><body><div class="card"><img src="/portraitpop-logo.png" alt="PortraitPop by YearbookLife" width="150" style="margin-bottom:18px">'
    + '<h1>' + esc(title) + '</h1><p>' + esc(message) + '</p><a href="/pp">Go to my PortraitPop account</a></div></body></html>');
}

// Replaces the tool's dashboard-specific wording and its session check, and
// stamps PDFs. Runs after the tool's own script, so these win.
function licensedScript(code: string): string {
  return '<script>(function(){'
    + 'window.__PP_STAMP=' + JSON.stringify(code) + ';'
    + 'window.__PP_LAST="";'
    + 'window.verifySession=async function(){'
    + '  try{'
    + '    var r=await fetch("/api/pp-verify",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"});'
    + '    var d={};try{d=await r.json();}catch(e){}'
    + '    window.__PP_LAST=(d&&d.message)||"";'
    + '    if(r.status===401||r.status===403||(d&&d.valid===false))return{ok:false,reason:"expired"};'
    + '    if(!r.ok)return{ok:false,reason:"server"};'
    + '    return{ok:true};'
    + '  }catch(e){return{ok:false,reason:"offline"};}'
    + '};'
    + 'window.blockedBanner=function(reason){'
    + '  var m={'
    + '    expired:{title:"Please sign in again",body:window.__PP_LAST||"Your PortraitPop sign-in has ended. Go back to your PortraitPop account page, sign in, and open PortraitPop again."},'
    + '    offline:{title:"Can\\u2019t reach PortraitPop",body:"Your pages are built on this computer, but we check your sign-in first and that needs a connection. Check your internet and try again."},'
    + '    server:{title:"Couldn\\u2019t confirm your sign-in",body:"Something went wrong at our end, not yours. Try again in a moment, and call YearbookLife at 888-680-0143 if it keeps happening."}'
    + '  }[reason]||{title:"Unable to build your pages right now",body:"Open PortraitPop from your PortraitPop account page and try again."};'
    + '  return \'<div class="banner warn"><div class="banner-icon">!</div><div><b>\'+esc(m.title)+\'</b><span class="sub">\'+esc(m.body)+\'</span></div></div>\';'
    + '};'
    + '})();</script>';
}

const PDF_ANCHOR = 'const doc  = await PDFDocument.create();';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') { res.status(405).end(); return; }
  if (!ppEnabled() || !configured().ok) {
    return page(res, 503, 'PortraitPop isn’t available yet', 'Please try again later, or call YearbookLife at 888-680-0143.');
  }

  try {
    const a = await currentAdmin(req);
    if (a.ok === false) return page(res, 401, 'Please sign in', ADMIN_BLOCK_MESSAGES[a.reason]);

    const b64 = (dashboardTool as any).PORTRAITPOP_HTML_B64;
    if (typeof b64 !== 'string' || b64.length < 1000) {
      console.error('pp-tool: PORTRAITPOP_HTML_B64 is not exported from api/portraitpop.ts');
      return page(res, 500, 'PortraitPop is being updated', 'Please try again in a little while, or call YearbookLife at 888-680-0143.');
    }
    let html = Buffer.from(b64, 'base64').toString('utf8');

    // The tool fails closed without these, so set them. The real proof of sign-in
    // is the cookie; this value is only a "yes, check with the server" marker.
    const inject = '<script>window.__PORTRAITPOP_SESSION="cookie";window.__PORTRAITPOP_VERIFY_URL="/api/pp-verify";</script>';
    html = html.replace('<head>', '<head>' + inject);
    if (html.indexOf('__PORTRAITPOP_SESSION__') !== -1) html = html.split('__PORTRAITPOP_SESSION__').join('cookie');

    // Keep each school's saved work separate from other accounts on the same computer.
    html = html.split("'portraitpop.work.v1'").join("'portraitpop.work.v1.pp." + String(a.license.id).slice(0, 8) + "'");

    const code = String(a.license.code || '');
    if (html.indexOf(PDF_ANCHOR) !== -1) {
      html = html.replace(PDF_ANCHOR, PDF_ANCHOR
        + '\n  try{ if (window.__PP_STAMP) { doc.setKeywords(["PortraitPop", "License " + window.__PP_STAMP]);'
        + ' doc.setCreator("PortraitPop by YearbookLife - License " + window.__PP_STAMP); } }catch(e){}');
    } else {
      console.warn('pp-tool: PDF stamp anchor not found; exports will not carry the license code');
    }

    const lastBody = html.lastIndexOf('</body>');
    html = lastBody !== -1
      ? html.slice(0, lastBody) + licensedScript(code) + html.slice(lastBody)
      : html + licensedScript(code);

    await logEvent('tool-opened', { req, email: a.session.e, license_id: a.license.id, photographer_id: a.photographer.id, device: a.session.d });

    noStore(res);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    return res.status(200).send(html);
  } catch (e) {
    console.error('pp-tool error:', e);
    return page(res, 500, 'Something went wrong', 'Please try again from your PortraitPop account page.');
  }
}
