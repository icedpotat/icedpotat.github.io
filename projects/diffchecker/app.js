/* ---------------------------------------------------------------------
   Myers diff algorithm (O(ND)), operating on arrays of lines.
   No external dependencies — this is the whole diff engine.
   Reference: E. Myers, "An O(ND) Difference Algorithm and Its Variations"
--------------------------------------------------------------------- */

function myersDiff(a, b) {
  const N = a.length, M = b.length;
  const MAX = N + M || 1;
  const v = new Array(2 * MAX + 1).fill(0);
  const trace = [];

  for (let d = 0; d <= MAX; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[MAX + k - 1] < v[MAX + k + 1])) {
        x = v[MAX + k + 1];
      } else {
        x = v[MAX + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[MAX + k] = x;
      if (x >= N && y >= M) {
        return backtrack(trace, a, b, MAX, N, M);
      }
    }
  }
  return backtrack(trace, a, b, MAX, N, M);
}

function backtrack(trace, a, b, MAX, N, M) {
  let x = N, y = M;
  const ops = [];

  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && v[MAX + k - 1] < v[MAX + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = v[MAX + prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.unshift({ type: 'equal', aIdx: x - 1, bIdx: y - 1 });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.unshift({ type: 'add', bIdx: y - 1 });
      } else {
        ops.unshift({ type: 'remove', aIdx: x - 1 });
      }
      x = prevX; y = prevY;
    }
  }
  return ops;
}

/* Turn raw text into a diff op list, honoring ignore-whitespace / ignore-case. */
function computeDiff(originalText, changedText, opts) {
  const splitLines = (t) => t.replace(/\r\n/g, '\n').split('\n');
  const rawA = splitLines(originalText);
  const rawB = splitLines(changedText);

  const normalize = (line) => {
    let l = line;
    if (opts.ignoreWhitespace) l = l.trim().replace(/\s+/g, ' ');
    if (opts.ignoreCase) l = l.toLowerCase();
    return l;
  };

  const normA = rawA.map(normalize);
  const normB = rawB.map(normalize);

  const ops = myersDiff(normA, normB);

  return ops.map((op) => {
    if (op.type === 'equal') return { type: 'equal', aLine: op.aIdx + 1, bLine: op.bIdx + 1, text: rawA[op.aIdx] };
    if (op.type === 'remove') return { type: 'remove', aLine: op.aIdx + 1, text: rawA[op.aIdx] };
    return { type: 'add', bLine: op.bIdx + 1, text: rawB[op.bIdx] };
  });
}

/* ---------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------- */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* Character-level diff between one removed line and one added line.
   Character granularity (not word) is what catches a typo landing
   inside a word instead of at a space — reusing the same Myers
   implementation since it only needs === equality. */
function charDiffPair(removeText, addText) {
  const aTok = Array.from(removeText);
  const bTok = Array.from(addText);
  const ops = myersDiff(aTok, bTok);
  return ops.map((op) => {
    if (op.type === 'equal') return { type: 'equal', text: aTok[op.aIdx] };
    if (op.type === 'remove') return { type: 'remove', text: aTok[op.aIdx] };
    return { type: 'add', text: bTok[op.bIdx] };
  });
}

/* Collapse consecutive same-type character ops into runs, so "3 chars
   changed in a row" reads (and counts) as one chunk, not three. */
function mergeRuns(charOps) {
  const runs = [];
  for (const t of charOps) {
    const last = runs[runs.length - 1];
    if (last && last.type === t.type) last.text += t.text;
    else runs.push({ type: t.type, text: t.text });
  }
  return runs;
}

/* Render one side (remove or add) of a run-level diff: equal runs
   plain, that side's changed runs wrapped for highlighting. */
function renderRunsForSide(runs, side) {
  const html = runs
    .filter((r) => r.type === 'equal' || r.type === side)
    .map((r) => {
      const text = escapeHtml(r.text);
      if (r.type === 'equal') return text;
      return `<span class="tok-${side === 'remove' ? 'rem' : 'add'}">${text}</span>`;
    })
    .join('');
  return html || '&nbsp;';
}

