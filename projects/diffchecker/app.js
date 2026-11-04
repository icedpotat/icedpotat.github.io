/* ---------------------------------------------------------------------
   Tunables
--------------------------------------------------------------------- */

const LINE_BUDGET = 16000000;      // max stored trace entries for the line-level diff
const CHAR_BUDGET = 3000000;       // same, for character-level diffs inside a line
const PAIR_THRESHOLD = 0.5;        // min similarity (0..1) for two lines to count as "the same line, edited"
const ALIGN_MATRIX_LIMIT = 160000; // max removed×added lines for exact similarity alignment
const FOLD_CONTEXT = 3;            // unchanged lines kept visible around a change
const FOLD_MIN_HIDDEN = 5;         // don't fold fewer lines than this

/* ---------------------------------------------------------------------
   Myers diff (O(ND)) on arrays of comparable items (ints, chars, ...).
   Memory-lean: only the diagonals that can matter are stored per step,
   and a budget aborts hopeless inputs instead of freezing the tab.
   Reference: E. Myers, "An O(ND) Difference Algorithm and Its Variations"
--------------------------------------------------------------------- */

function myersCore(a, b, budget) {
  const N = a.length, M = b.length;
  const MAX = N + M;
  const OFF = MAX + 1;
  const v = new Int32Array(2 * MAX + 3);
  const trace = [];
  let stored = 0;

  for (let d = 0; d <= MAX; d++) {
    stored += 2 * d + 3;
    if (stored > budget) return null;
    trace.push(v.slice(OFF - d - 1, OFF + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[OFF + k - 1] < v[OFF + k + 1])) {
        x = v[OFF + k + 1];
      } else {
        x = v[OFF + k - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[OFF + k] = x;
      if (x >= N && y >= M) return backtrackOps(trace, N, M);
    }
  }
  return null;
}

function backtrackOps(trace, N, M) {
  let x = N, y = M;
  const ops = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const tv = trace[d]; // diagonal k lives at index k + d + 1
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && tv[k + d] < tv[k + d + 2])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = tv[prevK + d + 1];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      ops.push({ type: 'equal', aIdx: x - 1, bIdx: y - 1 });
      x--; y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: 'add', bIdx: y - 1 });
      else ops.push({ type: 'remove', aIdx: x - 1 });
      x = prevX; y = prevY;
    }
  }
  ops.reverse();
  return ops;
}

/* Returns { ops, coarse }. If the inputs differ too much for the budget,
   falls back to "everything removed, everything added" and flags it. */
function myersDiff(a, b, budget) {
  const N = a.length, M = b.length;
  const fallback = (coarse) => {
    const ops = [];
    for (let i = 0; i < N; i++) ops.push({ type: 'remove', aIdx: i });
    for (let j = 0; j < M; j++) ops.push({ type: 'add', bIdx: j });
    return { ops, coarse };
  };
  if (N === 0 || M === 0) return fallback(false);
  const ops = myersCore(a, b, budget);
  return ops ? { ops, coarse: false } : fallback(true);
}

/* ---------------------------------------------------------------------
   Line-level diff
--------------------------------------------------------------------- */

let lastDiffInfo = { aLines: 0, bLines: 0, coarse: false };

/* Turn raw text into a diff op list, honoring ignore-whitespace / ignore-case.
   Lines are interned to integers and the common head/tail is trimmed first,
   which is what makes big, mostly-similar files fast. */
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

  const ids = new Map();
  const intern = (s) => {
    let id = ids.get(s);
    if (id === undefined) { id = ids.size; ids.set(s, id); }
    return id;
  };

  const nA = rawA.length, nB = rawB.length;
  const A = new Int32Array(nA);
  const B = new Int32Array(nB);
  for (let i = 0; i < nA; i++) A[i] = intern(normalize(rawA[i]));
  for (let i = 0; i < nB; i++) B[i] = intern(normalize(rawB[i]));

  let pre = 0;
  while (pre < nA && pre < nB && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < nA - pre && suf < nB - pre && A[nA - 1 - suf] === B[nB - 1 - suf]) suf++;

  const out = [];
  for (let i = 0; i < pre; i++) out.push({ type: 'equal', aLine: i + 1, bLine: i + 1, text: rawA[i] });

  const res = myersDiff(A.subarray(pre, nA - suf), B.subarray(pre, nB - suf), LINE_BUDGET);
  for (const op of res.ops) {
    if (op.type === 'equal') {
      const ai = op.aIdx + pre;
      out.push({ type: 'equal', aLine: ai + 1, bLine: op.bIdx + pre + 1, text: rawA[ai] });
    } else if (op.type === 'remove') {
      const ai = op.aIdx + pre;
      out.push({ type: 'remove', aLine: ai + 1, text: rawA[ai] });
    } else {
      const bi = op.bIdx + pre;
      out.push({ type: 'add', bLine: bi + 1, text: rawB[bi] });
    }
  }

  for (let i = 0; i < suf; i++) {
    const ai = nA - suf + i, bi = nB - suf + i;
    out.push({ type: 'equal', aLine: ai + 1, bLine: bi + 1, text: rawA[ai] });
  }

  lastDiffInfo = { aLines: nA, bLines: nB, coarse: res.coarse };
  return out;
}

