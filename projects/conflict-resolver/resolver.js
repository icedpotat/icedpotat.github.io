/* Syncthing conflict resolver — browser front end.
 * Reuses the Text Diff engine (../diffchecker/app.js) for the merge view.
 * Folder access: File System Access API (read/write, Chromium browsers) or a
 * read-only folder upload fallback where merged files are downloaded instead.
 * Nothing is uploaded anywhere. */
(() => {
  'use strict';

  const CONFLICT_RE = /^(.+?)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+(\.[^.]+)?$/;
  const SKIP_DIRS = new Set(['.stversions', '.stfolder', '.git']);
  const SNIFF_BYTES = 8192;

  const $ = (id) => document.getElementById(id);
  const canWrite = typeof window.showDirectoryPicker === 'function';

  let rootHandle = null;     // FileSystemDirectoryHandle (write mode)
  let entries = [];          // scanned conflicts
  let active = null;         // entry being resolved
  let activeText = null;     // {crlf, bom} of the current file

  /* ---------------- helpers ---------------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function note(msg, isErr) {
    const n = $('rs-note');
    n.textContent = msg || '';
    n.classList.toggle('rs-err', !!isErr);
  }
  async function isText(file) {
    if (!file) return true;
    const buf = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    if (buf.includes(0)) return false;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: true }); return true; }
    catch (e) { return false; }
  }
  async function readText(file) {
    if (!file) return { text: '', crlf: false, bom: false };
    let raw = await file.text();
    const bom = raw.charCodeAt(0) === 0xFEFF;
    if (bom) raw = raw.slice(1);
    return { text: raw.replace(/\r\n/g, '\n'), crlf: raw.includes('\r\n'), bom };
  }
  function encodeText(text, style) {
    if (style.crlf) text = text.replace(/\r?\n/g, '\r\n');
    if (style.bom) text = '﻿' + text;
    return text;
  }
  function fmtDate(ms) {
    return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
  }

  /* ---------------- scanning ---------------- */
  async function scanHandle(dir, prefix, out) {
    const files = new Map();
    const subdirs = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') { if (!SKIP_DIRS.has(name)) subdirs.push([name, h]); }
      else files.set(name, h);
    }
    for (const [name, h] of files) {
      const m = CONFLICT_RE.exec(name);
      if (!m) continue;
      const baseName = m[1] + (m[2] || '');
      out.push({ dir, path: prefix + name, name, baseName, basePath: prefix + baseName,
        conflictHandle: h, baseHandle: files.get(baseName) || null, status: 'pending' });
    }
    for (const [name, h] of subdirs) await scanHandle(h, prefix + name + '/', out);
  }

  function scanFileList(list) {
    const byPath = new Map();
    for (const f of list) byPath.set(f.webkitRelativePath, f);
    const out = [];
    for (const [p, f] of byPath) {
      const parts = p.split('/');
      if (parts.slice(1, -1).some((d) => SKIP_DIRS.has(d))) continue;
      const m = CONFLICT_RE.exec(f.name);
      if (!m) continue;
      const dirPath = parts.slice(0, -1).join('/') + '/';
      const baseName = m[1] + (m[2] || '');
      out.push({ dir: null, path: p.split('/').slice(1).join('/'), name: f.name, baseName,
        basePath: (dirPath + baseName).split('/').slice(1).join('/'),
        conflictFile: f, baseFile: byPath.get(dirPath + baseName) || null, status: 'pending' });
    }
    return out;
  }

  async function getFiles(e) {
    if (e.conflictHandle) {
      e.conflictFile = await e.conflictHandle.getFile();
      e.baseFile = e.baseHandle ? await e.baseHandle.getFile() : null;
    }
    return { conflict: e.conflictFile, base: e.baseFile };
  }

  async function classify(list) {
    for (const e of list) {
      try {
        const { conflict, base } = await getFiles(e);
        e.mtime = conflict.lastModified;
        if (/\.kdbx$/i.test(e.baseName)) e.type = 'kdbx';
        else e.type = (await isText(conflict)) && (await isText(base)) ? 'text' : 'binary';
        if (!base) e.missingBase = true;
      } catch (err) {
        e.type = '?'; e.status = 'error: ' + err.message;
      }
    }
    list.sort((a, b) => a.path.localeCompare(b.path));
  }

  /* ---------------- list ---------------- */
  function renderList() {
    const tbody = $('rs-list');
    $('rs-table').hidden = entries.length === 0;
    $('rs-rescan').hidden = !rootHandle;
    tbody.innerHTML = entries.map((e, i) => `
      <tr class="${e === active ? 'rs-current' : ''} ${e.status !== 'pending' ? 'rs-done' : ''}">
        <td><code>${esc(e.path)}</code>${e.missingBase ? '<div class="rs-sub">original missing</div>' : ''}</td>
        <td>${esc(e.type || '')}</td>
        <td>${fmtDate(e.mtime)}</td>
        <td>${esc(e.status)}</td>
        <td>${e.status === 'pending' ? `<button type="button" class="btn-ghost" data-open="${i}">Resolve</button>` : ''}</td>
      </tr>`).join('');
    const pending = entries.filter((e) => e.status === 'pending').length;
    if (entries.length) note(`${entries.length} conflict file${entries.length === 1 ? '' : 's'} found, ${pending} pending.` +
      (rootHandle ? '' : ' Read-only mode: resolved files are downloaded, and you delete the conflict copies yourself.'));
  }

  async function afterScan(list) {
    note('Inspecting files…');
    await classify(list);
    entries = list;
    closeActive();
    if (!entries.length) { $('rs-table').hidden = true; $('rs-rescan').hidden = !rootHandle; note('No Syncthing conflict files found in this folder.'); return; }
    renderList();
  }

  /* ---------------- resolving ---------------- */
  function closeActive() {
    active = null; activeText = null;
    $('rs-active').hidden = true;
    $('rs-diff').hidden = true;
  }

  function nextPending() {
    const n = entries.find((e) => e.status === 'pending');
    if (n) openEntry(n); else { closeActive(); renderList(); }
  }

  async function openEntry(e) {
    active = e;
    const { conflict, base } = await getFiles(e);
    $('rs-active').hidden = false;
    $('rs-active-name').textContent = e.path;
    const actions = [];
    if (e.type === 'text') {
      const cur = await readText(base);
      const other = await readText(conflict);
      activeText = { crlf: cur.crlf || (!base && other.crlf), bom: cur.bom || (!base && other.bom) };
      $('original').value = cur.text;
      $('changed').value = other.text;
      $('original').dispatchEvent(new Event('input'));
      $('changed').dispatchEvent(new Event('input'));
      $('rs-diff').hidden = false;
      $('compare').click();
      $('rs-active-sub').textContent = ' — choose what to keep in the Merge section below, edit the result if needed, then save.';
      actions.push(['save', rootHandle ? 'Save merged (Ctrl/⌘+S)' : 'Download merged', 'btn-primary']);
    } else {
      $('rs-diff').hidden = true;
      $('rs-active-sub').textContent = e.type === 'kdbx'
        ? ' — KeePass databases can’t be merged in the browser. Use the desktop version (keepassxc-cli merge), or pick a whole copy here.'
        : ' — binary file, no text diff. Pick which copy to keep.';
    }
    actions.push(['keep', 'Keep current (delete conflict)'], ['use', 'Use conflict copy'], ['skip', 'Skip']);
    $('rs-active-actions').innerHTML = actions.map(([a, label, cls]) =>
      `<button type="button" class="${cls || 'btn-ghost'}" data-act="${a}">${label}</button>`).join('');
    renderList();
    $('rs').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function writeBase(e, data) {
    const h = await e.dir.getFileHandle(e.baseName, { create: true });
    const w = await h.createWritable();
    await w.write(data);
    await w.close();
    e.baseHandle = h;
  }
  async function deleteConflict(e) { await e.dir.removeEntry(e.name); }
  function download(name, data) {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function act(kind) {
    const e = active;
    if (!e) return;
    try {
      if (kind === 'skip') { e.status = 'skipped'; return nextPending(); }
      if (kind === 'save') {
        const text = encodeText($('merged-output').value || $('original').value, activeText);
        if (!rootHandle) { download(e.baseName, text); e.status = 'merged (downloaded)'; return nextPending(); }
        await writeBase(e, text);
        if (confirm(`Saved ${e.basePath}.\n\nDelete the conflict file ${e.name}?`)) { await deleteConflict(e); e.status = 'merged'; }
        else e.status = 'merged (conflict kept)';
        return nextPending();
      }
      if (kind === 'keep') {
        if (!rootHandle) { e.status = 'keep current — delete conflict manually'; return nextPending(); }
        if (!confirm(`Delete ${e.path} and keep the current file?`)) return;
        await deleteConflict(e); e.status = 'kept current';
        return nextPending();
      }
      if (kind === 'use') {
        const { conflict } = await getFiles(e);
        if (!rootHandle) { download(e.baseName, conflict); e.status = 'conflict copy downloaded'; return nextPending(); }
        if (!confirm(`Overwrite ${e.basePath} with the conflict copy and delete ${e.name}?`)) return;
        await writeBase(e, conflict);
        await deleteConflict(e); e.status = 'used conflict';
        return nextPending();
      }
    } catch (err) {
      console.error(err);
      note('Could not complete that: ' + err.message, true);
    }
  }

  /* ---------------- wiring ---------------- */
  if (!canWrite) {
    $('rs-pick').hidden = true;
    $('rs-fallback-label').hidden = false;
    note('This browser can’t write to folders (that needs Chrome, Edge or another Chromium browser). You can still pick a folder read-only and download the resolved files.');
  } else {
    note('Choose your Syncthing folder. The browser will ask for permission to edit files in it.');
  }

  $('rs-pick').addEventListener('click', async () => {
    try {
      rootHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'syncthing' });
    } catch (err) { if (err.name !== 'AbortError') note(err.message, true); return; }
    $('rs-folder').textContent = rootHandle.name;
    note('Scanning…');
    const list = [];
    await scanHandle(rootHandle, '', list);
    await afterScan(list);
  });
  $('rs-rescan').addEventListener('click', async () => {
    if (!rootHandle) return;
    note('Scanning…');
    const list = [];
    await scanHandle(rootHandle, '', list);
    await afterScan(list);
  });
  $('rs-fallback').addEventListener('change', async (ev) => {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;
    rootHandle = null;
    $('rs-folder').textContent = files[0].webkitRelativePath.split('/')[0];
    await afterScan(scanFileList(files));
  });
  $('rs-list').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-open]');
    if (b) openEntry(entries[Number(b.dataset.open)]);
  });
  $('rs-active-actions').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (b) act(b.dataset.act);
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's' && active && active.type === 'text') {
      ev.preventDefault();
      act('save');
    }
  });
})();