/* Break a paired line's merged runs into segments: unchanged text passes
   through untouched, and each place where text actually changed becomes
   one "change" segment (an adjacent remove+add is one substitution, not
   two separate edits). This is the unit the merge assistant lets you
   decide on individually, instead of one decision for the whole line. */
function segmentRuns(runs) {
  const segments = [];
  let i = 0;
  while (i < runs.length) {
    const r = runs[i];
    if (r.type === 'equal') {
      segments.push({ type: 'equal', text: r.text });
      i++;
      continue;
    }
    let removeText = '';
    let addText = '';
    if (runs[i] && runs[i].type === 'remove') { removeText = runs[i].text; i++; }
    if (runs[i] && runs[i].type === 'add') { addText = runs[i].text; i++; }
    segments.push({ type: 'change', removeText, addText });
  }
  return segments;
}

/* Group raw line ops into equal / lone-remove / lone-add / paired blocks.
   A "pair" is a removed line matched by index against an added line
   within the same changed run — that's the "this line became that line"
   case where character-level highlighting applies. Runs and segments
   are computed once here and reused by rendering, stats, and merging. */
function groupOps(ops) {
  const blocks = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'equal') {
      blocks.push({ type: 'equal', aLine: op.aLine, bLine: op.bLine, text: op.text });
      i++;
      continue;
    }
    const removes = [];
    const adds = [];
    while (i < ops.length && ops[i].type === 'remove') { removes.push(ops[i]); i++; }
    while (i < ops.length && ops[i].type === 'add') { adds.push(ops[i]); i++; }

    const pairCount = Math.min(removes.length, adds.length);
    for (let j = 0; j < pairCount; j++) {
      const runs = mergeRuns(charDiffPair(removes[j].text, adds[j].text));
      const segments = segmentRuns(runs);
      blocks.push({ type: 'pair', remove: removes[j], add: adds[j], runs, segments });
    }
    for (let j = pairCount; j < removes.length; j++) blocks.push({ type: 'remove', op: removes[j] });
    for (let j = pairCount; j < adds.length; j++) blocks.push({ type: 'add', op: adds[j] });
  }
  return blocks;
}

function lineRow(cls, gutter, marker, contentHtml, changeIndex) {
  const attr = changeIndex === undefined ? '' : ` data-change="${changeIndex}"`;
  return `<div class="diff-line ${cls}"${attr}>
    <span class="gutter">${gutter}</span>
    <span class="marker">${marker}</span>
    <span class="content">${contentHtml}</span>
  </div>`;
}

function renderUnified(blocks) {
  const rows = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'equal') {
      rows.push(lineRow('equal', b.aLine, ' ', escapeHtml(b.text) || '&nbsp;'));
    } else if (b.type === 'remove') {
      rows.push(lineRow('remove', b.op.aLine, '−', escapeHtml(b.op.text) || '&nbsp;', i));
    } else if (b.type === 'add') {
      rows.push(lineRow('add', b.op.bLine, '+', escapeHtml(b.op.text) || '&nbsp;', i));
    } else if (b.type === 'pair') {
      rows.push(lineRow('pair-remove', b.remove.aLine, '−', renderRunsForSide(b.runs, 'remove'), i));
      rows.push(lineRow('pair-add', b.add.bLine, '+', renderRunsForSide(b.runs, 'add'), i));
    }
  }
  return `<div class="diff-unified">${rows.join('')}</div>`;
}

/* Side-by-side: equal lines and paired changed lines sit on the same
   row in both columns; unmatched removes/adds get a blank on the
   opposite side. */
function renderSideBySide(blocks) {
  const left = [];
  const right = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.type === 'equal') {
      left.push(lineRow('equal', b.aLine, '', escapeHtml(b.text) || '&nbsp;'));
      right.push(lineRow('equal', b.bLine, '', escapeHtml(b.text) || '&nbsp;'));
    } else if (b.type === 'pair') {
      left.push(lineRow('pair-remove', b.remove.aLine, '−', renderRunsForSide(b.runs, 'remove'), i));
      right.push(lineRow('pair-add', b.add.bLine, '+', renderRunsForSide(b.runs, 'add'), i));
    } else if (b.type === 'remove') {
      left.push(lineRow('remove', b.op.aLine, '−', escapeHtml(b.op.text) || '&nbsp;', i));
      right.push(lineRow('blank', '', '', '&nbsp;'));
    } else if (b.type === 'add') {
      left.push(lineRow('blank', '', '', '&nbsp;'));
      right.push(lineRow('add', b.op.bLine, '+', escapeHtml(b.op.text) || '&nbsp;', i));
    }
  }

  return `<div class="diff-sbs">
    <div class="side">${left.join('')}</div>
    <div class="side">${right.join('')}</div>
  </div>`;
}