/* ---------------------------------------------------------------------
   Rendering helpers
--------------------------------------------------------------------- */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* Character-level diff between one removed line and one added line.
   Common head/tail are cut off as single runs first, so a long paragraph
   with a couple of edits only diffs the stretch between the edits. */
function charDiffPair(removeText, addText) {
  const a = Array.from(removeText);
  const b = Array.from(addText);
  const minLen = Math.min(a.length, b.length);

  let pre = 0;
  while (pre < minLen && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < minLen - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);

  const out = [];
  if (pre) out.push({ type: 'equal', text: a.slice(0, pre).join('') });
  const { ops } = myersDiff(midA, midB, CHAR_BUDGET);
  for (const op of ops) {
    if (op.type === 'equal') out.push({ type: 'equal', text: midA[op.aIdx] });
    else if (op.type === 'remove') out.push({ type: 'remove', text: midA[op.aIdx] });
    else out.push({ type: 'add', text: midB[op.bIdx] });
  }
  if (suf) out.push({ type: 'equal', text: a.slice(a.length - suf).join('') });
  return out;
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

/* ---------------------------------------------------------------------
   Matching edited lines (the "this line became that line" problem)

   After the exact line diff, a changed region has some removed lines and
   some added lines. Instead of pairing them by position, each removed line
   is matched to the most similar added line, in order, only if they are
   actually similar. Everything else stays a plain removal or addition —
   so a line replaced by a whole paragraph reads as exactly that.
--------------------------------------------------------------------- */

function gramsOf(text) {
  const map = new Map();
  let n = 0;
  if (text.length === 1) {
    map.set(text, 1); n = 1;
  } else if (text.length > 1) {
    n = text.length - 1;
    for (let i = 0; i < n; i++) {
      const g = text.slice(i, i + 2);
      map.set(g, (map.get(g) || 0) + 1);
    }
  }
  return { map, n };
}

/* Dice coefficient over character bigrams: tolerant of typos inside words. */
function similarity(x, y) {
  if (x.n === 0 || y.n === 0) return 0;
  const small = x.map.size <= y.map.size ? x.map : y.map;
  const big = small === x.map ? y.map : x.map;
  let inter = 0;
  for (const [g, c] of small) {
    const c2 = big.get(g);
    if (c2) inter += c < c2 ? c : c2;
  }
  return (2 * inter) / (x.n + y.n);
}

/* Order-preserving best matching (like LCS, but weighted by similarity). */
function alignDP(gr, ga) {
  const m = gr.length, n = ga.length;
  const sim = new Float32Array(m * n);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) sim[i * n + j] = similarity(gr[i], ga[j]);
  }

  const W = n + 1;
  const dir = new Uint8Array((m + 1) * W); // 1 = pair, 2 = skip removed line, 3 = skip added line
  let prev = new Float64Array(W);
  let cur = new Float64Array(W);

  for (let i = 1; i <= m; i++) {
    cur[0] = 0;
    for (let j = 1; j <= n; j++) {
      let best = prev[j], d = 2;
      if (cur[j - 1] > best) { best = cur[j - 1]; d = 3; }
      const s = sim[(i - 1) * n + (j - 1)];
      if (s >= PAIR_THRESHOLD && prev[j - 1] + s > best) { best = prev[j - 1] + s; d = 1; }
      cur[j] = best;
      dir[i * W + j] = d;
    }
    const t = prev; prev = cur; cur = t;
  }

  const pairs = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    const d = dir[i * W + j];
    if (d === 1) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (d === 2) i--;
    else j--;
  }
  pairs.reverse();
  return pairs;
}

