import { VercelRequest, VercelResponse } from '@vercel/node';

// TEMPORARY HELPER: reads the exact internal values of dropdown options for
// the fields we need (plan_choice and book_size). Delete after we have them.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'No HubSpot token' });

  const fields = ['plan_choice', 'book_size'];
  const out: any = {};

  try {
    for (const f of fields) {
      const resp = await fetch(
        `https://api.hubapi.com/crm/v3/properties/deals/${f}`,
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      if (!resp.ok) {
        out[f] = { error: 'could not read', status: resp.status };
        continue;
      }
      const data = await resp.json();
      out[f] = {
        label: data.label,
        type: data.type,
        options: (data.options || []).map(function (o: any) {
          return { label: o.label, value: o.value };
        })
      };
    }
    return res.status(200).json(out);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'error';
    return res.status(500).json({ error: msg });
  }
}
