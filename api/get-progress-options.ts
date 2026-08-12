import { VercelRequest, VercelResponse } from '@vercel/node';

// TEMPORARY HELPER: reads the exact internal values of the book_progress
// dropdown options from HubSpot. Delete this file after we have the values.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'No HubSpot token' });

  try {
    const resp = await fetch(
      'https://api.hubapi.com/crm/v3/properties/deals/book_progress',
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    if (!resp.ok) {
      const detail = await resp.text();
      return res.status(resp.status).json({ error: 'Could not read property', detail });
    }
    const data = await resp.json();
    const options = (data.options || []).map(function (o: any) {
      return { label: o.label, value: o.value };
    });
    return res.status(200).json({
      fieldName: data.name,
      fieldLabel: data.label,
      fieldType: data.type,
      options: options
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    return res.status(500).json({ error: msg });
  }
}