/* Count distinct changed CHUNKS, not raw lines: a contiguous run of
   inserted/deleted lines is one chunk, and within a paired line, each
   contiguous run of inserted/deleted characters is one chunk. This is
   what "N removed, M added" should mean for a diff tool — a paragraph
   with a single typo should read as a couple of small chunks, not as
   "1 line removed, 1 line added". */
function computeStats(blocks) {
  let additions = 0, removals = 0;
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === 'pair') {
      for (const r of b.runs) {
        if (r.type === 'add') additions++;
        else if (r.type === 'remove') removals++;
      }
      i++;
    } else if (b.type === 'remove') {
      removals++;
      while (i < blocks.length && blocks[i].type === 'remove') i++;
    } else if (b.type === 'add') {
      additions++;
      while (i < blocks.length && blocks[i].type === 'add') i++;
    } else {
      i++;
    }
  }
  return { additions, removals };
}

function opsToUnifiedText(ops) {
  return ops.map((op) => {
    const prefix = op.type === 'add' ? '+ ' : op.type === 'remove' ? '- ' : '  ';
    return prefix + op.text;
  }).join('\n');
}

/* ---------------------------------------------------------------------
   Merge assistant — per-chunk "keep original / keep changed / keep both"
--------------------------------------------------------------------- */

function blockTexts(b) {
  if (b.type === 'remove') return { originalText: b.op.text, changedText: '' };
  if (b.type === 'add') return { originalText: '', changedText: b.op.text };
  return { originalText: b.text, changedText: b.text };
}

/* What text a single change segment resolves to under a given choice. */
function segmentChoiceText(seg, choice) {
  if (choice === 'original') return seg.removeText;
  if (choice === 'changed') return seg.addText;
  return seg.removeText + seg.addText; // both
}

function buildMergedText(blocks, selections) {
  const lines = [];
  blocks.forEach((b, i) => {
    if (b.type === 'equal') {
      lines.push(b.text);
      return;
    }
    if (b.type === 'pair') {
      const line = b.segments.map((seg, segIndex) => {
        if (seg.type === 'equal') return seg.text;
        const choice = selections[`${i}:${segIndex}`] || 'changed';
        return segmentChoiceText(seg, choice);
      }).join('');
      lines.push(line);
      return;
    }
    const { originalText, changedText } = blockTexts(b);
    const choice = selections[String(i)] || 'changed';
    let text;
    if (choice === 'original') text = originalText;
    else if (choice === 'changed') text = changedText;
    else text = [originalText, changedText].filter((t) => t !== '').join('\n');
    if (text !== '') lines.push(text);
  });
  return lines.join('\n');
}

/* A paired line's card: the line rendered inline, with each individual
   change as a clickable chip. Clicking a chip cycles it through
   changed → original → both, independently of every other chip on
   the line — this is the per-change granularity a whole-line decision
   can't give you. */
function renderPairMergeCard(b, blockIndex, selections) {
  const parts = b.segments.map((seg, segIndex) => {
    if (seg.type === 'equal') return escapeHtml(seg.text);
    const key = `${blockIndex}:${segIndex}`;
    const choice = selections[key] || 'changed';
    const text = segmentChoiceText(seg, choice);
    return `<button type="button" class="merge-chip choice-${choice}" data-key="${key}" title="Click to cycle: changed → original → both">${text === '' ? '∅' : escapeHtml(text)}</button>`;
  });
  return `<div class="merge-card merge-card-line">
    <div class="merge-line-label">Line ${b.remove.aLine} → ${b.add.bLine}</div>
    <div class="merge-line-content">${parts.join('')}</div>
  </div>`;
}

/* A whole-line addition or removal: there's nothing to compare within
   it, so it's a single three-way choice rather than a chip. */
