import { VercelRequest, VercelResponse } from '@vercel/node';

// TEMPORARY: dumps all properties on a deal so we can find the real
// internal name for "date entered current stage". Delete after use.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'No token' });

  const dealId = (req.query.dealId as string) || '62706477603';

  try {
    // Ask for ALL properties on this deal
    const resp = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?propertiesWithHistory=&archived=false`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    // The above may not return everything; do a proper "get with all properties"
    const resp2 = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}`,
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    const data = await resp2.json();
    const props = data.properties || {};

    // Filter to only property names that look date/stage related
    const relevant: any = {};
    for (const key of Object.keys(props)) {
      const k = key.toLowerCase();
      if (k.includes('date') || k.includes('stage') || k.includes('entered') || k.includes('enter')) {
        relevant[key] = props[key];
      }
    }

    return res.status(200).json({
      dealId,
      dealstage: props.dealstage,
      relevantDateStageProps: relevant,
      allPropertyNames: Object.keys(props)
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'failed', detail: msg });
  }
}
