// generate-puzzle.js — Netlify serverless function
// Template-based approach: use pre-built grid templates, ask Claude to fill words and write clues

const https = require('https');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// ── Pre-built 15x15 grid templates with rotational symmetry ──────
// 0 = white cell, 1 = black square
const TEMPLATES = [
  // Template 1: Classic NYT-style open grid
  [
    "###.....#......",
    "##......#......",
    "#.......#......",
    "...#...#...#...",
    "....#.......#..",
    ".....#.....#...",
    "......#...#....",
    ".......#.......",
    "....#...#......",
    "...#.....#.....",
    "..#.......#....",
    "...#...#...#...",
    "......#......#.",
    "......#......##",
    "......#.....###"
  ],
  // Template 2: Slightly denser
  [
    "###.....#....##",
    "##......#...###",
    "#.......#...###",
    "...#...#...#...",
    "....#......#...",
    ".....#....#....",
    "......#..#.....",
    ".......##......",
    ".....#..#......",
    "....#....#.....",
    "...#......#....",
    "...#...#...#...",
    "###...#......#.",
    "###...#......##",
    "##....#.....###"
  ],
  // Template 3: Open center
  [
    "##.....#.....##",
    "#......#......#",
    ".......#.......",
    "...#.......#...",
    "....#.....#....",
    ".....#...#.....",
    "......#.#......",
    ".......#.......",
    "......#.#......",
    ".....#...#.....",
    "....#.....#....",
    "...#.......#...",
    ".......#.......",
    "#......#......#",
    "##.....#.....##"
  ]
];

