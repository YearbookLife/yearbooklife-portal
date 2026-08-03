import { VercelRequest, VercelResponse } from '@vercel/node';

// TEMPORARY helper: lists all deal pipelines and their stages so we can
// see the exact names/IDs. Safe to delete after we've grabbed the info.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'No HubSpot token' });

  try {
    const resp = await fetch('https://api.hubapi.com/crm/v3/pipelines/deals', {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) {
      const detail = await resp.text();
      return res.status(resp.status).json({ error: 'Could not read pipelines', detail });
    }
    const data = await resp.json();

    // Trim to just what we need: pipeline label + each stage's label
    const clean = (data.results || []).map((p: any) => ({
      pipeline: p.label,
      pipelineId: p.id,
      stages: (p.stages || []).map((s: any) => ({ stage: s.label, stageId: s.id }))
    }));

    return res.status(200).json({ pipelines: clean });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: 'list-pipelines failed', detail: msg });
  }
}
