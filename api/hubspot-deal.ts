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

    // HubSpot access token from environment variable
    const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;

    if (!accessToken) {
      return res.status(400).json({ 
        error: 'HubSpot access token not configured. Please set HUBSPOT_ACCESS_TOKEN environment variable.' 
      });
    }

    // Fetch deal data from HubSpot with all required properties
    const dealResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealname,plan_choice,submit_date,final___of_books,final___of_pages,final_binding_type,book_size,paper_weight,delivery_est_,final_base_price_per_book,multi_year_term,contract_shipping,optional_item_1,optional_item_1_price,optional_item_2,optional_item_2_price,optional_item_3,optional_item_3_price,invoiceurl,canvagoogledrive,canvasubmissionform,canvacoverdimensions,urgent_portal_message,portal_message_title,portal_message_type`,
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
    const properties = dealData.properties || {};

    // Map HubSpot properties to our customer data format
    const customerData = {
      dealId: dealId,
      dealName: properties.dealname?.value || '',
      schoolName: properties.dealname?.value || 'School Name', // School name IS the deal name
      planChoice: normalizePlanChoice(properties.planchoice?.value),
      numBooks: parseInt(properties.final_number_of_books?.value || '0'),
      numPages: parseInt(properties.final_number_of_pages?.value || '0'),
      bindingType: properties.final_binding_type?.value || 'N/A',
      bookSize: properties.book_size?.value || 'N/A',
      paperWeight: properties.paper_weight?.value || 'N/A',
      submitDate: properties.submit_date?.value || 'TBD',
      deliveryDate: properties.delivery_est?.value || 'TBD',
      basePricePerBook: parseFloat(properties.final_base_price_per_book?.value || '0'),
      multiYearTerm: properties.multi_year_term?.value || 'N/A',
      shipping: properties.contract_shipping?.value || 'N/A',
      optionalItem1: properties.optional_item_1?.value || '',
      optionalItem1Price: parseFloat(properties.optional_item_1_price_per_book?.value || '0'),
      optionalItem2: properties.optional_item_2?.value || '',
      optionalItem2Price: parseFloat(properties.optional_item_2_price_per_book?.value || '0'),
      optionalItem3: properties.optional_item_3?.value || '',
      optionalItem3Price: parseFloat(properties.optional_item_3_price_per_book?.value || '0'),
      invoiceUrl: properties.invoiceurl?.value || '',
      canvaGoogleDrive: properties.canvagoogledrive?.value || '',
      canvaSubmissionForm: properties.canvasubmissionform?.value || '',
      canvaCoverDimensions: properties.canvacoverdimensions?.value || '',
      urgentMessage: properties.urgent_portal_message?.value || '',
      messageTitle: properties.portal_message_title?.value || '',
      messageType: properties.portal_message_type?.value || 'info'
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
