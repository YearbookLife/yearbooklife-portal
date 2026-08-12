import { VercelRequest, VercelResponse } from '@vercel/node';

// Saves the customer's self-reported book progress to their HubSpot deal.
// Called instantly when they click a progress pill on the dashboard.
const ALLOWED = [
  'Not started / Need help',
  'Just started',
  'About halfway',
  'Nearly done',
  'Ready to submit'
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS / preflight
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'Server not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const dealId = String(body.dealId || '').trim();
    const progress = String(body.progress || '').trim();

    if (!dealId) return res.status(400).json({ error: 'dealId required' });
    if (ALLOWED.indexOf(progress) === -1) {
      return res.status(400).json({ error: 'invalid progress value' });
    }

    // Write to the deal's book_progress field
    const resp = await fetch(`https://api.hubapi.com/crm/v3/objects/deals/${dealId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ properties: { book_progress: progress } })
    });

    if (!resp.ok) {
      const detail = await resp.text();
      return res.status(resp.status).json({ error: 'HubSpot update failed', detail });
    }

    return res.status(200).json({ ok: true, dealId, progress });

  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    return res.status(500).json({ error: msg });
  }
}