function renderLoneMergeCard(b, blockIndex, selections) {
  const { originalText, changedText } = blockTexts(b);
  const key = String(blockIndex);
  const choice = selections[key] || 'changed';
  const choiceBtn = (val, label) =>
    `<button type="button" class="merge-choice ${choice === val ? 'active' : ''}" data-key="${key}" data-choice="${val}">${label}</button>`;

  return `<div class="merge-card">
    <div class="merge-card-cols">
      <div class="merge-col rem">
        <span class="merge-col-label">Original</span>
        ${originalText === '' ? '<span class="merge-empty">— nothing —</span>' : escapeHtml(originalText)}
      </div>
      <div class="merge-col add">
        <span class="merge-col-label">Changed</span>
        ${changedText === '' ? '<span class="merge-empty">— nothing —</span>' : escapeHtml(changedText)}
      </div>
    </div>
    <div class="merge-choices">
      ${choiceBtn('original', 'Keep original')}
      ${choiceBtn('changed', 'Keep changed')}
      ${choiceBtn('both', 'Keep both')}
    </div>
  </div>`;
}

function renderMergeAssistant(blocks, selections) {
  const cards = blocks
    .map((b, i) => {
      if (b.type === 'equal') return '';
      if (b.type === 'pair') return renderPairMergeCard(b, i, selections);
      return renderLoneMergeCard(b, i, selections);
    })
    .filter(Boolean);
  el('merge-list').innerHTML = cards.join('') || '<p class="merge-empty-state">No differences to merge.</p>';
}

/* ---------------------------------------------------------------------
   UI wiring
--------------------------------------------------------------------- */

const el = (id) => document.getElementById(id);

const originalEl = el('original');
const changedEl = el('changed');
const resultsEl = el('results');
const diffViewEl = el('diff-view');
const statsEl = el('stats');
const emptyStateEl = el('empty-state');
const mergeSectionEl = el('merge-section');
const mergedOutputEl = el('merged-output');

let lastOps = null;
let currentBlocks = [];
let mergeSelections = {};

function updateMergedOutput() {
  mergedOutputEl.value = buildMergedText(currentBlocks, mergeSelections);
}

function runCompare() {
  const opts = {
    ignoreWhitespace: el('opt-whitespace').checked,
    ignoreCase: el('opt-case').checked,
  };
  const ops = computeDiff(originalEl.value, changedEl.value, opts);
  lastOps = ops;

  const blocks = groupOps(ops);
  currentBlocks = blocks;
  mergeSelections = {};
  changeNavPos = -1;

  const sideBySide = el('opt-view').checked;
  diffViewEl.innerHTML = sideBySide ? renderSideBySide(blocks) : renderUnified(blocks);

  const { additions, removals } = computeStats(blocks);
  statsEl.innerHTML = `<span class="add-count">+${additions}</span><span class="rem-count">−${removals}</span>`;

  const hasChanges = blocks.some((b) => b.type !== 'equal');
  renderMergeAssistant(blocks, mergeSelections);
  updateMergedOutput();
  mergeSectionEl.hidden = !hasChanges;

  resultsEl.hidden = false;
  emptyStateEl.hidden = true;
}

el('compare').addEventListener('click', runCompare);
el('opt-view').addEventListener('change', () => { if (lastOps) runCompare(); });

el('merge-list').addEventListener('click', (e) => {
  const chip = e.target.closest('.merge-chip');
  if (chip) {
    const key = chip.dataset.key;
    const order = ['changed', 'original', 'both'];
    const current = mergeSelections[key] || 'changed';
    mergeSelections[key] = order[(order.indexOf(current) + 1) % order.length];
    renderMergeAssistant(currentBlocks, mergeSelections);
    updateMergedOutput();
    return;
  }
  const btn = e.target.closest('.merge-choice');
  if (btn) {
    const key = btn.dataset.key;
    const choice = btn.dataset.choice;
    mergeSelections[key] = choice;
    btn.closest('.merge-card').querySelectorAll('.merge-choice').forEach((b) => {
      b.classList.toggle('active', b.dataset.choice === choice);
    });
    updateMergedOutput();
  }
});

