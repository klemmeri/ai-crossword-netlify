const OPENAI_URL = 'https://api.openai.com/v1/responses';

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

  const theme = cleanText(body.theme || '').slice(0, 180);
  const difficulty = ['easy', 'medium', 'hard'].includes(body.difficulty) ? body.difficulty : 'medium';
  const size = Number(body.size || 15);
  const wordPool = clamp(Number(body.wordPool || 80), 40, 120);

  if (!theme) return json(400, { error: 'Theme is required.' });
  if (size !== 15) return json(400, { error: 'This prototype currently supports 15x15 puzzles only.' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(500, {
      error: 'OPENAI_API_KEY is not set in Netlify environment variables. Add it in Netlify: Site configuration -> Environment variables.'
    });
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  let lastError = 'Unknown validation failure.';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildPrompt({ theme, difficulty, size, wordPool, attempt, lastError });
    const ai = await callOpenAI({ apiKey, model, prompt });
    const parsed = extractJson(ai);
    if (!parsed.ok) {
      lastError = parsed.error;
      continue;
    }

    const normalized = normalizePuzzle(parsed.data, { theme, difficulty, size });
    const validation = validatePuzzle(normalized);
    if (validation.ok) {
      const completed = finalizePuzzle(normalized, validation.entries);
      return json(200, completed);
    }
    lastError = validation.errors.join('; ');
  }

  return json(422, {
    error: `The AI did not return a valid 15x15 newspaper-style grid after correction attempts. Validation issue: ${lastError}`
  });
};

function buildPrompt({ theme, difficulty, size, wordPool, attempt, lastError }) {
  const correction = attempt > 1 ? `\nYour previous grid failed validation: ${lastError}\nReturn a corrected puzzle only.` : '';
  return `You are a professional American crossword constructor. Create a valid ${size}x${size} newspaper-style crossword puzzle.

Theme or genre: ${theme}
Difficulty: ${difficulty}
AI theme candidate pool target: ${wordPool}

Mandatory grid rules:
- Return exactly ${size} grid rows.
- Each row must contain exactly ${size} characters.
- Use uppercase A-Z letters and # for black squares only.
- Black squares must have 180-degree rotational symmetry.
- Every answer must be at least 3 letters long.
- Every white cell must be checked: it must belong to both an Across answer of length at least 3 and a Down answer of length at least 3.
- The white cells must form one connected component.
- Do not use isolated white regions.
- Use 3 to 5 theme-related entries when possible.
- Avoid obscure abbreviations, partials, unchecked names, or junk fill.

Clue rules:
- Provide clues for every Across and Down answer in the grid.
- Easy clues should be direct. Medium clues may be moderately indirect. Hard clues may use more wordplay or specialized knowledge.
- Do not reveal answer text inside the clue unless unavoidable.

Return JSON only, with this exact shape:
{
  "title": "string",
  "grid": ["15 chars", "15 chars", "..."],
  "clues": {
    "ANSWER": "clue text"
  },
  "themeEntries": ["ANSWER", "ANSWER"]
}

Important: The app will renumber entries itself from the grid, so the clue keys must be the raw answers without spaces or punctuation.${correction}`;
}

async function callOpenAI({ apiKey, model, prompt }) {
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.7,
      max_output_tokens: 5000,
      text: { format: { type: 'json_object' } }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || `OpenAI request failed with status ${response.status}.`;
    throw new Error(detail);
  }
  if (typeof data.output_text === 'string') return data.output_text;
  const pieces = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') pieces.push(content.text);
    }
  }
  return pieces.join('\n');
}

function extractJson(text) {
  if (!text) return { ok: false, error: 'Empty AI response.' };
  try { return { ok: true, data: JSON.parse(text) }; } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return { ok: true, data: JSON.parse(text.slice(start, end + 1)) }; } catch (err) {
      return { ok: false, error: `JSON parse failed: ${err.message}` };
    }
  }
  return { ok: false, error: 'No JSON object found in AI response.' };
}