/* Cheap fallback for huge changed regions: sliding-window greedy matching. */
function alignGreedy(gr, ga) {
  const WINDOW = 40;
  const pairs = [];
  let j0 = 0;
  for (let i = 0; i < gr.length; i++) {
    let best = -1, bj = -1;
    const hi = Math.min(ga.length, j0 + WINDOW);
    for (let j = j0; j < hi; j++) {
      const s = similarity(gr[i], ga[j]);
      if (s >= PAIR_THRESHOLD && s > best) { best = s; bj = j; }
    }
    if (bj >= 0) { pairs.push([i, bj]); j0 = bj + 1; }
  }
  return pairs;
}

function pushPair(blocks, remove, add) {
  const runs = mergeRuns(charDiffPair(remove.text, add.text));
  blocks.push({ type: 'pair', remove, add, runs, segments: segmentRuns(runs) });
}

function alignRegion(removes, adds, blocks) {
  const m = removes.length, n = adds.length;
  if (m === 0) { for (const op of adds) blocks.push({ type: 'add', op }); return; }
  if (n === 0) { for (const op of removes) blocks.push({ type: 'remove', op }); return; }

  const gr = removes.map((o) => gramsOf(o.text));
  const ga = adds.map((o) => gramsOf(o.text));
  const pairs = (m * n <= ALIGN_MATRIX_LIMIT) ? alignDP(gr, ga) : alignGreedy(gr, ga);

  let ri = 0, aj = 0;
  for (const [pi, pj] of pairs) {
    for (; ri < pi; ri++) blocks.push({ type: 'remove', op: removes[ri] });
    for (; aj < pj; aj++) blocks.push({ type: 'add', op: adds[aj] });
    pushPair(blocks, removes[pi], adds[pj]);
    ri = pi + 1; aj = pj + 1;
  }
  for (; ri < m; ri++) blocks.push({ type: 'remove', op: removes[ri] });
  for (; aj < n; aj++) blocks.push({ type: 'add', op: adds[aj] });
}

/* Group raw line ops into equal / lone-remove / lone-add / paired blocks.
   A whole changed region (any mix of removes and adds between two equal
   stretches) is aligned together, then runs and segments are computed once
   and reused by rendering, stats, and merging. */
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
    while (i < ops.length && ops[i].type !== 'equal') {
      (ops[i].type === 'remove' ? removes : adds).push(ops[i]);
      i++;
    }
    alignRegion(removes, adds, blocks);
  }
  return blocks;
}

/* ---------------------------------------------------------------------
   Rendering
--------------------------------------------------------------------- */

function lineRow(cls, gutter, marker, contentHtml, changeIndex) {
  const attr = changeIndex === undefined ? '' : ` data-change="${changeIndex}"`;
  return `<div class="diff-line ${cls}"${attr}>
    <span class="gutter">${gutter}</span>
    <span class="marker">${marker}</span>
    <span class="content">${contentHtml}</span>
  </div>`;
}

function foldRow(item) {
  const count = item.end - item.start;
  return `<div class="diff-fold" data-fold="${item.start}"><button type="button" class="fold-btn">⋯ ${count.toLocaleString()} unchanged line${count === 1 ? '' : 's'} — click to expand</button></div>`;
}

/* Decide what to show: every changed block, plus a few unchanged lines of
   context around each change. Long unchanged stretches become a fold. */
function buildPlan(blocks, fold, expanded) {
  const plan = [];
  const n = blocks.length;
  let i = 0;
  while (i < n) {
    if (blocks[i].type !== 'equal') { plan.push({ kind: 'block', i }); i++; continue; }
    let j = i;
    while (j < n && blocks[j].type === 'equal') j++;

    const leading = i === 0, trailing = j === n;
    const hideStart = leading ? i : i + FOLD_CONTEXT;
    const hideEnd = trailing ? j : j - FOLD_CONTEXT;
    const canFold = fold && (hideEnd - hideStart) >= FOLD_MIN_HIDDEN && !expanded.has(hideStart);

    if (!canFold) {
      for (let k = i; k < j; k++) plan.push({ kind: 'block', i: k });
    } else {
      for (let k = i; k < hideStart; k++) plan.push({ kind: 'block', i: k });
      plan.push({ kind: 'fold', start: hideStart, end: hideEnd });
      for (let k = hideEnd; k < j; k++) plan.push({ kind: 'block', i: k });
    }
    i = j;
  }
  return plan;
}

