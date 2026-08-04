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
    const dealId = req.query.dealId as string;

    if (!dealId) {
      return res.status(400).json({ error: 'dealId parameter required' });
    }

    const accessToken = process.env.HUBSPOT_ACCESS_TOKEN;

    if (!accessToken) {
      return res.status(400).json({
        error: 'HubSpot access token not configured. Please set HUBSPOT_ACCESS_TOKEN environment variable.'
      });
    }

    const dealResponse = await fetch(
      `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=dealname,plan_choice,submit_date,cover_due_date,final___of_books,final___of_pages,final_binding_type,book_size,paper_weight,delivery_est_,final_base_price_per_book,multi_year_term,contract_shipping,books_shipping_address,books_shipping_address_2,books_shipping_city,books_shipping_state,books_shipping_zip,optional_item_1,optional_item_1_price,optional_item_2,optional_item_2_price,optional_item_3,optional_item_3_price,invoiceurl,canva_google_drive,canva_submission_form_link,canvacoverdimensions,cover_width,cover_height,cover_gap,urgent_portal_message,portal_message_title,portal_message_type`,
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
        error: `HubSpot API error: ${dealResponse.statusText}`
      });
    }

    const dealData = await dealResponse.json();
    const properties = dealData.properties || {};

    const customerData = {
      dealId: dealId,
      dealName: properties.dealname || '',
      schoolName: properties.dealname || 'School Name',
      planChoice: normalizePlanChoice(properties.plan_choice),
      numBooks: parseInt(properties.final___of_books || '0'),
      numPages: parseInt(properties.final___of_pages || '0'),
      bindingType: properties.final_binding_type || 'N/A',
      bookSize: properties.book_size || 'N/A',
      paperWeight: properties.paper_weight || 'N/A',
      submitDate: properties.submit_date || 'TBD',
      coverDueDate: properties.cover_due_date || '',
      deliveryDate: properties.delivery_est_ || 'TBD',
      basePricePerBook: parseFloat(properties.final_base_price_per_book || '0'),
      multiYearTerm: properties.multi_year_term || 'N/A',
      shipping: properties.contract_shipping || 'N/A',
      shipAddress: properties.books_shipping_address || '',
      shipAddress2: properties.books_shipping_address_2 || '',
      shipCity: properties.books_shipping_city || '',
      shipState: properties.books_shipping_state || '',
      shipZip: properties.books_shipping_zip || '',
      optionalItem1: properties.optional_item_1 || '',
      optionalItem1Price: parseFloat(properties.optional_item_1_price || '0'),
      optionalItem2: properties.optional_item_2 || '',
      optionalItem2Price: parseFloat(properties.optional_item_2_price || '0'),
      optionalItem3: properties.optional_item_3 || '',
      optionalItem3Price: parseFloat(properties.optional_item_3_price || '0'),
      invoiceUrl: properties.invoiceurl || '',
      canvaGoogleDrive: properties.canva_google_drive || '',
      canvaSubmissionForm: properties.canva_submission_form_link || '',
      canvaCoverDimensions: properties.canvacoverdimensions || '',
      coverWidth: properties.cover_width || '',
      coverHeight: properties.cover_height || '',
      coverGap: properties.cover_gap || '',
      urgentMessage: properties.urgent_portal_message || '',
      messageTitle: properties.portal_message_title || '',
      messageType: properties.portal_message_type || 'info'
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

function normalizePlanChoice(choice: string | undefined): string {
  if (!choice) return 'Pictavo';

  const normalized = choice.trim().toUpperCase();

  // Match on keywords so any variation routes correctly:
  // e.g. "Canva (DP)", "Canva (PI)", "Canva-Print (DP)", "Canva-Print (PI)" all -> Canva
  if (normalized.includes('CANVA')) {
    return 'Canva';
  }

  if (normalized.includes('YBLIVE') || normalized.includes('YB LIVE')) {
    return 'YBLive';
  }

  if (normalized.includes('PICTAVO')) {
    return 'Pictavo';
  }

  return 'Pictavo';
}