function normalizePuzzle(raw, defaults) {
  const grid = Array.isArray(raw.grid) ? raw.grid.map(row => String(row).toUpperCase().replace(/[^A-Z#]/g, '').slice(0, defaults.size)) : [];
  const clues = raw.clues && typeof raw.clues === 'object' ? raw.clues : {};
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
  if (!Array.isArray(puzzle.grid) || puzzle.grid.length !== n) errors.push(`Grid must contain ${n} rows.`);
  for (const [i, row] of (puzzle.grid || []).entries()) {
    if (row.length !== n) errors.push(`Row ${i + 1} must contain ${n} characters.`);
    if (/[^A-Z#]/.test(row)) errors.push(`Row ${i + 1} contains invalid characters.`);
  }
  if (errors.length) return { ok: false, errors };

  let blockCount = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const a = puzzle.grid[r][c];
      const b = puzzle.grid[n - 1 - r][n - 1 - c];
      if (a === '#') blockCount++;
      if ((a === '#') !== (b === '#')) errors.push(`Black-square symmetry fails at row ${r + 1}, col ${c + 1}.`);
    }
  }

  const entries = extractEntries(puzzle.grid);
  for (const entry of entries) {
    if (entry.answer.length < 3) errors.push(`${entry.direction} ${entry.number} is shorter than 3 letters.`);
  }

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (puzzle.grid[r][c] === '#') continue;
      const acrossLen = lengthInDirection(puzzle.grid, r, c, 0, -1, 0, 1);
      const downLen = lengthInDirection(puzzle.grid, r, c, -1, 0, 1, 0);
      if (acrossLen < 3 || downLen < 3) errors.push(`Unchecked or short-crossed cell at row ${r + 1}, col ${c + 1}.`);
    }
  }

  if (!isConnected(puzzle.grid)) errors.push('White cells are not all connected.');
  const duplicateAnswers = findDuplicates(entries.map(e => e.answer));
  if (duplicateAnswers.length) errors.push(`Duplicate answers: ${duplicateAnswers.join(', ')}.`);

  const answerCount = entries.length;
  const quality = {
    entryCount: answerCount,
    blockCount,
    rotationalSymmetry: !errors.some(e => e.includes('symmetry')),
    allWhiteCellsChecked: !errors.some(e => e.includes('Unchecked') || e.includes('shorter')),
    connected: !errors.some(e => e.includes('connected'))
  };

  return { ok: errors.length === 0, errors, entries, quality };
}

function finalizePuzzle(puzzle, entries) {
  const across = [];
  const down = [];
  for (const entry of entries) {
    const clue = puzzle.clues[entry.answer] || fallbackClue(entry.answer, puzzle.difficulty);
    const out = { number: entry.number, row: entry.row, col: entry.col, answer: entry.answer, clue };
    if (entry.direction === 'Across') across.push(out); else down.push(out);
  }
  const q = validatePuzzle(puzzle);
  return {
    title: puzzle.title,
    size: puzzle.size,
    difficulty: puzzle.difficulty,
    theme: puzzle.theme,
    grid: puzzle.grid,
    across,
    down,
    themeEntries: puzzle.themeEntries,
    quality: q.quality || {}
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
      const startsAcross = (c === 0 || grid[r][c - 1] === '#') && c + 2 < n && grid[r][c + 1] !== '#' && grid[r][c + 2] !== '#';
      const startsDown = (r === 0 || grid[r - 1][c] === '#') && r + 2 < n && grid[r + 1][c] !== '#' && grid[r + 2][c] !== '#';
      if (startsAcross || startsDown) starts.push({ r, c, number: number++ });
    }
  }
  for (const s of starts) {
    if (s.c === 0 || grid[s.r][s.c - 1] === '#') {
      let ans = '', c = s.c;
      while (c < n && grid[s.r][c] !== '#') ans += grid[s.r][c++];
      if (ans.length >= 3) entries.push({ number: s.number, direction: 'Across', row: s.r, col: s.c, answer: ans });
    }
    if (s.r === 0 || grid[s.r - 1][s.c] === '#') {
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
  let start = null;
  let whiteCount = 0;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (grid[r][c] !== '#') { whiteCount++; if (!start) start = [r, c]; }
  if (!start) return false;
  const seen = new Set([start.join(',')]);
  const q = [start];
  while (q.length) {
    const [r, c] = q.shift();
    for (const [dr, dc] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nr = r + dr, nc = c + dc;
      const key = `${nr},${nc}`;
      if (nr < 0 || nr >= n || nc < 0 || nc >= n || grid[nr][nc] === '#' || seen.has(key)) continue;
      seen.add(key); q.push([nr, nc]);
    }
  }
  return seen.size === whiteCount;
}

function fallbackClue(answer, difficulty) {
  if (difficulty === 'hard') return `Entry clued by the constructor (${answer.length})`;
  if (difficulty === 'medium') return `${answer.length}-letter crossword entry`;
  return `${answer.length} letters`;
}

function findDuplicates(items) {
  const seen = new Set();
  const dupes = new Set();
  for (const x of items) seen.has(x) ? dupes.add(x) : seen.add(x);
  return [...dupes];
}
function sanitizeAnswer(value) { return String(value || '').toUpperCase().replace(/[^A-Z]/g, ''); }
function cleanText(value) { return String(value || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim(); }
function titleCase(value) { return cleanText(value).replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, Number.isFinite(n) ? n : min)); }
function json(statusCode, body) { return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }
