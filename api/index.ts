import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // Your Google Sheet ID
    const sheetId = '1oDZmtciLQuaSeYdhXwcZOkExGT-NnNSHxDd_GXbdloU';
    
    // Map platform names to Google Sheet gid values
    const gidMap: { [key: string]: number } = {
      'Pictavo': 0,
      'YBLive': 941696032,
      'Canva': 1517851588
    };
    
    // Get the platform from the request
    const platform = (req.query.platform as string) || 'Pictavo';
    const gid = gidMap[platform] || 0;
    
    // Build the Google Sheets CSV export URL
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    
    // Fetch the CSV data from Google Sheets
    const response = await fetch(csvUrl);
    
    if (!response.ok) {
      return res.status(200).json({ 
        notices: [],
        error: `Google Sheets returned status ${response.status}`
      });
    }
    
    const csvText = await response.text();
    
    // Parse the CSV data
    const rows = csvText.split('\n').filter(row => row.trim() !== '');
    
    if (rows.length < 2) {
      return res.status(200).json({ notices: [] });
    }
    
    // Parse the header row
    const headers = rows[0].split(',').map(h => h.trim());
    const dateIdx = headers.indexOf('Date');
    const titleIdx = headers.indexOf('Title');
    const messageIdx = headers.indexOf('Message');
    const colorIdx = headers.indexOf('Color');
    
    // Process data rows (skip header)
    interface Notice {
      date: string;
      title: string;
      message: string;
      color: string;
    }
    
    const notices: Notice[] = [];
    for (let i = 1; i < rows.length; i++) {
      const values = rows[i].split(',').map(v => v.trim());
      
      // Skip empty rows
      if (values.length < 4 || !values[dateIdx]) continue;
      
      const notice: Notice = {
        date: values[dateIdx],
        title: values[titleIdx],
        message: values[messageIdx],
        color: values[colorIdx].toLowerCase()
      };
      
      notices.push(notice);
    }
    
    // Return the notices as JSON
    return res.status(200).json({ notices });
    
  } catch (error) {
    console.error('Error fetching bulletin data:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(200).json({ 
      notices: [],
      error: errorMessage
    });
  }
}
