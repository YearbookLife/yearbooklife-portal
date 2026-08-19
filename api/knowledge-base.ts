import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * KNOWLEDGE BASE API
 *
 * Serves the FAQ questions for the Knowledge Base tab of the customer dashboard.
 * The questions live in the same Google Sheet as the Bulletin Board, on three
 * extra tabs (KB_Pictavo, KB_YBLive, KB_Canva).
 *
 * Sheet columns:  Order | Question | Answer | Active
 *
 *   Order   - controls the display order (10, 20, 30... so you can insert at 25)
 *   Active  - "No" hides the question without deleting it. Anything else shows it.
 *
 * Inside an Answer you can use:
 *   [click text](https://the-url.com)   -> becomes a real clickable link
 *   **some words**                      -> becomes bold
 *   Emails and phone numbers link automatically. No special formatting needed.
 *
 * NOTE: Total Digital plans deliberately have no tab here. They fall back to the
 * built-in questions in index.html.
 */

// Same spreadsheet as the Bulletin Board
const SHEET_ID = '1oDZmtciLQuaSeYdhXwcZOkExGT-NnNSHxDd_GXbdloU';

// The gid of each Knowledge Base tab (from the end of the URL when that tab is open)
const GID_MAP: { [key: string]: number } = {
  'Pictavo': 213369231,
  'YBLive': 1636942135,
  'Canva': 1071489875
};

/**
 * Proper CSV parser.
 *
 * Do NOT replace this with row.split(','). Answers are full of commas, and a
 * split would chop them in half and shift every column after it. This walks the
 * text character by character and respects quoted fields, commas inside quotes,
 * line breaks inside quotes, and escaped ("") quotes.
 */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  // Normalise Windows / old Mac line endings
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';   // an escaped quote inside a quoted field
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

  // Whatever is left over at the end of the file
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

interface Faq {
  question: string;
  answer: string;
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
    const platform = (req.query.platform as string) || '';

    // No tab for this plan (e.g. Total Digital) -> return nothing and let the
    // dashboard keep showing its built-in questions.
    if (!Object.prototype.hasOwnProperty.call(GID_MAP, platform)) {
      return res.status(200).json({ faqs: [], count: 0, source: 'none' });
    }

    const gid = GID_MAP[platform];
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;

    const response = await fetch(csvUrl);
    if (!response.ok) {
      return res.status(200).json({
        faqs: [],
        count: 0,
        error: `Google Sheets returned status ${response.status}`
      });
    }

    const csvText = await response.text();
    const rows = parseCSV(csvText);

    if (rows.length < 2) {
      return res.status(200).json({ faqs: [], count: 0 });
    }

    const headers = rows[0];
    const orderIdx = columnIndex(headers, 'Order');
    const questionIdx = columnIndex(headers, 'Question');
    const answerIdx = columnIndex(headers, 'Answer');
    const activeIdx = columnIndex(headers, 'Active');

    if (questionIdx === -1 || answerIdx === -1) {
      return res.status(200).json({
        faqs: [],
        count: 0,
        error: 'Sheet is missing a "Question" or "Answer" column'
      });
    }

    const collected: { order: number; seq: number; faq: Faq }[] = [];

    for (let i = 1; i < rows.length; i++) {
      const values = rows[i];
      const question = String(values[questionIdx] || '').trim();
      const answer = String(values[answerIdx] || '').trim();

      // Skip blank rows
      if (!question || !answer) continue;

      // Respect the Active column. Only an explicit "no" hides a row, so a blank
      // Active cell still shows the question.
      if (activeIdx !== -1) {
        const active = String(values[activeIdx] || '').trim().toLowerCase();
        if (active === 'no' || active === 'n' || active === 'false' || active === '0') {
          continue;
        }
      }

      let order = Number.MAX_SAFE_INTEGER;
      if (orderIdx !== -1) {
        const parsed = parseInt(String(values[orderIdx] || '').trim(), 10);
        if (!isNaN(parsed)) order = parsed;
      }

      collected.push({ order, seq: i, faq: { question, answer } });
    }

    // Sort by the Order column; anything without an order keeps its sheet position
    collected.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));

    const faqs = collected.map(c => c.faq);

    return res.status(200).json({ faqs, count: faqs.length, platform });
  } catch (error) {
    console.error('Error fetching knowledge base data:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(200).json({ faqs: [], count: 0, error: errorMessage });
  }
}
