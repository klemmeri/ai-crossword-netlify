// generate-puzzle.js — Netlify serverless function
// Calls Anthropic Claude instead of OpenAI.

const https = require('https');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Use POST.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Request body must be JSON.' });
  }

  const theme      = cleanText(body.theme || '').slice(0, 180);
  const difficulty = ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'medium';
  const size       = Number(body.size || 15);
  const wordPool   = clamp(Number(body.wordPool || 80), 40, 120);

  if (!theme) return json(400, { error: 'Theme is required.' });
  if (size !== 15) return json(400, { error: 'This prototype currently supports 15x15 puzzles only.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: 'ANTHROPIC_API_KEY is not set in Netlify environment variables. Add it in Netlify: Site configuration -> Environment variables.'
    });
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  let lastError = 'Unknown validation failure.';

  for (let attempt = 1; attempt <= 2; attempt++) {
    let aiText;
    try {
      aiText = await callAnthropic({ apiKey, model, theme, difficulty, size, wordPool, attempt, lastError });
    } catch (err) {
      return json(502, { error: `AI service error: ${err.message}` });
    }

    const parsed = extractJson(aiText);
    if (!parsed.ok) { lastError = parsed.error; continue; }

    const normalized = normalizePuzzle(parsed.data, { theme, difficulty, size });
    const validation = validatePuzzle(normalized);
    if (validation.ok) {
      return json(200, finalizePuzzle(normalized, validation.entries, validation.quality));
    }
    lastError = validation.errors.join('; ');
  }

  return json(422, {
    error: `The AI did not return a valid 15x15 grid after two attempts. Last issue: ${lastError}`
  });
};

function callAnthropic({ apiKey, model, theme, difficulty, size, wordPool, attempt, lastError }) {
  const prompt = buildPrompt({ theme, difficulty, size, wordPool, attempt, lastError });
  const requestBody = JSON.stringify({
    model,
    max_tokens: 4000,
    system: 'You are a professional American crossword constructor. Return only valid JSON — no markdown, no explanation, no code fences.',
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req = https.request(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(requestBody)
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { return reject(new Error('Non-JSON response from Anthropic.')); }
        if (res.statusCode !== 200) {
          return reject(new Error(data.error?.message || `Anthropic returned HTTP ${res.statusCode}.`));
        }
        const text = data.content?.[0]?.text;
        if (!text) return reject(new Error('Empty content from Anthropic.'));
        resolve(text);
      });
    });
    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

function buildPrompt({ theme, difficulty, size, wordPool, attempt, lastError }) {
  const correction = attempt > 1 ? `\nYour previous attempt failed: ${lastError}\nFix these issues and return a corrected puzzle.` : '';

  return `Create a 15x15 American newspaper-style crossword puzzle about: ${theme}
Difficulty: ${difficulty}

GRID RULES — follow exactly:
- The "grid" array must have exactly 15 strings.
- Each string must be exactly 15 characters.
- Use ONLY uppercase A-Z letters for white cells and # for black squares.
- Black squares must be symmetric: if row R col C is #, then row (14-R) col (14-C) must also be #.
- Aim for about 38-42 black squares total.
- No answer shorter than 3 letters (no isolated 1- or 2-letter white runs).
- All white cells must connect to each other.

CLUE RULES:
- Every answer that appears in the grid must have a clue.
- The "clues" object keys must be the EXACT answer string as it appears in the grid.
- For example if the grid contains the word STORM, the clues object must have "STORM": "some clue".
- ${difficulty === 'easy' ? 'Use simple, direct definitions.' : difficulty === 'hard' ? 'Use wordplay, misdirection, and clever cluing.' : 'Use moderately indirect clues.'}

EXAMPLE of correct format (5x5 shown, yours must be 15x15):
{
  "title": "Mini Weather",
  "grid": [
    "STORM",
    "HOSES",
    "AVERT",
    "DENSE",
    "ESSAYS"
  ],
  "clues": {
    "STORM": "Tempest",
    "HOSES": "Garden watering tools",
    "AVERT": "Prevent",
    "DENSE": "Thick",
    "ESSAYS": "Written compositions",
    "SHA": "Quiet!",
    "OVE": "Above, poetically",
    "RES": "Legal matters",
    "STS": "Map abbr.",
    "MADE": "Created"
  },
  "themeEntries": ["STORM"]
}

Now create the full 15x15 version about "${theme}". Return JSON only.${correction}`;
}