function renderUnified(blocks, plan) {
  const rows = [];
  for (const it of plan) {
    if (it.kind === 'fold') { rows.push(foldRow(it)); continue; }
    const i = it.i;
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

const sbsRow = (left, right) => `<div class="sbs-row">${left}${right}</div>`;

/* Side-by-side: every row is a real two-cell grid row, so both sides always
   line up even when one side wraps to more lines. Equal lines and edited
   line pairs share a row; leftover removed/added lines between them are
   zipped next to each other (blank where one side runs out). */
function renderSideBySide(blocks, plan) {
  const rows = [];
  const blank = () => lineRow('blank', '', '', '&nbsp;');
  let k = 0;

  while (k < plan.length) {
    const it = plan[k];
    if (it.kind === 'fold') { rows.push(foldRow(it)); k++; continue; }

    const i = it.i;
    const b = blocks[i];
    if (b.type === 'equal') {
      const html = escapeHtml(b.text) || '&nbsp;';
      rows.push(sbsRow(lineRow('equal', b.aLine, '', html), lineRow('equal', b.bLine, '', html)));
      k++;
    } else if (b.type === 'pair') {
      rows.push(sbsRow(
        lineRow('pair-remove', b.remove.aLine, '−', renderRunsForSide(b.runs, 'remove'), i),
        lineRow('pair-add', b.add.bLine, '+', renderRunsForSide(b.runs, 'add'), i)
      ));
      k++;
    } else {
      const rem = [];
      const add = [];
      while (k < plan.length && plan[k].kind === 'block') {
        const idx = plan[k].i;
        const bb = blocks[idx];
        if (bb.type === 'remove') rem.push({ b: bb, i: idx });
        else if (bb.type === 'add') add.push({ b: bb, i: idx });
        else break;
        k++;
      }
      const len = Math.max(rem.length, add.length);
      for (let j = 0; j < len; j++) {
        const l = rem[j]
          ? lineRow('remove', rem[j].b.op.aLine, '−', escapeHtml(rem[j].b.op.text) || '&nbsp;', rem[j].i)
          : blank();
        const r = add[j]
          ? lineRow('add', add[j].b.op.bLine, '+', escapeHtml(add[j].b.op.text) || '&nbsp;', add[j].i)
          : blank();
        rows.push(sbsRow(l, r));
      }
    }
  }
  return `<div class="diff-sbs">${rows.join('')}</div>`;
}

/* Count distinct changed CHUNKS, not raw lines: a contiguous run of
   inserted/deleted lines is one chunk, and within a paired line, each
   contiguous run of inserted/deleted characters is one chunk. */
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

/* A "change" for navigation purposes is a whole stretch of consecutive
   changed blocks (a hunk), not each single block. Returns [start, end] pairs
   of block indices. */
function computeChangeGroups(blocks) {
  const groups = [];
  let cur = null;
  blocks.forEach((b, i) => {
    if (b.type === 'equal') { cur = null; return; }
    if (!cur) { cur = [i, i]; groups.push(cur); }
    else cur[1] = i;
  });
  return groups;
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
    } else if (b.type === 'pair') {
      const line = b.segments.map((seg, segIndex) => {
        if (seg.type === 'equal') return seg.text;
        const choice = selections[`${i}:${segIndex}`] || 'changed';
        return segmentChoiceText(seg, choice);
      }).join('');
      lines.push(line);
    } else {
      // A lone removed line only exists in the original, a lone added line
      // only in the changed text — so "keep" is a yes/no on the whole line.
      const choice = selections[String(i)] || 'changed';
      const keepOriginal = choice === 'original' || choice === 'both';
      const keepChanged = choice === 'changed' || choice === 'both';
      if (b.type === 'remove' && keepOriginal) lines.push(b.op.text);
      if (b.type === 'add' && keepChanged) lines.push(b.op.text);
    }
  });
  return lines.join('\n');
}

