import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * BULLETIN BOARD API
 *
 * Serves the announcement notes for the Bulletin Board tab of the customer dashboard.
 * Notices live in a Google Sheet with one tab per platform.
 *
 * Sheet columns:  Date | Title | Message | Color
 *
 * FIXED: this used to split each row on commas, which chopped any message that
 * contained a comma in half and shifted the Color column onto the wrong value.
 * It now uses a proper CSV parser, so commas, quotes and line breaks inside a
 * message are all safe to type.
 */

const SHEET_ID = '1oDZmtciLQuaSeYdhXwcZOkExGT-NnNSHxDd_GXbdloU';

// Map platform names to Google Sheet gid values
const GID_MAP: { [key: string]: number } = {
  'Pictavo': 0,
  'YBLive': 941696032,
  'Canva': 1517851588
};

/**
 * Proper CSV parser.
 *
 * Do NOT replace this with row.split(','). This walks the text character by
 * character and respects quoted fields, commas inside quotes, line breaks
 * inside quotes, and escaped ("") quotes.
 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Find a column by name, ignoring case and stray spaces. Returns -1 if missing. */
function columnIndex(headers: string[], name: string): number {
  const target = name.trim().toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i] || '').trim().toLowerCase() === target) return i;
  }
  return -1;
}

interface Notice {
  date: string;
  title: string;
  message: string;
  color: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    const platform = (req.query.platform as string) || 'Pictavo';
    const gid = Object.prototype.hasOwnProperty.call(GID_MAP, platform) ? GID_MAP[platform] : 0;

    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;

    const response = await fetch(csvUrl);
    if (!response.ok) {
      return res.status(200).json({
        notices: [],
        error: `Google Sheets returned status ${response.status}`
      });
    }

    const csvText = await response.text();
    const rows = parseCSV(csvText);

    if (rows.length < 2) {
      return res.status(200).json({ notices: [] });
    }

    const headers = rows[0];
    const dateIdx = columnIndex(headers, 'Date');
    const titleIdx = columnIndex(headers, 'Title');
    const messageIdx = columnIndex(headers, 'Message');
    const colorIdx = columnIndex(headers, 'Color');

    if (dateIdx === -1 || titleIdx === -1 || messageIdx === -1) {
      return res.status(200).json({
        notices: [],
        error: 'Sheet is missing a "Date", "Title" or "Message" column'
      });
    }

    const notices: Notice[] = [];

    for (let i = 1; i < rows.length; i++) {
      const values = rows[i];
      const date = String(values[dateIdx] || '').trim();

      // Skip blank rows
      if (!date) continue;

      const color = colorIdx !== -1
        ? String(values[colorIdx] || '').trim().toLowerCase()
        : '';

      notices.push({
        date,
        title: String(values[titleIdx] || '').trim(),
        message: String(values[messageIdx] || '').trim(),
        color: color || 'yellow'
      });
    }

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