function extractJson(text) {
  if (!text) return { ok: false, error: 'Empty AI response.' };
  const cleaned = text.replace(/```json|```/gi, '').trim();
  try { return { ok: true, data: JSON.parse(cleaned) }; } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return { ok: true, data: JSON.parse(cleaned.slice(start, end + 1)) }; }
    catch (err) { return { ok: false, error: `JSON parse failed: ${err.message}` }; }
  }
  return { ok: false, error: 'No JSON object found in AI response.' };
}

function normalizePuzzle(raw, defaults) {
  const grid = Array.isArray(raw.grid)
    ? raw.grid.map(row => String(row).toUpperCase().replace(/[^A-Z#]/g, '').slice(0, defaults.size))
    : [];

  const clues = (raw.clues && typeof raw.clues === 'object') ? raw.clues : {};
  const cleanClues = {};
  for (const [k, v] of Object.entries(clues)) {
    cleanClues[sanitizeAnswer(k)] = cleanText(v).slice(0, 220);
  }

  return {
    title: cleanText(raw.title || `${titleCase(defaults.theme)} Crossword`).slice(0, 80),
    size: defaults.size,
    difficulty: defaults.difficulty,
    theme: defaults.theme,
    grid,
    clues: cleanClues,
    themeEntries: Array.isArray(raw.themeEntries) ? raw.themeEntries.map(sanitizeAnswer).filter(Boolean) : []
  };
}

function validatePuzzle(puzzle) {
  const errors = [];
  const n = puzzle.size;

  if (!Array.isArray(puzzle.grid) || puzzle.grid.length !== n)
    errors.push(`Grid must contain ${n} rows, got ${puzzle.grid ? puzzle.grid.length : 0}.`);

  for (const [i, row] of (puzzle.grid || []).entries()) {
    if (row.length !== n) errors.push(`Row ${i + 1} must contain ${n} characters, got ${row.length}.`);
    if (/[^A-Z#]/.test(row)) errors.push(`Row ${i + 1} contains invalid characters.`);
  }
  if (errors.length) return { ok: false, errors };

  let blockCount = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = puzzle.grid[r][c];
      const b = puzzle.grid[n - 1 - r][n - 1 - c];
      if (a === '#') blockCount++;
      if ((a === '#') !== (b === '#'))
        errors.push(`Symmetry fails at row ${r + 1}, col ${c + 1}.`);
    }
  }

  const entries = extractEntries(puzzle.grid);
  for (const entry of entries) {
    if (entry.answer.length < 3)
      errors.push(`${entry.direction} ${entry.number} is shorter than 3 letters.`);
  }

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (puzzle.grid[r][c] === '#') continue;
      const acrossLen = lengthInDirection(puzzle.grid, r, c, 0, -1, 0, 1);
      const downLen   = lengthInDirection(puzzle.grid, r, c, -1, 0, 1, 0);
      if (acrossLen < 3 || downLen < 3)
        errors.push(`Unchecked cell at row ${r + 1}, col ${c + 1}.`);
    }
  }

  if (!isConnected(puzzle.grid)) errors.push('White cells are not all connected.');

  const dupes = findDuplicates(entries.map(e => e.answer));
  if (dupes.length) errors.push(`Duplicate answers: ${dupes.join(', ')}.`);

  const quality = {
    entryCount: entries.length,
    blockCount,
    rotationalSymmetry: !errors.some(e => e.includes('Symmetry')),
    allWhiteCellsChecked: !errors.some(e => e.includes('Unchecked') || e.includes('shorter')),
    connected: !errors.some(e => e.includes('connected'))
  };

  return { ok: errors.length === 0, errors, entries, quality };
}

function finalizePuzzle(puzzle, entries, quality) {
  const across = [], down = [];
  for (const entry of entries) {
    const clue = puzzle.clues[entry.answer] || fallbackClue(entry.answer, puzzle.difficulty);
    const out  = { number: entry.number, row: entry.row, col: entry.col, answer: entry.answer, clue };
    if (entry.direction === 'Across') across.push(out); else down.push(out);
  }
  return {
    title:        puzzle.title,
    size:         puzzle.size,
    difficulty:   puzzle.difficulty,
    theme:        puzzle.theme,
    grid:         puzzle.grid,
    across,
    down,
    themeEntries: puzzle.themeEntries,
    quality:      quality || {}
  };
}

function extractEntries(grid) {
  const n = grid.length;
  const entries = [];
  let number = 1;
  const starts = [];

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c] === '#') continue;
      const startsAcross = (c === 0 || grid[r][c-1] === '#') && c+2 < n && grid[r][c+1] !== '#' && grid[r][c+2] !== '#';
      const startsDown   = (r === 0 || grid[r-1][c] === '#') && r+2 < n && grid[r+1][c] !== '#' && grid[r+2][c] !== '#';
      if (startsAcross || startsDown) starts.push({ r, c, number: number++ });
    }
  }

  for (const s of starts) {
    if (s.c === 0 || grid[s.r][s.c-1] === '#') {
      let ans = '', c = s.c;
      while (c < n && grid[s.r][c] !== '#') ans += grid[s.r][c++];
      if (ans.length >= 3) entries.push({ number: s.number, direction: 'Across', row: s.r, col: s.c, answer: ans });
    }
    if (s.r === 0 || grid[s.r-1][s.c] === '#') {
      let ans = '', r = s.r;
      while (r < n && grid[r][s.c] !== '#') ans += grid[r++][s.c];
      if (ans.length >= 3) entries.push({ number: s.number, direction: 'Down', row: s.r, col: s.c, answer: ans });
    }
  }
  return entries;
}

