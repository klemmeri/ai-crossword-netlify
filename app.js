const state = {
  difficulty: 'easy',
  puzzle: null,
  activeInput: null
};

const $ = (id) => document.getElementById(id);

for (const btn of document.querySelectorAll('.pill')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    state.difficulty = btn.dataset.difficulty;
  });
}

$('generate').addEventListener('click', generatePuzzle);
$('check').addEventListener('click', checkPuzzle);
$('revealLetter').addEventListener('click', revealLetter);
$('revealPuzzle').addEventListener('click', revealPuzzle);
$('print').addEventListener('click', () => window.print());

async function generatePuzzle() {
  const theme = $('theme').value.trim();
  const size = Number($('size').value);
  const wordPool = Number($('wordPool').value);
  if (!theme) {
    setStatus('Enter a theme or genre first.');
    return;
  }

  setBusy(true);
  setStatus('Constructing a crossword. If the AI returns an invalid grid, the server will request a corrected version.');

  try {
    const res = await fetch('/.netlify/functions/generate-puzzle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme, difficulty: state.difficulty, size, wordPool })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Puzzle generation failed.');
    state.puzzle = data;
    renderPuzzle(data);
    setStatus('Puzzle generated.');
  } catch (err) {
    setStatus(err.message);
  } finally {
    setBusy(false);
  }
}

function renderPuzzle(puzzle) {
  $('result').classList.remove('hidden');
  $('puzzle-title').textContent = puzzle.title || 'Untitled Crossword';
  renderQuality(puzzle);
  renderGrid(puzzle);
  renderClues(puzzle);
}

function renderQuality(puzzle) {
  const q = puzzle.quality || {};
  const facts = [
    `Size: ${puzzle.size || 15}×${puzzle.size || 15}`,
    `Entries: ${q.entryCount ?? 'n/a'}`,
    `Blocks: ${q.blockCount ?? 'n/a'}`,
    `Symmetry: ${q.rotationalSymmetry ? 'yes' : 'no'}`,
    `Checked: ${q.allWhiteCellsChecked ? 'yes' : 'review'}`
  ];
  $('quality').innerHTML = facts.map(x => `<span class="badge">${escapeHtml(x)}</span>`).join('');
}

function renderGrid(puzzle) {
  const gridEl = $('grid');
  gridEl.innerHTML = '';
  const size = puzzle.size || 15;
  gridEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
  const numbers = new Map();
  for (const entry of [...(puzzle.across || []), ...(puzzle.down || [])]) {
    numbers.set(`${entry.row},${entry.col}`, entry.number);
  }

  puzzle.grid.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      const cell = document.createElement('div');
      cell.className = ch === '#' ? 'cell black' : 'cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      if (ch !== '#') {
        const n = numbers.get(`${r},${c}`);
        if (n) {
          const num = document.createElement('span');
          num.className = 'num';
          num.textContent = n;
          cell.appendChild(num);
        }
        const input = document.createElement('input');
        input.maxLength = 1;
        input.autocomplete = 'off';
        input.inputMode = 'text';
        input.setAttribute('aria-label', `Row ${r + 1}, column ${c + 1}`);
        input.addEventListener('focus', () => state.activeInput = input);
        input.addEventListener('input', () => {
          input.value = input.value.replace(/[^a-zA-Z]/g, '').slice(0, 1).toUpperCase();
          moveNext(r, c);
        });
        input.addEventListener('keydown', (e) => handleGridKey(e, r, c));
        cell.appendChild(input);
      }
      gridEl.appendChild(cell);
    });
  });
}

function renderClues(puzzle) {
  renderClueList('across', puzzle.across || []);
  renderClueList('down', puzzle.down || []);
}

function renderClueList(id, list) {
  const el = $(id);
  el.innerHTML = '';
  for (const entry of list) {
    const li = document.createElement('li');
    li.value = entry.number;
    li.textContent = entry.clue || `${entry.answer.length}-letter answer`;
    el.appendChild(li);
  }
}

function checkPuzzle() {
  if (!state.puzzle) return;
  for (const cell of document.querySelectorAll('.cell:not(.black)')) {
    const r = Number(cell.dataset.row);
    const c = Number(cell.dataset.col);
    const expected = state.puzzle.grid[r][c];
    const input = cell.querySelector('input');
    cell.classList.remove('right', 'wrong');
    if (!input.value) continue;
    cell.classList.add(input.value.toUpperCase() === expected ? 'right' : 'wrong');
  }
}

function revealLetter() {
  if (!state.puzzle) return;
  const input = state.activeInput || document.querySelector('.cell:not(.black) input');
  if (!input) return;
  const cell = input.closest('.cell');
  input.value = state.puzzle.grid[Number(cell.dataset.row)][Number(cell.dataset.col)];
  input.focus();
}

function revealPuzzle() {
  if (!state.puzzle) return;
  for (const cell of document.querySelectorAll('.cell:not(.black)')) {
    const input = cell.querySelector('input');
    input.value = state.puzzle.grid[Number(cell.dataset.row)][Number(cell.dataset.col)];
  }
}

function moveNext(r, c) {
  const next = findNextInput(r, c, 1, 0) || findNextInput(r, c, 0, 1);
  if (next) next.focus();
}

function handleGridKey(e, r, c) {
  const keyMap = {
    ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0]
  };
  if (e.key === 'Backspace' && !e.target.value) {
    const prev = findNextInput(r, c, 0, -1) || findNextInput(r, c, -1, 0);
    if (prev) { e.preventDefault(); prev.focus(); }
  }
  if (keyMap[e.key]) {
    e.preventDefault();
    const [dr, dc] = keyMap[e.key];
    const next = findNextInput(r, c, dr, dc);
    if (next) next.focus();
  }
}

function findNextInput(r, c, dr, dc) {
  const size = state.puzzle?.size || 15;
  let nr = r + dr, nc = c + dc;
  while (nr >= 0 && nr < size && nc >= 0 && nc < size) {
    const cell = document.querySelector(`.cell[data-row="${nr}"][data-col="${nc}"]`);
    const input = cell?.querySelector('input');
    if (input) return input;
    nr += dr; nc += dc;
  }
  return null;
}

function setBusy(isBusy) {
  $('generate').disabled = isBusy;
  $('generate').textContent = isBusy ? 'Generating...' : 'Generate crossword';
}

function setStatus(msg) { $('status').textContent = msg; }
function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}
