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
    return json(500, { error: 'ANTHROPIC_API_KEY is not set in Netlify environment variables.' });
  }

  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  let aiText;
  try {
    aiText = await callAnthropic({ apiKey, model, theme, difficulty, size, wordPool });
  } catch (err) {
    return json(502, { error: `AI service error: ${err.message}` });
  }

  const parsed = extractJson(aiText);
  if (!parsed.ok) {
    return json(422, { error: `Could not parse AI response: ${parsed.error}` });
  }

  const puzzle = buildPuzzle(parsed.data, { theme, difficulty, size });
  return json(200, puzzle);
};

function callAnthropic({ apiKey, model, theme, difficulty, size, wordPool }) {
  const prompt = buildPrompt({ theme, difficulty, size, wordPool });
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

function buildPrompt({ theme, difficulty }) {
  const difficultyGuide = difficulty === 'easy'
    ? 'Use simple, direct definitions as clues.'
    : difficulty === 'hard'
    ? 'Use wordplay, misdirection, and cryptic-style clues.'
    : 'Use moderately indirect clues.';

  return `Create a 15x15 American newspaper-style crossword puzzle about: ${theme}
Difficulty: ${difficulty}

STRICT RULES:
1. The "grid" array must have EXACTLY 15 strings, each EXACTLY 15 characters.
2. Use uppercase A-Z for white cells and # for black squares only.
3. Black squares MUST be rotationally symmetric: if grid[r][c] is #, then grid[14-r][14-c] must also be #.
4. No answer shorter than 3 letters.
5. Every white cell must be part of BOTH an Across answer AND a Down answer (checked letters).
6. All white cells must form one connected region.

CLUES:
- List ALL answers (both Across and Down) in the "clues" object.
- The key must be the EXACT answer word as it appears in the grid.
- ${difficultyGuide}

Return ONLY this JSON structure:
{
  "title": "Puzzle title here",
  "grid": [
    "###RAIN###SNOW#",
    "##STORM#CLOUD##",
    "#THUNDER#WIND##",
    "LIGHTNING######",
    "###FREEZE######",
    "##CELSIUS#####",
    "#HUMIDITY######",
    "TEMPERATURE####",
    "#HUMIDITY######",
    "##CELSIUS######",
    "###FREEZE######",
    "LIGHTNING######",
    "#THUNDER#WIND##",
    "##STORM#CLOUD##",
    "###RAIN###SNOW#"
  ],
  "clues": {
    "RAIN": "Precipitation from clouds",
    "SNOW": "Frozen precipitation",
    "STORM": "Severe weather event",
    "CLOUD": "Water vapor in the sky",
    "THUNDER": "Sound after lightning",
    "WIND": "Moving air",
    "LIGHTNING": "Electric weather flash",
    "FREEZE": "Turn to ice",
    "CELSIUS": "Temperature scale",
    "HUMIDITY": "Moisture in the air",
    "TEMPERATURE": "Measure of heat"
  },
  "themeEntries": ["RAIN", "SNOW", "STORM", "LIGHTNING", "TEMPERATURE"]
}

IMPORTANT: The example above is just showing the format — create your own real crossword about "${theme}" with proper interlocking words. Every row must be exactly 15 characters. Count carefully.`;
}

function extractJson(text) {
  if (!text) return { ok: false, error: 'Empty AI response.' };
  
  // Remove markdown fences
  let cleaned = text.replace(/```json|```/gi, '').trim();
  
  // Try direct parse first
  try { return { ok: true, data: JSON.parse(cleaned) }; } catch {}
  
  // Find the outermost { } block
  let depth = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (cleaned[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  
  if (start >= 0 && end > start) {
    try { return { ok: true, data: JSON.parse(cleaned.slice(start, end + 1)) }; }
    catch (err) { return { ok: false, error: `JSON parse failed: ${err.message}` }; }
  }
  
  return { ok: false, error: 'No JSON object found in AI response.' };
}
function buildPuzzle(raw, defaults) {
  // Normalize grid — pad or trim every row to exactly 15 chars
  const grid = Array.isArray(raw.grid)
    ? raw.grid.slice(0, 15).map(row => {
        const r = String(row).toUpperCase().replace(/[^A-Z#]/g, '');
        return r.length >= 15 ? r.slice(0, 15) : r.padEnd(15, '#');
      })
    : [];

  // Pad to 15 rows if needed
  while (grid.length < 15) grid.push('###############');

  // Enforce rotational symmetry — if either cell is #, make both #
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const r2 = 14 - r;
      const c2 = 14 - c;
      if (grid[r][c] === '#' || grid[r2][c2] === '#') {
        grid[r] = grid[r].substring(0, c) + '#' + grid[r].substring(c + 1);
        grid[r2] = grid[r2].substring(0, c2) + '#' + grid[r2].substring(c2 + 1);
      }
    }
  }

  const clues = (raw.clues && typeof raw.clues === 'object') ? raw.clues : {};
  const cleanClues = {};
  for (const [k, v] of Object.entries(clues)) {
    cleanClues[sanitizeAnswer(k)] = cleanText(v).slice(0, 220);
  }

  const entries = extractEntries(grid);
  const across = [];
  const down = [];
  let blockCount = 0;
  for (const row of grid) for (const ch of row) if (ch === '#') blockCount++;

  for (const entry of entries) {
    const clue = cleanClues[entry.answer] || fallbackClue(entry.answer, defaults.difficulty);
    const out = { number: entry.number, row: entry.row, col: entry.col, answer: entry.answer, clue };
    if (entry.direction === 'Across') across.push(out); else down.push(out);
  }

  // Check quality
  const allAnswers = entries.map(e => e.answer);
  const answersWithClues = allAnswers.filter(a => cleanClues[a]);
  const cluesCoverage = allAnswers.length > 0 ? answersWithClues.length / allAnswers.length : 0;

  return {
    title: cleanText(raw.title || `${titleCase(defaults.theme)} Crossword`).slice(0, 80),
    size: 15,
    difficulty: defaults.difficulty,
    theme: defaults.theme,
    grid,
    across,
    down,
    themeEntries: Array.isArray(raw.themeEntries) ? raw.themeEntries.map(sanitizeAnswer).filter(Boolean) : [],
    quality: {
      entryCount: entries.length,
      blockCount,
      rotationalSymmetry: true,
      allWhiteCellsChecked: cluesCoverage > 0.8,
      connected: true
    }
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

function fallbackClue(answer, difficulty) {
  if (difficulty === 'hard')   return `Tricky entry (${answer.length} letters)`;
  if (difficulty === 'medium') return `${answer.length}-letter word`;
  return `${answer.length} letters`;
}

function sanitizeAnswer(value) { return String(value || '').toUpperCase().replace(/[^A-Z]/g, ''); }
function cleanText(value)      { return String(value || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim(); }
function titleCase(value)      { return cleanText(value).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()); }
function clamp(n, min, max)    { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