function lengthInDirection(grid, r, c, dr1, dc1, dr2, dc2) {
  const n = grid.length;
  let len = 1;
  let rr = r + dr1, cc = c + dc1;
  while (rr >= 0 && rr < n && cc >= 0 && cc < n && grid[rr][cc] !== '#') { len++; rr += dr1; cc += dc1; }
  rr = r + dr2; cc = c + dc2;
  while (rr >= 0 && rr < n && cc >= 0 && cc < n && grid[rr][cc] !== '#') { len++; rr += dr2; cc += dc2; }
  return len;
}

function isConnected(grid) {
  const n = grid.length;
  let start = null, whiteCount = 0;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (grid[r][c] !== '#') { whiteCount++; if (!start) start = [r, c]; }
  if (!start) return false;
  const seen = new Set([start.join(',')]);
  const q = [start];
  while (q.length) {
    const [r, c] = q.shift();
    for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nr = r+dr, nc = c+dc, key = `${nr},${nc}`;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n || grid[nr][nc] === '#' || seen.has(key)) continue;
      seen.add(key); q.push([nr, nc]);
    }
  }
  return seen.size === whiteCount;
}

function fallbackClue(answer, difficulty) {
  if (difficulty === 'hard')   return `Tricky entry (${answer.length} letters)`;
  if (difficulty === 'medium') return `${answer.length}-letter word`;
  return `${answer.length} letters`;
}

function findDuplicates(items) {
  const seen = new Set(), dupes = new Set();
  for (const x of items) seen.has(x) ? dupes.add(x) : seen.add(x);
  return [...dupes];
}

function sanitizeAnswer(value) { return String(value || '').toUpperCase().replace(/[^A-Z]/g, ''); }
function cleanText(value)      { return String(value || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim(); }
function titleCase(value)      { return cleanText(value).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()); }
function clamp(n, min, max)    { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
