// generate-puzzle.js — AI Newspaper-Style Crossword Generator
// Improvements v2:
//   1. Stronger clue-quality prompt (bans anagram/scramble clues)
//   2. Five pre-built templates guaranteed to have zero unchecked cells
//      (every white cell is part of both an Across word AND a Down word)
//   3. Timeout mitigation: Haiku for Easy, Sonnet for Medium/Hard

const Anthropic = require("@anthropic-ai/sdk");

// ---------------------------------------------------------------------------
// GRID TEMPLATES — all verified: zero unchecked cells, 180° symmetry, min word ≥3
// '.' = white cell (to be filled), '#' = black square
// ---------------------------------------------------------------------------
const TEMPLATES = [
  // Template 0 — Open center, strong vertical stacks
  [
    "...............",
    "...............",
    "...............",
    "...#.......#...",
    "....#.....#....",
    "#.............#",
    "##...........##",
    "##....###....##",
    "##...........##",
    "#.............#",
    "....#.....#....",
    "...#.......#...",
    "...............",
    "...............",
    "...............",
  ],

  // Template 1 — Diagonal barrier feel
  [
    "...............",
    "...............",
    "...............",
    "...###...###...",
    "...............",
    "...............",
    "...............",
    "####.......####",
    "...............",
    "...............",
    "...............",
    "...###...###...",
    "...............",
    "...............",
    "...............",
  ],

  // Template 2 — Triple-column barriers
  [
    "...............",
    "...............",
    "...............",
    "...#.......#...",
    "...#.......#...",
    "...#.......#...",
    "...............",
    ".....#####.....",
    "...............",
    "...#.......#...",
    "...#.......#...",
    "...#.......#...",
    "...............",
    "...............",
    "...............",
  ],

  // Template 3 — Wide corner blocks
  [
    "...............",
    "...............",
    "...............",
    "#####.....#####",
    "...............",
    "...............",
    "...............",
    "...#.......#...",
    "...............",
    "...............",
    "...............",
    "#####.....#####",
    "...............",
    "...............",
    "...............",
  ],

  // Template 4 — Staggered barriers
  [
    "...............",
    "...............",
    "...............",
    "######...######",
    "...............",
    "...............",
    "...............",
    "......###......",
    "...............",
    "...............",
    "...............",
    "######...######",
    "...............",
    "...............",
    "...............",
  ],
];

// ---------------------------------------------------------------------------
// HELPER — parse the 15×15 grid template into word slots and cell numbers
// ---------------------------------------------------------------------------
function parseTemplate(template) {
  const grid = template.map((row) => row.split(""));
  const numbers = {};
  let cellNum = 1;
  const across = [];
  const down = [];

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (grid[r][c] === "#") continue;

      const startsAcross =
        (c === 0 || grid[r][c - 1] === "#") &&
        c + 1 < 15 &&
        grid[r][c + 1] !== "#";

      const startsDown =
        (r === 0 || grid[r - 1][c] === "#") &&
        r + 1 < 15 &&
        grid[r + 1][c] !== "#";

      if (startsAcross || startsDown) {
        numbers[`${r},${c}`] = cellNum;

        if (startsAcross) {
          let len = 0;
          while (c + len < 15 && grid[r][c + len] !== "#") len++;
          across.push({ row: r, col: c, len, number: cellNum });
        }

        if (startsDown) {
          let len = 0;
          while (r + len < 15 && grid[r + len][c] !== "#") len++;
          down.push({ row: r, col: c, len, number: cellNum });
        }

        cellNum++;
      }
    }
  }

  return { grid, numbers, across, down };
}

// ---------------------------------------------------------------------------
// HELPER — verify every white cell is checked (part of Across AND Down run ≥3)
// ---------------------------------------------------------------------------
function findUncheckedCells(template) {
  const grid = template.map((row) => row.split(""));
  const acrossCover = Array.from({ length: 15 }, () => Array(15).fill(false));
  const downCover = Array.from({ length: 15 }, () => Array(15).fill(false));

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (grid[r][c] === "#") continue;
      if (c === 0 || grid[r][c - 1] === "#") {
        let cc = c;
        while (cc < 15 && grid[r][cc] !== "#") { acrossCover[r][cc] = true; cc++; }
      }
      if (r === 0 || grid[r - 1][c] === "#") {
        let rr = r;
        while (rr < 15 && grid[rr][c] !== "#") { downCover[rr][c] = true; rr++; }
      }
    }
  }

  const unchecked = [];
  for (let r = 0; r < 15; r++)
    for (let c = 0; c < 15; c++)
      if (grid[r][c] !== "#" && !(acrossCover[r][c] && downCover[r][c]))
        unchecked.push([r, c]);
  return unchecked;
}

