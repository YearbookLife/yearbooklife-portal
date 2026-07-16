import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // Get deal ID from query parameters
    const dealId = req.query.dealId as string;
    
    if (!dealId) {
      return res.status(400).json({ error: 'dealId parameter required' });
    }

    // HubSpot credentials from environment variables
    // These should be set in Vercel environment variables
    const appId = process.env.HUBSPOT_APP_ID || '45949358';
    const clientId = process.env.HUBSPOT_CLIENT_ID || '83bfee0d-3a2d-4f03-87ad-cab1590a86d6';
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET || '39023239-37cc-4702-8ad9-4d69398ba5c2';
    const accountId = process.env.HUBSPOT_ACCOUNT_ID || '20864988';
    const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;

    // If we have an access token, use it. Otherwise we'll need to implement OAuth
    if (!accessToken) {
      return res.status(400).json({ 
        error: 'HubSpot access token not configured. Please set HUBSPOT_ACCESS_TOKEN environment variable.' 
      });
    }

    // Fetch deal data from HubSpot
    const dealResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,amount,closedate,pipeline,hs_object_id&limit=100`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!dealResponse.ok) {
      return res.status(dealResponse.status).json({ 
        error: `HubSpot API error: ${dealResponse.statusText}`,
        details: await dealResponse.text()
      });
    }

    const dealData = await dealResponse.json();

    // Extract properties
    const properties = dealData.properties || {};
    
    // Map HubSpot properties to our customer data format
    const customerData = {
      dealId: dealId,
      dealName: properties.dealname?.value || '',
      schoolName: properties.schoolname?.value || 'School Name',
      planChoice: normalizePlanChoice(properties.planchoice?.value),
      numBooks: parseInt(properties.numbooks?.value || '0'),
      numPages: parseInt(properties.numpages?.value || '0'),
      bindingType: properties.bindingtype?.value || 'N/A',
      bookSize: properties.booksize?.value || 'N/A',
      paperWeight: properties.paperweight?.value || 'N/A',
      submitDate: properties.submitdate?.value || 'TBD',
      deliveryDate: properties.deliverydate?.value || 'TBD',
      basePricePerBook: parseFloat(properties.basepriceperboo?.value || '0'),
      multiYearTerm: properties.multiyearterm?.value || 'N/A',
      shipping: properties.shipping?.value || 'N/A',
      optionalItem1: properties.optionalitem1?.value || '',
      optionalItem1Price: parseFloat(properties.optionalitem1price?.value || '0'),
      optionalItem2: properties.optionalitem2?.value || '',
      optionalItem2Price: parseFloat(properties.optionalitem2price?.value || '0'),
      optionalItem3: properties.optionalitem3?.value || '',
      optionalItem3Price: parseFloat(properties.optionalitem3price?.value || '0'),
      invoiceUrl: properties.invoiceurl?.value || '',
      canvaGoogleDrive: properties.canvagoogledrive?.value || '',
      canvaSubmissionForm: properties.canvasubmissionform?.value || '',
      canvaCoverDimensions: properties.canvacoverdimensions?.value || '',
      urgentMessage: properties.urgentmessage?.value || '',
      messageTitle: properties.messagetitle?.value || '',
      messageType: properties.messagetype?.value || 'info'
    };

    return res.status(200).json({ success: true, data: customerData });

  } catch (error) {
    console.error('Error fetching HubSpot deal:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ 
      error: 'Failed to fetch deal data',
      details: errorMessage
    });
  }
}

// Normalize plan choice to handle variations
function normalizePlanChoice(choice: string | undefined): string {
  if (!choice) return 'Pictavo';
  
  const normalized = choice.trim().toUpperCase();
  
  // Pictavo variations
  if (normalized === 'PICTAVO' || normalized === 'PICTAVO (DP)') {
    return 'Pictavo';
  }
  
  // Canva variations
  if (normalized === 'CANVA (DP)' || normalized === 'CANVA (PI)') {
    return 'Canva';
  }
  
  // YBLive
  if (normalized === 'YBLIVE') {
    return 'YBLive';
  }
  
  return 'Pictavo'; // Default
}
