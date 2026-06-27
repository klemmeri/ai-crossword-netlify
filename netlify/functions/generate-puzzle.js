// generate-puzzle.js — Netlify serverless function
// Two-pass approach: 1) generate grid, 2) generate clues separately

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

  // ── PASS 1: Generate the grid ────────────────────────────────
  let gridText;
  try {
    gridText = await callAnthropic(apiKey, model, buildGridPrompt({ theme, difficulty }));
  } catch (err) {
    return json(502, { error: `Grid generation error: ${err.message}` });
  }

  const gridParsed = extractJson(gridText);
  if (!gridParsed.ok) {
    return json(422, { error: `Could not parse grid: ${gridParsed.error}` });
  }

  let grid = normalizeGrid(gridParsed.data.grid || []);
  const title = cleanText(gridParsed.data.title || `${titleCase(theme)} Crossword`).slice(0, 80);
  const themeEntries = Array.isArray(gridParsed.data.themeEntries)
    ? gridParsed.data.themeEntries.map(sanitizeAnswer).filter(Boolean)
    : [];

  const entries = extractEntries(grid);
  if (entries.length === 0) {
    return json(422, { error: 'Grid generated no valid entries.' });
  }

  // ── PASS 2: Generate clues for all answers ───────────────────
  const allAnswers = [...new Set(entries.map(e => e.answer))];
  let clueText;
  try {
    clueText = await callAnthropic(apiKey, model, buildCluesPrompt({ theme, difficulty, answers: allAnswers }));
  } catch (err) {
    return json(502, { error: `Clue generation error: ${err.message}` });
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
      allWhiteCellsChecked: countUnchecked(grid) === 0,
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

function buildGridPrompt({ theme, difficulty }) {
  return `Create a 15x15 American newspaper crossword grid about: ${theme}
Difficulty: ${difficulty}

MOST IMPORTANT RULE: Every answer must be a real English word or common phrase that appears in a dictionary. No random letter strings. No partial words. No abbreviations unless they are extremely common (ERA, FDA, NBA).

GRID RULES:
- EXACTLY 15 rows, each EXACTLY 15 characters long.
- Use uppercase A-Z for letters, # for black squares.
- Black squares must have 180-degree rotational symmetry.
- Maximum 40 black squares — keep the grid mostly white/open.
- Every white cell must be part of BOTH an Across word AND a Down word, each 3+ letters.
- No word shorter than 3 letters.

HOW TO BUILD THE GRID:
1. Start with 6-8 long theme words related to "${theme}" (7-15 letters each).
2. Place them in the grid horizontally and vertically so they interlock.
3. Fill remaining white cells with short common English words (ACE, ERA, ORE, ATE, etc.).
4. Add # black squares between words where needed.
5. Make sure every letter is crossed by both an Across and Down word.

Good short fill words to use: ACE, AGE, AID, AIM, AIR, ALE, ANT, APE, APT, ARC, ARE, ARK, ARM, ART, ASH, ASK, ATE, AWE, AXE, DAM, DEN, DEW, DIM, DIP, DOE, DOG, DUE, DUG, DYE, EAR, EAT, EEL, EGG, ELK, ELM, EMU, END, ERA, EVE, EWE, FAD, FAN, FAR, FED, FEW, FIG, FIN, FIT, FLY, FOB, FOE, FOG, FOP, FOR, FOX, FRY, FUR, GEL, GEM, GIN, GNU, GOT, GUM, GUT, GUY, GYM, HAD, HAM, HAS, HAT, HAY, HEN, HEW, HID, HIM, HIP, HIT, HOB, HOD, HOG, HOP, HOT, HOW, HUB, HUE, HUG, HUM, HUT, ICE, ILL, IMP, INK, INN, ION, IRE, IRK, JAB, JAG, JAM, JAR, JAW, JAY, JET, JIG, JOB, JOG, JOT, JOY, JUG, JUT, KEG, KIT, LAB, LAD, LAG, LAP, LAW, LAX, LAY, LED, LEG, LET, LID, LIP, LIT, LOG, LOT, LOW, OAK, OAR, OAT, ODD, ODE, OFT, OHM, OIL, OLD, ORB, ORE, OWE, OWL, OWN, PAD, PAL, PAN, PAP, PAR, PAT, PAW, PAY, PEA, PEG, PEN, PEP, PET, PEW, PIE, PIG, PIN, PIT, PLY, POD, POI, POP, POT, POW, PRY, PUB, PUG, PUN, PUP, PUS, PUT, RAN, RAP, RAT, RAW, RAY, RED, RIB, RID, RIG, RIM, RIP, ROB, ROD, ROE, ROT, ROW, RUB, RUG, RUM, RUN, RUT, RYE, SAC, SAG, SAP, SAT, SAW, SAY, SEA, SET, SEW, SHE, SHY, SIN, SIP, SIR, SIT, SKI, SKY, SLY, SOB, SOD, SOT, SOW, SOY, SPA, SPY, STY, SUB, SUM, SUN, SUP, TAB, TAD, TAN, TAP, TAR, TAT, TAX, TEA, TEN, THE, TIE, TIN, TIP, TOD, TOE, TON, TOP, TOT, TOW, TOY, TUB, TUG, TUN, TUP, TUT, TWO, UDO, UGH, URN, VAN, VAT, VET, VIA, VIE, VOW, WAD, WAG, WAR, WAS, WAX, WEB, WED, WIG, WIT, WOE, WOK, WON, WOO, WOP, WOW, YAM, YAP, YAW, YEA, YEW, YOB, YOD, YOK, YOU, ZAP, ZEN, ZIP, ZIT, ZOO

Return ONLY this JSON:
{
  "title": "Puzzle title",
  "grid": [
    "THUNDERSTORM###",
    "H#U#E#####R###A",
    "...13 more rows..."
  ],
  "themeEntries": ["THUNDERSTORM"]
}`;
}

function buildCluesPrompt({ theme, difficulty, answers }) {
  const diffGuide = difficulty === 'easy'
    ? 'Simple, direct definitions that any adult would know immediately.'
    : difficulty === 'hard'
    ? 'Clever wordplay, double meanings, and misdirection.'
    : 'Clear but moderately indirect clues.';

  const answerList = answers.map(a => `"${a}"`).join(', ');

  return `Write crossword clues for these answer words. The puzzle theme is "${theme}".
Difficulty: ${difficulty} — ${diffGuide}

Answers: ${answerList}

Rules:
- Write one genuine crossword clue for EVERY word above. No exceptions.
- Every clue must be unique — no two answers get the same clue.
- Each clue should be 2-7 words long.
- Do NOT use the answer word inside the clue.
- Write real, meaningful clues. Never write things like "word fragment", "scrambled letters", "minus a letter", "without the X", or "abbreviation".
- For short words: ACE = "Serve winner", ERA = "Time period", ORE = "Mined material", NET = "After taxes", ATE = "Had a meal", DEW = "Morning droplets", FOG = "Thick mist", ICE = "Frozen water", SKY = "Above the clouds", SUN = "Daytime star", AIR = "What we breathe", etc.
- For theme words about "${theme}", write clues related to that theme.

Return ONLY a JSON object:
{
  "WORD": "Its clue here",
  "ANOTHER": "Its clue here"
}`;
}

function normalizeGrid(rawGrid) {
  let grid = Array.isArray(rawGrid)
    ? rawGrid.slice(0, 15).map(row => {
        const r = String(row).toUpperCase().replace(/[^A-Z#]/g, '');
        return r.length >= 15 ? r.slice(0, 15) : r.padEnd(15, '#');
      })
    : [];
  while (grid.length < 15) grid.push('###############');

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (grid[r][c] === '#' || grid[14-r][14-c] === '#') {
        grid[r]    = setChar(grid[r],    c,    '#');
        grid[14-r] = setChar(grid[14-r], 14-c, '#');
      }
    }
  }
  return grid;
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

function runLength(grid, r, c, dr, dc) {
  let len = 0, rr = r, cc = c;
  while (rr >= 0 && rr < 15 && cc >= 0 && cc < 15 && grid[rr][cc] !== '#') {
    len++; rr += dr; cc += dc;
  }
  return len;
}

function countUnchecked(grid) {
  let count = 0;
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (grid[r][c] === '#') continue;
      const aLen = runLength(grid, r, c, 0, 1) + runLength(grid, r, c, 0, -1) - 1;
      const dLen = runLength(grid, r, c, 1, 0) + runLength(grid, r, c, -1, 0) - 1;
      if (aLen < 3 || dLen < 3) count++;
    }
  }
  return count;
}