// ---------------------------------------------------------------------------
// HELPER — build the text slot description for the prompt
// ---------------------------------------------------------------------------
function buildSlotDescription(parsed) {
  const lines = ["ACROSS SLOTS:"];
  for (const s of parsed.across)
    lines.push(`  ${s.number}A  row ${s.row} col ${s.col}  length ${s.len}`);
  lines.push("DOWN SLOTS:");
  for (const s of parsed.down)
    lines.push(`  ${s.number}D  row ${s.row} col ${s.col}  length ${s.len}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// HELPER — render the template as a visual grid for the prompt
// ---------------------------------------------------------------------------
function renderTemplateForPrompt(template) {
  return template
    .map((row) => row.replace(/#/g, "█").replace(/\./g, "_"))
    .join("\n");
}

// ---------------------------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------------------------
exports.handler = async (event, context) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // ── Parse request ─────────────────────────────────────────────────────────
  let theme = "General Knowledge";
  let difficulty = "medium";
  let templateIndex = null;

  try {
    const body = JSON.parse(event.body || "{}");
    theme = body.theme || theme;
    difficulty = (body.difficulty || difficulty).toLowerCase();
    templateIndex = body.templateIndex ?? null;
  } catch (_) {}

  // ── Model: Haiku for Easy (faster), Sonnet for Medium/Hard ───────────────
  const model =
    difficulty === "easy" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";

  // ── Pick template ─────────────────────────────────────────────────────────
  const idx =
    templateIndex !== null
      ? Math.min(Math.max(0, templateIndex), TEMPLATES.length - 1)
      : Math.floor(Math.random() * TEMPLATES.length);
  const template = TEMPLATES[idx];
  const parsed = parseTemplate(template);
  const unchecked = findUncheckedCells(template);

  if (unchecked.length > 0) {
    console.warn(`Template ${idx} has ${unchecked.length} unchecked cells:`, unchecked);
  }

  // ── Build prompt pieces ────────────────────────────────────────────────────
  const slotDesc = buildSlotDescription(parsed);
  const visual = renderTemplateForPrompt(template);

  const difficultyInstruction = {
    easy: "Write EASY clues: straightforward definitions, common knowledge, simple fill-in-the-blank (\"___ of the crop\"). No wordplay.",
    medium: "Write MEDIUM clues: concise definitions with mild wordplay. Misdirection OK but keep it fair.",
    hard: "Write HARD clues: elegant misdirection, double meanings. Still fair — never impossible.",
  }[difficulty] || "Write medium-difficulty newspaper clues.";

  // ── System prompt ─────────────────────────────────────────────────────────
  const systemPrompt = `You are an expert American-style crossword constructor with 20 years of experience at major newspapers. You write clean, fair, creative clues and fill grids with real English words.

ABSOLUTE CLUE-WRITING RULES — any violation causes the puzzle to be rejected:
1. Every clue must be a real crossword clue that leads the solver to the answer.
2. NEVER write "anagram of X", "scrambled version of X", "letters of X rearranged", or any variant.
3. NEVER describe what letters are removed, added, or swapped.
4. NEVER reference the answer word directly in the clue.
5. NEVER write a clue that is just the answer spelled differently or partially hidden.
6. DO write: definitions, fill-in-the-blank, category clues, wordplay, famous-person/place clues.
7. Clues must be 3–12 words. Questions ("Where does the sun rise?") are fine.
8. For 3-letter answers: use the simplest real clue ("Feline", "___ Vegas", "Not odd").`;

  // ── User prompt ───────────────────────────────────────────────────────────
  const userPrompt = `Fill this 15×15 American-style crossword grid. Theme: "${theme}".
Difficulty: ${difficulty.toUpperCase()}. ${difficultyInstruction}

GRID (█ = black square, _ = white cell to fill):
${visual}

WORD SLOTS — fill each with a real English word of EXACTLY the given length:
${slotDesc}

CRITICAL RULES:
- Every answer must be a real English word or well-known proper noun.
- Words must interlock: if cell (row R, col C) is shared by an Across and a Down slot, both words must have the SAME letter at that position.
- No duplicate answers.
- No pure abbreviations unless you flag it in the clue (e.g. "Abbr.").
- Short 3-letter answers MUST be common words (CAT, ERA, ACE, OAK — NEVER random consonant clusters).

OUTPUT: respond with ONLY valid JSON, no markdown fences, no preamble:
{
  "templateIndex": ${idx},
  "theme": "${theme}",
  "answers": {
    "1A": "WORD",
    "2A": "WORD",
    "1D": "WORD",
    "2D": "WORD"
  },
  "clues": {
    "1A": "Clue text here",
    "2A": "Clue text here",
    "1D": "Clue text here",
    "2D": "Clue text here"
  }
}`;

  // ── Call Anthropic API ────────────────────────────────────────────────────
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let raw;
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    raw = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (err) {
    console.error("Anthropic API error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "AI generation failed", detail: err.message }),
    };
  }

  // ── Parse AI JSON response ────────────────────────────────────────────────
  let puzzleData;
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    puzzleData = JSON.parse(cleaned);
  } catch (err) {
    console.error("JSON parse error. Raw response:", raw);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Could not parse AI response as JSON", raw: raw.slice(0, 500) }),
    };
  }

  // ── Place answers into the grid and validate ──────────────────────────────
  const filledGrid = template.map((row) => row.split(""));
  const validationErrors = [];

  for (const slot of [...parsed.across, ...parsed.down]) {
    const dir = parsed.across.includes(slot) ? "A" : "D";
    const key = `${slot.number}${dir}`;
    const answer = (puzzleData.answers?.[key] || "").toUpperCase();

    if (!answer) { validationErrors.push(`Missing answer for ${key}`); continue; }
    if (answer.length !== slot.len) {
      validationErrors.push(`${key}: expected ${slot.len} letters, got "${answer}" (${answer.length})`);
      continue;
    }
    if (!/^[A-Z]+$/.test(answer)) {
      validationErrors.push(`${key}: "${answer}" contains non-letters`);
      continue;
    }

    for (let i = 0; i < slot.len; i++) {
      const r = dir === "A" ? slot.row : slot.row + i;
      const c = dir === "A" ? slot.col + i : slot.col;
      if (filledGrid[r][c] !== "." && filledGrid[r][c] !== answer[i]) {
        validationErrors.push(`Conflict at (${r},${c}): ${filledGrid[r][c]} vs ${answer[i]} [${key}]`);
      } else {
        filledGrid[r][c] = answer[i];
      }
    }
  }

  // ── Post-process clues: flag bad patterns ─────────────────────────────────
  const clueWarnings = [];
  const badPatterns = [/anagram/i, /scrambl/i, /rearrang/i, /letters?\s+of/i, /without\s+the/i, /minus\s+the/i];

  for (const [key, clue] of Object.entries(puzzleData.clues || {})) {
    for (const pat of badPatterns) {
      if (pat.test(clue)) {
        clueWarnings.push(`${key}: "${clue}"`);
        puzzleData.clues[key] = `[NEEDS EDIT] ${clue}`;
        break;
      }
    }
  }

  // ── Build response ────────────────────────────────────────────────────────
  const payload = {
    templateIndex: idx,
    theme,
    difficulty,
    model,
    template: filledGrid.map((row) => row.join("")),
    answers: puzzleData.answers || {},
    clues: puzzleData.clues || {},
    slots: { across: parsed.across, down: parsed.down },
    numbers: parsed.numbers,
    meta: { validationErrors, clueWarnings, uncheckedCells: unchecked },
  };

  if (validationErrors.length > 0) console.warn("Validation errors:", validationErrors);
  if (clueWarnings.length > 0) console.warn("Clue warnings:", clueWarnings);

  return { statusCode: 200, headers, body: JSON.stringify(payload) };
};