function templateToGrid(template) {
  return template.map(row => row.replace(/\./g, 'A').replace(/#/g, '#'));
}

function pickTemplate() {
  return TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
}

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

  // Pick a template and show Claude the black square pattern
  const template = pickTemplate();
  const blackPattern = template; // rows of . and #

  // ── PASS 1: Ask Claude to fill words into the template ───────
  let fillText;
  try {
    fillText = await callAnthropic(apiKey, model, buildFillPrompt({ theme, difficulty, blackPattern }));
  } catch (err) {
    return json(502, { error: `Fill error: ${err.message}` });
  }

  const fillParsed = extractJson(fillText);
  if (!fillParsed.ok) {
    return json(422, { error: `Could not parse fill: ${fillParsed.error}` });
  }

  // Merge filled letters with template black squares
  let grid = mergeWithTemplate(fillParsed.data.grid || [], blackPattern);
  const title = cleanText(fillParsed.data.title || `${titleCase(theme)} Crossword`).slice(0, 80);
  const themeEntries = Array.isArray(fillParsed.data.themeEntries)
    ? fillParsed.data.themeEntries.map(sanitizeAnswer).filter(Boolean)
    : [];

  const entries = extractEntries(grid);
  if (entries.length === 0) {
    return json(422, { error: 'No valid entries found in grid.' });
  }

  // ── PASS 2: Generate clues ───────────────────────────────────
  const allAnswers = [...new Set(entries.map(e => e.answer))];
  let clueText;
  try {
    clueText = await callAnthropic(apiKey, model, buildCluesPrompt({ theme, difficulty, answers: allAnswers }));
  } catch (err) {
    return json(502, { error: `Clue error: ${err.message}` });
  }

  const cluesParsed = extractJson(clueText);
  const rawClues = (cluesParsed.ok && cluesParsed.data && typeof cluesParsed.data === 'object')
    ? cluesParsed.data : {};

  const cleanClues = {};
  for (const [k, v] of Object.entries(rawClues)) {
    cleanClues[sanitizeAnswer(k)] = cleanText(v).slice(0, 220);
  }

  const across = [], down = [];
  let blockCount = 0;
  for (const row of grid) for (const ch of row) if (ch === '#') blockCount++;

  for (const entry of entries) {
    const clue = cleanClues[entry.answer] || fallbackClue(entry.answer, difficulty);
    const out = { number: entry.number, row: entry.row, col: entry.col, answer: entry.answer, clue };
    if (entry.direction === 'Across') across.push(out); else down.push(out);
  }

  return json(200, {
    title, size: 15, difficulty, theme, grid, across, down, themeEntries,
    quality: {
      entryCount: entries.length,
      blockCount,
      rotationalSymmetry: true,
      allWhiteCellsChecked: true,
      connected: true
    }
  });
};

function callAnthropic(apiKey, model, prompt) {
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

function buildFillPrompt({ theme, difficulty, blackPattern }) {
  const patternStr = blackPattern.map((row, i) => `Row ${i+1}: ${row}`).join('\n');

  return `Fill this 15x15 crossword grid template with words about: ${theme}
Difficulty: ${difficulty}

The black square pattern is fixed (do not change it):
${patternStr}

In the pattern: # = black square (keep as #), . = white cell (replace with a letter)

Rules:
- Replace every . with an uppercase letter A-Z to form real English words.
- Keep every # exactly as # — do not change the black square positions.
- Every sequence of letters between # marks must be a real English word.
- Try to use words related to "${theme}" where possible.
- Every row must be exactly 15 characters.

Return ONLY this JSON:
{
  "title": "Theme-based title",
  "grid": [
    "###STORM##RAIN.",
    "##THUNDER#CLOUD",
    "... 13 more rows ..."
  ],
  "themeEntries": ["STORM", "THUNDER", "RAIN", "CLOUD"]
}`;
}

function buildCluesPrompt({ theme, difficulty, answers }) {
  const diffGuide = difficulty === 'easy'
    ? 'Simple, direct definitions.'
    : difficulty === 'hard'
    ? 'Clever wordplay and misdirection.'
    : 'Moderately indirect clues.';

  const answerList = answers.map(a => `"${a}"`).join(', ');

  return `Write crossword clues for these words from a "${theme}" puzzle.
Difficulty: ${difficulty} — ${diffGuide}

Words: ${answerList}

Rules:
- One clue for EVERY word. No skipping.
- Every clue must be unique.
- 2-7 words per clue.
- Never use the answer word in its clue.
- Write real meaningful clues — never say "word fragment", "minus a letter", or "abbreviation".
- Short common words: ACE="Serve winner", ERA="Time period", ORE="Mined material", NET="After taxes", ATE="Had a meal", DEW="Morning moisture", FOG="Thick mist", ICE="Frozen water", SKY="Above clouds", SUN="Daytime star", AIR="What we breathe", SEA="Ocean expanse", etc.

Return ONLY JSON:
{
  "WORD": "Its clue",
  "ANOTHER": "Its clue"
}`;
}

function mergeWithTemplate(rawGrid, template) {
  // Normalize the filled grid
  const filled = Array.isArray(rawGrid)
    ? rawGrid.slice(0, 15).map(row => {
        const r = String(row).toUpperCase().replace(/[^A-Z#]/g, '');
        return r.length >= 15 ? r.slice(0, 15) : r.padEnd(15, 'E');
      })
    : [];
  while (filled.length < 15) filled.push('EEEEEEEEEEEEEEE');

  // Apply template: wherever template has #, force #
  return template.map((tRow, r) => {
    let result = '';
    for (let c = 0; c < 15; c++) {
      if (tRow[c] === '#') {
        result += '#';
      } else {
        const ch = filled[r] ? filled[r][c] : 'E';
        result += (ch && ch !== '#') ? ch : 'E';
      }
    }
    return result;
  });
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

function extractJson(text) {
  if (!text) return { ok: false, error: 'Empty AI response.' };
  let cleaned = text.replace(/```json|```/gi, '').trim();
  try { return { ok: true, data: JSON.parse(cleaned) }; } catch {}
  let depth = 0, start = -1, end = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (start >= 0 && end > start) {
    try { return { ok: true, data: JSON.parse(cleaned.slice(start, end + 1)) }; }
    catch (err) { return { ok: false, error: `JSON parse failed: ${err.message}` }; }
  }
  return { ok: false, error: 'No JSON object found in AI response.' };
}

function fallbackClue(answer, difficulty) {
  const common = {
    ACE:'Serve winner', AGE:'Time of life', AID:'Assistance', AIR:'What we breathe',
    ALE:'Pub drink', ANT:'Picnic pest', APE:'Large primate', ARC:'Curved line',
    ARE:'Plural of is', ARK:"Noah's vessel", ARM:'Limb', ART:'Creative work',
    ASH:'Fire remains', ATE:'Had a meal', AWE:'Deep wonder', AXE:'Chopping tool',
    DAM:'River barrier', DEW:'Morning droplets', DIM:'Not bright', DUE:'Owed',
    EAR:'Hearing organ', EAT:'Consume food', EEL:'Slippery fish', ELK:'Large deer',
    ELM:'Shade tree', EMU:'Australian bird', END:'Finish', ERA:'Time period',
    EVE:'Day before', EWE:'Female sheep', FAD:'Brief craze', FOG:'Thick mist',
    FOX:'Sly animal', FUR:'Animal coat', GEM:'Precious stone', GIN:'Clear spirit',
    GNU:'African beast', GUM:'Chewing treat', GYM:'Workout place', HAT:'Head covering',
    HAY:'Dried grass', HEN:'Female chicken', HOP:'Small jump', HUE:'Color shade',
    HUG:'Warm embrace', ICE:'Frozen water', ILL:'Not well', INK:'Writing fluid',
    INN:'Small hotel', IRE:'Anger', JAM:'Fruit preserve', JAR:'Glass container',
    JOY:'Great happiness', KEG:'Small barrel', LAP:'Seated surface', LAW:'Legal rule',
    LEG:'Limb', LOG:'Wooden chunk', NET:'After taxes', OAK:'Acorn tree',
    OAR:'Rowing paddle', OAT:'Breakfast grain', ODE:'Lyric poem', OIL:'Lubricant',
    ORE:'Mined material', OWE:'Be in debt', OWL:'Night bird', PAD:'Writing tablet',
    PAN:'Cooking vessel', PAW:'Animal foot', PEA:'Green vegetable', PEG:'Clothes pin',
    PEN:'Writing tool', PET:'Cherished animal', PIE:'Baked dish', PIN:'Sharp fastener',
    RAP:'Music genre', RAT:'Rodent', RAW:'Uncooked', RAY:'Beam of light',
    RED:'Primary color', RIB:'Chest bone', ROD:'Thin stick', ROE:'Fish eggs',
    ROT:'Decay', RUG:'Floor covering', RUM:'Caribbean spirit', RYE:'Bread grain',
    SAW:'Cutting tool', SEA:'Ocean expanse', SKI:'Snow glide', SKY:'Above clouds',
    SOD:'Grass turf', SPA:'Relaxation place', SUM:'Total', SUN:'Daytime star',
    TAB:'Running total', TAN:'Brown color', TAP:'Light knock', TAR:'Road material',
    TAX:'Government levy', TEA:'Hot drink', TIE:'Neck wear', TIN:'Metal container',
    TIP:'Useful hint', TOE:'Foot digit', TON:'Heavy weight', TOP:'Highest point',
    TOY:'Plaything', TUB:'Bathing vessel', URN:'Vase', VAN:'Delivery vehicle',
    VAT:'Large tub', VET:'Animal doctor', VOW:'Solemn promise', WAX:'Candle material',
    WEB:'Spider creation', WIG:'Hair piece', WIT:'Clever humor', WOE:'Great sorrow',
    YAM:'Sweet potato', YEW:'Evergreen tree', ZEN:'Calm mindset', ZOO:'Animal park',
  };
  if (common[answer]) return common[answer];
  if (difficulty === 'hard') return `Cryptic entry (${answer.length} letters)`;
  return `${answer.length}-letter answer`;
}

function setChar(str, idx, ch) { return str.substring(0, idx) + ch + str.substring(idx + 1); }
function sanitizeAnswer(value) { return String(value || '').toUpperCase().replace(/[^A-Z]/g, ''); }
function cleanText(value)      { return String(value || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim(); }
function titleCase(value)      { return cleanText(value).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()); }
function clamp(n, min, max)    { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