el('swap').addEventListener('click', () => {
  const tmp = originalEl.value;
  originalEl.value = changedEl.value;
  changedEl.value = tmp;
  if (lastOps) runCompare();
});

document.querySelectorAll('[data-clear]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-clear');
    el(target).value = '';
  });
});

document.querySelectorAll('[data-load]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-load');
    el(`file-${target}`).click();
  });
});

['original', 'changed'].forEach((target) => {
  el(`file-${target}`).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { el(target).value = reader.result; };
    reader.readAsText(file);
    e.target.value = '';
  });
});

/* Copy-to-clipboard: tries the async Clipboard API first, falls back to
   a hidden-textarea + execCommand so it still works on a plain file://
   page where navigator.clipboard may be unavailable or blocked. */
function copyToClipboard(text, btn) {
  const showCopied = () => {
    const original = btn.textContent;
    btn.textContent = 'Copied';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showCopied(); } catch (err) { /* clipboard unavailable */ }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(showCopied).catch(fallback);
  } else {
    fallback();
  }
}

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-copy');
    let text = '';
    if (target === 'original') text = originalEl.value;
    else if (target === 'changed') text = changedEl.value;
    else if (target === 'diff-output') text = lastOps ? opsToUnifiedText(lastOps) : '';
    else if (target === 'merged-output') text = mergedOutputEl.value;
    if (text) copyToClipboard(text, btn);
  });
});

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

el('download').addEventListener('click', () => {
  if (!lastOps) return;
  downloadText('diff.txt', opsToUnifiedText(lastOps));
});

el('download-merged').addEventListener('click', () => {
  if (!mergedOutputEl.value) return;
  downloadText('merged.txt', mergedOutputEl.value);
});

/* ---------------------------------------------------------------------
   Next/previous change navigation
--------------------------------------------------------------------- */

let changeNavPos = -1;

function focusChange(step) {
  const changeIndices = currentBlocks
    .map((b, i) => (b.type !== 'equal' ? i : null))
    .filter((v) => v !== null);
  if (changeIndices.length === 0) return;

  changeNavPos = ((changeNavPos + step) % changeIndices.length + changeIndices.length) % changeIndices.length;
  const target = changeIndices[changeNavPos];
  const rows = diffViewEl.querySelectorAll(`[data-change="${target}"]`);
  if (!rows.length) return;

  rows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  rows.forEach((row) => {
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 900);
  });
}

/* ---------------------------------------------------------------------
   Help modal (shortcuts & legend)
--------------------------------------------------------------------- */

const helpOverlayEl = el('help-overlay');

function openHelp() { helpOverlayEl.hidden = false; }
function closeHelp() { helpOverlayEl.hidden = true; }
function toggleHelp() { helpOverlayEl.hidden ? openHelp() : closeHelp(); }

el('help-open').addEventListener('click', openHelp);
el('help-close').addEventListener('click', closeHelp);
helpOverlayEl.addEventListener('click', (e) => { if (e.target === helpOverlayEl) closeHelp(); });

/* ---------------------------------------------------------------------
   Keyboard shortcuts
--------------------------------------------------------------------- */

document.addEventListener('keydown', (e) => {
  const inField = /^(TEXTAREA|INPUT)$/.test(document.activeElement?.tagName || '');

  // Compare works even while typing in a textarea, like a form submit.
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runCompare();
    return;
  }

  if (e.key === 'Escape' && !helpOverlayEl.hidden) {
    closeHelp();
    return;
  }

  // Everything below is a bare, unmodified key, so it must not fire
  // while the person is typing in a text field.
  if (inField || e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.key.toLowerCase()) {
    case '?':
      toggleHelp();
      break;
    case 's':
      el('swap').click();
      break;
    case 'v':
      el('opt-view').checked = !el('opt-view').checked;
      el('opt-view').dispatchEvent(new Event('change'));
      break;
    case 'n':
      focusChange(1);
      break;
    case 'p':
      focusChange(-1);
      break;
    case 'd':
      if (!resultsEl.hidden) document.querySelector('[data-copy="diff-output"]')?.click();
      break;
    case 'm':
      if (!mergeSectionEl.hidden) document.querySelector('[data-copy="merged-output"]')?.click();
      break;
    default:
      break;
  }
});