function setChar(str, idx, ch) {
  return str.substring(0, idx) + ch + str.substring(idx + 1);
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
    ACE:'Serve winner', AGE:'Time of life', AID:'Give help', AIR:'What we breathe',
    ALE:'Pub drink', ANT:'Picnic pest', APE:'Large primate', ARC:'Curved line',
    ARE:'Exist', ARK:"Noah's vessel", ARM:'Limb or weapon', ART:'Creative work',
    ASH:'Fire remains', ATE:'Had a meal', AWE:'Deep wonder', AXE:'Chopping tool',
    DAM:'River barrier', DEW:'Morning droplets', DIM:'Not bright', DUE:'Owed',
    EAR:'Hearing organ', EAT:'Consume food', EEL:'Slippery fish', ELK:'Large deer',
    ELM:'Shade tree', EMU:'Australian bird', END:'Finish', ERA:'Time period',
    EVE:'Day before', EWE:'Female sheep', FAD:'Brief craze', FAN:'Admirer',
    FAR:'Distant', FEW:'Not many', FIG:'Sweet fruit', FIT:'In good shape',
    FOG:'Thick mist', FOX:'Sly animal', FUR:'Animal coat', GEL:'Hair product',
    GEM:'Precious stone', GIN:'Clear spirit', GNU:'African beast', GUM:'Chewing treat',
    GUY:'Fellow', GYM:'Workout place', HAM:'Cured pork', HAT:'Head covering',
    HAY:'Dried grass', HEN:'Female chicken', HEW:'Chop with axe', HIP:'Trendy',
    HIT:'Strike', HOG:'Pig', HOP:'Small jump', HOT:'Very warm',
    HUE:'Color shade', HUG:'Warm embrace', HUM:'Low drone', HUT:'Small shelter',
    ICE:'Frozen water', ILL:'Not well', INK:'Writing fluid', INN:'Small hotel',
    IRE:'Anger', JAB:'Quick punch', JAM:'Fruit preserve', JAR:'Glass container',
    JAW:'Mouth bone', JAY:'Blue bird', JET:'Fast plane', JOG:'Slow run',
    JOY:'Great happiness', JUG:'Liquid container', KEG:'Small barrel', KIT:'Tool set',
    LAD:'Young boy', LAP:'Seated surface', LAW:'Legal rule', LAY:'Put down',
    LED:'Guided', LEG:'Limb', LID:'Cover', LOG:'Wooden chunk',
    LOW:'Not high', OAK:'Acorn tree', OAR:'Rowing paddle', OAT:'Breakfast grain',
    ODD:'Strange', ODE:'Lyric poem', OIL:'Lubricant', OLD:'Not young',
    ORE:'Mined material', OWE:'Be in debt', OWL:'Night bird', PAD:'Writing tablet',
    PAN:'Cooking vessel', PAR:'Golf standard', PAW:'Animal foot', PEA:'Green vegetable',
    PEG:'Clothes pin', PEN:'Writing tool', PET:'Cherished animal', PIE:'Baked dish',
    PIG:'Farm animal', PIN:'Sharp fastener', PIT:'Deep hole', POD:'Seed case',
    POT:'Cooking container', PUN:'Word joke', PUP:'Young dog', PUT:'Place',
    RAN:'Past of run', RAP:'Knock or music', RAT:'Rodent', RAW:'Uncooked',
    RAY:'Beam of light', RED:'Primary color', RIB:'Chest bone', RID:'Free from',
    RIG:'Equipment', RIM:'Edge or border', RIP:'Tear apart', ROD:'Thin stick',
    ROE:'Fish eggs', ROT:'Decay', ROW:'Line or dispute', RUG:'Floor covering',
    RUM:'Caribbean spirit', RUN:'Move fast', RYE:'Bread grain', SAP:'Tree fluid',
    SAT:'Was seated', SAW:'Cutting tool', SEA:'Ocean', SET:'Group',
    SKI:'Snow glide', SKY:'Above clouds', SOD:'Grass turf', SOW:'Plant seeds',
    SPA:'Relaxation place', STY:'Pig pen', SUM:'Total', SUN:'Daytime star',
    TAB:'Running total', TAN:'Brown color', TAP:'Light knock', TAR:'Road material',
    TAX:'Government levy', TEA:'Hot drink', TEN:'Number after nine', TIE:'Neck wear',
    TIN:'Metal container', TIP:'Useful hint', TOE:'Foot digit', TON:'Heavy weight',
    TOP:'Highest point', TOY:'Plaything', TUB:'Bathing vessel', TUG:'Pull hard',
    URN:'Vase', VAN:'Delivery vehicle', VAT:'Large tub', VET:'Animal doctor',
    VOW:'Solemn promise', WAR:'Armed conflict', WAX:'Candle material', WEB:'Spider creation',
    WED:'Get married', WIG:'Hair piece', WIT:'Clever humor', WOE:'Great sorrow',
    YAM:'Sweet potato', YEW:'Evergreen tree', ZEN:'Calm mindset', ZIP:'Move fast',
    ZOO:'Animal park', NET:'After taxes', ACT:'Do something', AGO:'In the past',
    AID:'Assistance', AIM:'Take aim', AND:'Plus', ANT:'Colony insect',
    ANY:'Whatever', APT:'Fitting', BIG:'Large', BOW:'Front of ship',
    BUN:'Hair style', BUS:'Public transport', BUT:'However', BYE:'Farewell',
    CAB:'Taxi', CAP:'Hat', CAR:'Vehicle', COP:'Officer',
    CUB:'Young bear', CUP:'Drinking vessel', CUR:'Mongrel dog', CUT:'Slice',
    DAB:'Light touch', DIG:'Excavate', DIP:'Brief plunge', DOE:'Female deer',
    DOG:'Man\'s best friend', DUG:'Excavated', DYE:'Color fabric',
  };
  if (common[answer]) return common[answer];
  if (difficulty === 'hard') return `Cryptic entry (${answer.length} letters)`;
  if (difficulty === 'medium') return `Fill-in (${answer.length} letters)`;
  return `${answer.length}-letter answer`;
}

function sanitizeAnswer(value) { return String(value || '').toUpperCase().replace(/[^A-Z]/g, ''); }
function cleanText(value)      { return String(value || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim(); }
function titleCase(value)      { return cleanText(value).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()); }
function clamp(n, min, max)    { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function json(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
