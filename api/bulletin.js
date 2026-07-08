export default async function handler(req, res) {
  try {
    const sheetId = '1oDZmtciLQuaSeYdhXwcZOkExGT-NnNSHxDd_GXbdloU';
    const gidMap = {
      'Pictavo': 0,
      'YBLive': 941696032,
      'Canva': 1517851588
    };
    const platform = req.query.platform || 'Pictavo';
    const gid = gidMap[platform] || 0;
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    const response = await fetch(csvUrl);
    if (!response.ok) {
      throw new Error(`Google Sheets returned status ${response.status}`);
    }
    const csvText = await response.text();
    const rows = csvText.split('\n').filter(row => row.trim() !== '');
    if (rows.length < 2) {
      return res.status(200).json({ notices: [] });
    }
    const headers = rows[0].split(',').map(h => h.trim());
    const dateIdx = headers.indexOf('Date');
    const titleIdx = headers.indexOf('Title');
    const messageIdx = headers.indexOf('Message');
    const colorIdx = headers.indexOf('Color');
    const notices = [];
    for (let i = 1; i < rows.length; i++) {
      const values = rows[i].split(',').map(v => v.trim());
      if (values.length < 4 || !values[dateIdx]) continue;
      const notice = {
        date: values[dateIdx],
        title: values[titleIdx],
        message: values[messageIdx],
        color: values[colorIdx].toLowerCase()
      };
      notices.push(notice);
    }
    res.status(200).json({ notices });
  } catch (error) {
    console.error('Error fetching bulletin data:', error);
    res.status(500).json({ 
      error: 'Failed to fetch bulletin board data',
      message: error.message 
    });
  }
}