/* A paired line's card: the line rendered inline, with each individual
   change as a clickable chip. Clicking a chip cycles it through
   changed → original → both, independently of every other chip on
   the line. */
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
  const key = String(blockIndex);
  const choice = selections[key] || 'changed';
  const choiceBtn = (val, label) =>
    `<button type="button" class="merge-choice ${choice === val ? 'active' : ''}" data-key="${key}" data-choice="${val}">${label}</button>`;

  const lineHtml = (text) => text === '' ? '<span class="merge-empty">(empty line)</span>' : escapeHtml(text);
  const nothing = '<span class="merge-empty">— nothing —</span>';
  const originalHtml = b.type === 'remove' ? lineHtml(b.op.text) : nothing;
  const changedHtml = b.type === 'add' ? lineHtml(b.op.text) : nothing;
  const lineNo = b.type === 'remove' ? `Line ${b.op.aLine} (removed)` : `Line ${b.op.bLine} (added)`;

  return `<div class="merge-card">
    <div class="merge-line-label">${lineNo}</div>
    <div class="merge-card-cols">
      <div class="merge-col rem">
        <span class="merge-col-label">Original</span>
        ${originalHtml}
      </div>
      <div class="merge-col add">
        <span class="merge-col-label">Changed</span>
        ${changedHtml}
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
  const cards = [];
  blocks.forEach((b, i) => {
    if (b.type === 'equal') return;
    cards.push(b.type === 'pair' ? renderPairMergeCard(b, i, selections) : renderLoneMergeCard(b, i, selections));
  });
  el('merge-list').innerHTML = cards.join('') || '<p class="merge-empty-state">No differences to merge.</p>';
}

// @@UI-START
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
let expandedFolds = new Set();
let changeNavPos = -1;
let changeGroups = [];
let comparing = false;

function updateMergedOutput() {
  mergedOutputEl.value = buildMergedText(currentBlocks, mergeSelections);
}

function renderDiffView() {
  if (!currentBlocks.length) return;
  const hasChanges = currentBlocks.some((b) => b.type !== 'equal');
  if (!hasChanges) {
    diffViewEl.innerHTML = '<p class="identical-note">The two texts are identical.</p>';
    return;
  }
  const plan = buildPlan(currentBlocks, el('opt-fold').checked, expandedFolds);
  diffViewEl.innerHTML = el('opt-view').checked
    ? renderSideBySide(currentBlocks, plan)
    : renderUnified(currentBlocks, plan);
}

async function runCompare() {
  if (comparing) return;
  comparing = true;

  const btn = el('compare');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Comparing…';
  // Let the browser paint the "Comparing…" state before the heavy work starts.
  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    const t0 = performance.now();
    const opts = {
      ignoreWhitespace: el('opt-whitespace').checked,
      ignoreCase: el('opt-case').checked,
    };
    const ops = computeDiff(originalEl.value, changedEl.value, opts);
    lastOps = ops;

    const blocks = groupOps(ops);
    currentBlocks = blocks;
    mergeSelections = {};
    expandedFolds = new Set();
    changeGroups = computeChangeGroups(blocks);
    changeNavPos = -1;
    updateChangeCounter();

    renderDiffView();

    const hasChanges = blocks.some((b) => b.type !== 'equal');
    renderMergeAssistant(blocks, mergeSelections);
    updateMergedOutput();
    mergeSectionEl.hidden = !hasChanges;
    el('goto-merge').hidden = !hasChanges;

    const { additions, removals } = computeStats(blocks);
    const ms = Math.round(performance.now() - t0);
    let html = `<span class="add-count">+${additions}</span><span class="rem-count">−${removals}</span>`;
    html += `<span class="meta">${lastDiffInfo.aLines.toLocaleString()} → ${lastDiffInfo.bLines.toLocaleString()} lines · ${ms} ms</span>`;
    if (lastDiffInfo.coarse) {
      html += '<span class="warn">The texts differ so much that lines could only be matched roughly.</span>';
    }
    statsEl.innerHTML = html;

    resultsEl.hidden = false;
    emptyStateEl.hidden = true;

    // If the results are mostly below the fold (long input boxes), bring them into view.
    if (resultsEl.getBoundingClientRect().top > window.innerHeight * 0.7) {
      resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    console.error(err);
    statsEl.textContent = 'Something went wrong while comparing: ' + err.message;
    resultsEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    comparing = false;
  }
}

el('compare').addEventListener('click', runCompare);
el('opt-view').addEventListener('change', () => { if (lastOps) renderDiffView(); });
el('opt-fold').addEventListener('change', () => {
  expandedFolds = new Set();
  if (lastOps) renderDiffView();
});

diffViewEl.addEventListener('click', (e) => {
  const fold = e.target.closest('[data-fold]');
  if (!fold) return;
  expandedFolds.add(Number(fold.dataset.fold));
  renderDiffView();
});

el('merge-list').addEventListener('click', (e) => {
  const chip = e.target.closest('.merge-chip');
  if (chip) {
    const key = chip.dataset.key;
    const order = ['changed', 'original', 'both'];
    const current = mergeSelections[key] || 'changed';
    mergeSelections[key] = order[(order.indexOf(current) + 1) % order.length];
    // Only re-render the one card that changed (keeps huge merges snappy).
    const blockIndex = Number(key.split(':')[0]);
    const card = chip.closest('.merge-card');
    card.outerHTML = renderPairMergeCard(currentBlocks[blockIndex], blockIndex, mergeSelections);
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
  updateCounts();
  if (lastOps) runCompare();
});

document.querySelectorAll('[data-clear]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-clear');
    el(target).value = '';
    updateCounts();
  });
});

document.querySelectorAll('[data-load]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-load');
    el(`file-${target}`).click();
  });
});

function readFileInto(file, target) {
  const reader = new FileReader();
  reader.onload = () => { el(target).value = reader.result; updateCounts(); };
  reader.readAsText(file);
}

['original', 'changed'].forEach((target) => {
  el(`file-${target}`).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    readFileInto(file, target);
    e.target.value = '';
  });

  // Drag & drop a file onto the pane. Dropped plain text still behaves normally.
  const pane = el(target).closest('.pane');
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  ['dragenter', 'dragover'].forEach((type) => {
    pane.addEventListener(type, (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      pane.classList.add('drag-over');
    });
  });
  pane.addEventListener('dragleave', (e) => {
    if (!pane.contains(e.relatedTarget)) pane.classList.remove('drag-over');
  });
  pane.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    pane.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) readFileInto(file, target);
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

function updateChangeCounter() {
  const n = changeGroups.length;
  el('change-counter').textContent = n === 0 ? '–' : `${changeNavPos < 0 ? '–' : changeNavPos + 1} / ${n}`;
  el('prev-change').disabled = n === 0;
  el('next-change').disabled = n === 0;
}

function focusChange(step) {
  const n = changeGroups.length;
  if (n === 0) return;
  // First press goes to the first change (or the last, when going backwards).
  changeNavPos = changeNavPos < 0 ? (step > 0 ? 0 : n - 1) : (changeNavPos + step + n) % n;
  updateChangeCounter();

  const [from, to] = changeGroups[changeNavPos];
  const rows = Array.from(diffViewEl.querySelectorAll('[data-change]'))
    .filter((row) => { const i = Number(row.dataset.change); return i >= from && i <= to; });
  if (!rows.length) return;

  rows[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
  rows.slice(0, 200).forEach((row) => {
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 900);
  });
}

el('prev-change').addEventListener('click', () => focusChange(-1));
el('next-change').addEventListener('click', () => focusChange(1));
el('goto-merge').addEventListener('click', () => {
  if (!mergeSectionEl.hidden) mergeSectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

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
   Input conveniences: counts, scroll-to-top, remembered options
--------------------------------------------------------------------- */

function countsText(text) {
  if (!text) return '0 lines · 0 characters';
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return `${lines.toLocaleString()} line${lines === 1 ? '' : 's'} · ${text.length.toLocaleString()} characters`;
}

function updateCounts() {
  el('count-original').textContent = countsText(originalEl.value);
  el('count-changed').textContent = countsText(changedEl.value);
}

let countsQueued = false;
function queueCounts() {
  if (countsQueued) return;
  countsQueued = true;
  requestAnimationFrame(() => { countsQueued = false; updateCounts(); });
}
originalEl.addEventListener('input', queueCounts);
changedEl.addEventListener('input', queueCounts);

const toTopEl = el('to-top');
function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }
function updateToTop() {
  const show = window.scrollY > 400;
  toTopEl.classList.toggle('visible', show);
  toTopEl.tabIndex = show ? 0 : -1;
}
window.addEventListener('scroll', updateToTop, { passive: true });
toTopEl.addEventListener('click', scrollToTop);

// Remember the option checkboxes between visits (silently skipped if storage is unavailable).
const PERSIST_IDS = ['opt-whitespace', 'opt-case', 'opt-view', 'opt-fold'];
function loadOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem('diffchecker.options') || '{}');
    PERSIST_IDS.forEach((id) => { if (typeof saved[id] === 'boolean') el(id).checked = saved[id]; });
  } catch (err) { /* storage unavailable */ }
}
function saveOptions() {
  try {
    const o = {};
    PERSIST_IDS.forEach((id) => { o[id] = el(id).checked; });
    localStorage.setItem('diffchecker.options', JSON.stringify(o));
  } catch (err) { /* storage unavailable */ }
}
PERSIST_IDS.forEach((id) => el(id).addEventListener('change', saveOptions));
loadOptions();
updateCounts();
updateToTop();
updateChangeCounter();

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
    case 't':
      scrollToTop();
      break;
    default:
      break;
  }
});