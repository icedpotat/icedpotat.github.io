/* Impostata — browser port of the Android game (github.com/icedpotat/Impostata).
 * Pass-and-play: everything stays in this browser (localStorage). */
(() => {
  'use strict';

  const ROLE = { CREW: 'CREW', UNDERCOVER: 'UNDERCOVER', IMPOSTOR: 'IMPOSTOR', JESTER: 'JESTER' };
  const ROLE_LABEL = { CREW: 'Crew', UNDERCOVER: 'Undercover', IMPOSTOR: 'Impostor', JESTER: 'Jester' };
  const MODES = ['flip', 'hold', 'grid'];
  const MODE_LABEL = { flip: 'Klick', hold: 'Halten', grid: 'Wählen' };
  const GROUP_COLORS = ['#F44336', '#2196F3', '#4CAF50', '#FF9800', '#9C27B0', '#00BCD4', '#FF5722'];
  const STORE_KEY = 'impostata.v1';

  const $ = (id) => document.getElementById(id);
  const rnd = (n) => Math.floor(Math.random() * n);
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- persistence ---------------- */
  const store = (() => {
    let data = {};
    try { data = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { data = {}; }
    const defaults = {
      chanceAll: 1, chanceNone: 1, chanceJester: 1, chanceOneCrew: 1, mode: 'flip',
      groups: [], customWords: [], names: [], playerCount: 3, imp: 1, und: 0, usedWords: [],
    };
    data = Object.assign({}, defaults, data);
    return {
      get: (k) => data[k],
      set: (k, v) => { data[k] = v; try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch (e) { /* private mode */ } },
    };
  })();

  /* ---------------- words ---------------- */
  const pairKey = (p) => p[0].toLowerCase() + '|' + p[1].toLowerCase();
  function allPairs() {
    const seen = new Set();
    return (window.IMPOSTATA_WORDS || []).concat(store.get('customWords')).filter((p) => {
      const k = pairKey(p); if (seen.has(k)) return false; seen.add(k); return true;
    });
  }
  function parsePairLine(line) {
    const parts = line.split(/[,;]/).map((s) => s.trim().replace(/^"|"$/g, ''));
    return parts.length === 2 && parts[0] && parts[1] ? parts : null;
  }
  /* Draw a pair that has not been used yet; start over once all are used. Survives reloads. */
  function nextPair() {
    const pairs = allPairs();
    let used = new Set(store.get('usedWords'));
    let pool = pairs.filter((p) => !used.has(pairKey(p)));
    if (!pool.length) { used = new Set(); pool = pairs; }
    const p = pool[rnd(pool.length)];
    used.add(pairKey(p));
    store.set('usedWords', [...used]);
    return { crew: p[0], undercover: p[1] };
  }

  /* ---------------- game logic ---------------- */
  let game = null;

  /** Builds a new game. Returns null when the role counts do not fit. */
  function createGame(names, undercoverCount, impostorCount) {
    const n = names.length;
    if (n < 3 || undercoverCount + impostorCount >= n) return null;
    const g = {
      players: names.map((name, i) => ({ name: name.trim() || 'Spieler ' + (i + 1), role: null, ejected: false })),
      pair: nextPair(), crewGame: false, impostorGame: false, startImpostors: 0, ended: false,
    };
    let imp = impostorCount, und = undercoverCount, allowJester = true;
    const roll = rnd(100);
    const cNone = +store.get('chanceNone') || 0, cAll = +store.get('chanceAll') || 0, cOne = +store.get('chanceOneCrew') || 0;
    let roles;
    if (roll < cNone) {
      imp = 0; g.crewGame = true;
    } else if (roll < cNone + cAll) {
      g.impostorGame = true;
      roles = names.map(() => ROLE.IMPOSTOR);
    } else if (roll < cNone + cAll + cOne) {
      imp = n - 1; und = 0; allowJester = false;   // only one crew member
    }
    if (!roles) {
      roles = [];
      for (let i = 0; i < imp; i++) roles.push(ROLE.IMPOSTOR);
      for (let i = 0; i < und; i++) roles.push(ROLE.UNDERCOVER);
      while (roles.length < n) roles.push(ROLE.CREW);
      const crewIdx = roles.map((r, i) => (r === ROLE.CREW ? i : -1)).filter((i) => i >= 0);
      if (allowJester && crewIdx.length > 1 && rnd(100) < (+store.get('chanceJester') || 0)) {
        roles[crewIdx[rnd(crewIdx.length)]] = ROLE.JESTER;
      }
    }
    shuffle(roles);
    g.players.forEach((p, i) => { p.role = roles[i]; });
    g.startImpostors = roles.filter((r) => r === ROLE.IMPOSTOR).length;
    return g;
  }

  function wordFor(p) {
    switch (p.role) {
      case ROLE.CREW: return game.pair.crew;
      case ROLE.JESTER: return 'Du bist Jester.\nDas Wort ist:\n' + game.pair.crew;
      case ROLE.UNDERCOVER: return game.pair.undercover;
      case ROLE.IMPOSTOR: return 'Du bist der Impostor.';
      default: return '';
    }
  }
  const active = () => game.players.filter((p) => !p.ejected);
  const remaining = (role) => active().filter((p) => p.role === role).length;

  function isGameOver() {
    if (game.ended) return true;
    if (game.crewGame || game.impostorGame) return active().length <= 2;
    if (game.startImpostors > 0) return remaining(ROLE.IMPOSTOR) === 0;
    return remaining(ROLE.UNDERCOVER) === 0;
  }

  function summary() {
    let s = 'Das Wort war: ' + game.pair.crew + '\nUndercover-Wort: ' + game.pair.undercover + '\n';
    [ROLE.IMPOSTOR, ROLE.UNDERCOVER, ROLE.JESTER, ROLE.CREW].forEach((r) => {
      const ps = game.players.filter((p) => p.role === r);
      if (ps.length) s += '\n' + ROLE_LABEL[r] + ':\n' + ps.map((p) => '• ' + p.name + (p.ejected ? ' (raus)' : '')).join('\n') + '\n';
    });
    return s.trim();
  }

  /* ---------------- UI helpers ---------------- */
  function show(phase) {
    ['setup', 'play', 'vote', 'result'].forEach((id) => { $(id).hidden = id !== phase; });
    $('btnRoles').hidden = phase === 'setup';
    window.scrollTo(0, 0);
  }
  let toastTimer;
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2200);
  }
  /* Small dialog system. buttons: [{label, cls, onClick -> return false to keep open}] */
  function dialog({ title, body, html, buttons, cancelable = true, onOpen }) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      ${title ? `<h2>${esc(title)}</h2>` : ''}
      ${body != null ? `<p class="body">${esc(body)}</p>` : ''}
      ${html || ''}
      <div class="btns"></div></div>`;
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const btns = ov.querySelector('.btns');
    (buttons || [{ label: 'OK', cls: 'primary' }]).forEach((b) => {
      const el = document.createElement('button');
      el.textContent = b.label; if (b.cls) el.className = b.cls;
      el.addEventListener('click', () => { if (!b.onClick || b.onClick(ov) !== false) close(); });
      btns.appendChild(el);
    });
    const onKey = (e) => { if (e.key === 'Escape' && cancelable) close(); };
    document.addEventListener('keydown', onKey);
    if (cancelable) ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    $('dialogs').appendChild(ov);
    if (onOpen) onOpen(ov);
    const focus = ov.querySelector('input') || btns.lastChild;
    if (focus) focus.focus();
    return { el: ov, close };
  }

  /* ---------------- setup screen ---------------- */
  let names = store.get('names').slice();
  let playerCount = Math.max(3, Math.min(20, store.get('playerCount') || 3));
  let counts = { imp: store.get('imp'), und: store.get('und') };
  let selectedGroup = null;

  function syncNames() {
    while (names.length < playerCount) names.push('Spieler ' + (names.length + 1));
  }
  function renderSetup() {
    syncNames();
    $('playerCountLabel').textContent = playerCount + ' Spieler';
    $('playerCount').value = Math.min(playerCount, 20);
    $('playerCount').hidden = !!selectedGroup;
    $('groupBox').innerHTML = selectedGroup
      ? `<div class="group-pill" style="border-color:${esc(selectedGroup.color)}"><span>${esc(selectedGroup.name)}</span><button class="icon" id="btnUngroup" title="Gruppe entfernen">x</button></div>`
      : '';
    if (selectedGroup) $('btnUngroup').onclick = () => { selectedGroup = null; playerCount = Math.min(playerCount, 20); renderSetup(); };
    $('players').innerHTML = names.slice(0, playerCount).map((n, i) =>
      `<button class="slot" data-i="${i}" title="Namen ändern">${esc(n)}</button>`).join('');
    renderRoles();
    if (!selectedGroup) { store.set('names', names); store.set('playerCount', playerCount); }
  }
  function renderRoles() {
    const maxRoles = Math.min(Math.floor(playerCount / 2) + 1, playerCount - 1);
    counts.und = Math.max(0, Math.min(counts.und, maxRoles));
    counts.imp = Math.max(0, Math.min(counts.imp, maxRoles - counts.und));
    $('nImp').textContent = counts.imp;
    $('nUnd').textContent = counts.und;
    $('nCrew').textContent = playerCount - counts.imp - counts.und;
    const full = counts.imp + counts.und >= maxRoles;
    document.querySelectorAll('[data-role]').forEach((b) => {
      const d = +b.dataset.d, v = counts[b.dataset.role];
      b.disabled = d > 0 ? full : v <= 0;
    });
    store.set('imp', counts.imp); store.set('und', counts.und);
  }

  $('playerCount').addEventListener('input', (e) => { playerCount = +e.target.value; renderSetup(); });
  document.querySelector('.roles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]'); if (!b || b.disabled) return;
    counts[b.dataset.role] += +b.dataset.d; renderRoles();
  });
  $('players').addEventListener('click', (e) => {
    const b = e.target.closest('.slot'); if (!b) return;
    const i = +b.dataset.i;
    dialog({
      title: 'Name ändern',
      html: `<div class="field"><input type="text" id="dlgName" maxlength="24" value="${esc(names[i])}"></div>`,
      buttons: [{ label: 'Abbrechen' }, { label: 'OK', cls: 'primary', onClick: (ov) => {
        const v = ov.querySelector('#dlgName').value.trim();
        if (!v) { toast('Bitte einen gültigen Namen eingeben.'); return false; }
        names[i] = v; renderSetup();
      } }],
      onOpen: (ov) => {
        const inp = ov.querySelector('#dlgName');
        inp.select();
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ov.querySelector('.btns .primary').click(); });
      },
    });
  });

  /* ---------------- groups ---------------- */
  function openGroups() {
    const groups = store.get('groups');
    const list = groups.map((g, i) => `<div class="group-pill" style="border-color:${esc(g.color)}" data-g="${i}">
        <span><b>${esc(g.name)}</b><br><span class="dim small">${esc(g.players.join(', '))}</span></span>
        <button class="icon" data-edit="${i}" title="Bearbeiten">✎</button></div>`).join('');
    const d = dialog({
      title: 'Gruppen',
      html: `<div class="glist">${list || '<p class="dim small">Noch keine Gruppen. Lege eine an, um Spielerlisten zu speichern.</p>'}</div>`,
      buttons: [{ label: 'Schließen' }, { label: 'Neue Gruppe', cls: 'primary', onClick: () => { editGroup(null); } }],
    });
    d.el.querySelector('.glist').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-edit]');
      if (ed) { d.close(); editGroup(+ed.dataset.edit); return; }
      const g = e.target.closest('[data-g]');
      if (g) {
        const grp = groups[+g.dataset.g];
        selectedGroup = grp;
        names = grp.players.slice();
        playerCount = names.length;
        d.close(); renderSetup();
      }
    });
  }
  function editGroup(index) {
    const groups = store.get('groups');
    const g = index == null ? { name: '', players: ['', '', ''], color: GROUP_COLORS[rnd(GROUP_COLORS.length)] } : groups[index];
    const row = (v) => `<div class="prow"><input type="text" maxlength="24" placeholder="Spielername" value="${esc(v)}"><button class="icon" data-del title="Entfernen">x</button></div>`;
    const buttons = [{ label: 'Abbrechen', onClick: () => { setTimeout(openGroups); } }];
    if (index != null) buttons.push({ label: 'Löschen', onClick: () => {
      if (!confirm('Gruppe "' + g.name + '" löschen?')) return false;
      groups.splice(index, 1); store.set('groups', groups); setTimeout(openGroups);
    } });
    buttons.push({ label: 'Speichern', cls: 'primary', onClick: (ov) => {
      const name = ov.querySelector('#gName').value.trim();
      const players = [...ov.querySelectorAll('#gPlayers input')].map((i) => i.value.trim()).filter(Boolean);
      if (!name || players.length < 3) { toast('Bitte Gruppennamen und mindestens 3 Spieler eingeben.'); return false; }
      const ng = { name, players, color: g.color };
      if (index == null) groups.push(ng); else groups[index] = ng;
      store.set('groups', groups); setTimeout(openGroups);
    } });
    dialog({
      title: index == null ? 'Neue Gruppe' : 'Gruppe bearbeiten', cancelable: false,
      html: `<div class="field"><label for="gName">Gruppenname</label><input type="text" id="gName" maxlength="30" value="${esc(g.name)}"></div>
        <div class="field"><label>Spieler (3–20)</label><div id="gPlayers">${g.players.map(row).join('')}</div>
        <button class="block" id="gAdd">+ Spieler</button></div>`,
      buttons,
      onOpen: (ov) => {
        const box = ov.querySelector('#gPlayers');
        ov.querySelector('#gAdd').onclick = () => {
          if (box.children.length >= 20) return toast('Maximal 20 Spieler.');
          box.insertAdjacentHTML('beforeend', row('')); box.lastChild.querySelector('input').focus();
        };
        box.addEventListener('click', (e) => {
          if (!e.target.closest('[data-del]')) return;
          if (box.children.length <= 3) return toast('Mindestens 3 Spieler benötigt.');
          e.target.closest('.prow').remove();
        });
      },
    });
  }
  $('btnGroups').addEventListener('click', openGroups);

  /* ---------------- settings ---------------- */
  function openSettings() {
    let mode = store.get('mode');
    const num = (id, label, key) => `<div class="field"><label for="${id}">${label} (%)</label><input type="number" min="0" max="100" id="${id}" value="${+store.get(key) || 0}"></div>`;
    dialog({
      title: 'Einstellungen',
      html: num('sAll', 'Chance für alle Impostor', 'chanceAll') + num('sNone', 'Chance für keine Impostor', 'chanceNone') +
        num('sOne', 'Chance für nur eine Crew', 'chanceOneCrew') + num('sJester', 'Chance für einen Jester', 'chanceJester') +
        `<div class="field"><label>Rollen-Aufdeckungsart</label><div class="radios" id="sMode">${MODES.map((m) =>
          `<button data-m="${m}" class="${m === mode ? 'on' : ''}">${MODE_LABEL[m]}</button>`).join('')}</div></div>
        <div class="field"><label>Eigene Wörter (${store.get('customWords').length} importiert, ${allPairs().length} gesamt)</label>
          <button class="block" id="sImport">Wörter importieren (.txt/.csv)</button>
          <button class="block" id="sClear"${store.get('customWords').length ? '' : ' disabled'}>Eigene Wörter löschen</button>
          <p class="dim small">Eine Zeile pro Paar: <i>Crew-Wort,Undercover-Wort</i></p></div>`,
      buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', cls: 'primary', onClick: (ov) => {
        const val = (id) => Math.max(0, Math.min(100, parseInt(ov.querySelector('#' + id).value, 10) || 0));
        const all = val('sAll'), none = val('sNone'), one = val('sOne');
        if (all + none + one > 100) { toast('Die Chaos-Chancen ergeben zusammen mehr als 100 %.'); return false; }
        store.set('chanceAll', all); store.set('chanceNone', none); store.set('chanceOneCrew', one);
        store.set('chanceJester', val('sJester')); store.set('mode', mode);
        toast('Gespeichert.');
      } }],
      onOpen: (ov) => {
        ov.querySelector('#sMode').addEventListener('click', (e) => {
          const b = e.target.closest('[data-m]'); if (!b) return;
          mode = b.dataset.m;
          ov.querySelectorAll('#sMode button').forEach((x) => x.classList.toggle('on', x === b));
        });
        ov.querySelector('#sImport').onclick = () => $('importFile').click();
        ov.querySelector('#sClear').onclick = () => {
          if (!confirm('Alle importierten Wörter löschen?')) return;
          store.set('customWords', []); toast('Eigene Wörter gelöscht.');
          ov.remove(); openSettings();
        };
      },
    });
  }
  $('btnSettings').addEventListener('click', () => {
    if (game && $('setup').hidden) {
      dialog({ title: 'Spiel abbrechen?', body: 'Die Einstellungen sind nur zwischen Spielen verfügbar. Aktuelles Spiel beenden?',
        buttons: [{ label: 'Nein' }, { label: 'Ja', cls: 'primary', onClick: () => { restart(); setTimeout(openSettings); } }] });
    } else openSettings();
  });
  $('importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const text = await f.text();
      const existing = new Set(allPairs().map(pairKey));
      const custom = store.get('customWords').slice();
      let added = 0;
      text.split(/\r?\n/).forEach((line) => {
        const p = parsePairLine(line);
        if (p && !existing.has(pairKey(p))) { existing.add(pairKey(p)); custom.push(p); added++; }
      });
      store.set('customWords', custom);
      toast(added + ' Wortpaare importiert.');
      document.querySelectorAll('.overlay').forEach((o) => o.remove());
      openSettings();
    } catch (err) { toast('Datei konnte nicht gelesen werden.'); }
  });

  /* ---------------- playing ---------------- */
  let current = 0, seen = false, mode = 'flip', gridPick = 0;

  function start() {
    const list = names.slice(0, playerCount);
    const g = createGame(list, counts.und, counts.imp);
    if (!g) { toast('Zu viele Undercover/Impostor für diese Spieleranzahl.'); return; }
    game = g; current = 0; seen = false; gridPick = 0;
    mode = MODES.includes(store.get('mode')) ? store.get('mode') : 'flip';
    show('play');
    $('revealCard').hidden = mode === 'grid';
    $('revealGrid').hidden = mode !== 'grid';
    if (mode === 'grid') setupGrid(); else showPlayer();
  }

  function cardBack() { const c = $('card'); c.className = 'card back'; c.textContent = mode === 'hold' ? 'Halten, um deine Rolle zu sehen' : 'Tippe, um deine Rolle zu sehen'; }
  function cardFront() { const c = $('card'); c.className = 'card front'; c.textContent = wordFor(game.players[current]); seen = true; }

  function showPlayer() {
    if (current >= game.players.length) return startVoting(true);
    $('who').textContent = 'Gerät an:\n' + game.players[current].name;
    $('btnNext').textContent = current === game.players.length - 1 ? 'Zur Abstimmung' : 'Weitergeben';
    $('btnNext').hidden = false;
    seen = false; cardBack();
  }

  // flip: click toggles. hold: visible only while pressed.
  const card = $('card');
  card.addEventListener('click', () => { if (mode !== 'flip') return; card.classList.contains('back') ? cardFront() : cardBack(); });
  card.addEventListener('pointerdown', (e) => { if (mode !== 'hold') return; e.preventDefault(); card.setPointerCapture?.(e.pointerId); cardFront(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => card.addEventListener(ev, () => { if (mode === 'hold' && game) cardBack(); }));
  card.addEventListener('contextmenu', (e) => e.preventDefault());
  card.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && mode === 'flip') { e.preventDefault(); card.click(); } });
  card.tabIndex = 0;

  $('btnNext').addEventListener('click', () => {
    if (mode === 'grid') return startVoting(true);
    if (!seen) return toast('Schaue dir zuerst das Wort an ;)');
    current++; showPlayer();
  });

  function setupGrid() {
    // Roles are already shuffled; each picked card hands out the next one.
    const deck = shuffle(game.players.map((p) => p.role));
    const grid = $('grid');
    grid.innerHTML = deck.map((_, i) => `<button class="card gcard" data-c="${i}">?</button>`).join('');
    $('btnNext').hidden = true;
    $('who').textContent = 'Karte wählen für:\n' + game.players[0].name;
    grid.onclick = (e) => {
      const b = e.target.closest('[data-c]');
      if (!b || b.classList.contains('taken') || gridPick >= game.players.length) return;
      const p = game.players[gridPick];
      p.role = deck[+b.dataset.c];
      b.classList.add('taken'); b.textContent = '✕'; b.disabled = true;
      gridPick++;
      dialog({
        title: p.name, body: wordFor(p), cancelable: false,
        buttons: [{ label: 'Verstanden', cls: 'primary', onClick: () => {
          if (gridPick >= game.players.length) startVoting(true);
          else $('who').textContent = 'Karte wählen für:\n' + game.players[gridPick].name;
        } }],
      });
    };
  }

  /* ---------------- voting ---------------- */
  function updateRemaining() {
    $('vImp').textContent = remaining(ROLE.IMPOSTOR);
    $('vUnd').textContent = remaining(ROLE.UNDERCOVER);
    $('vCrew').textContent = remaining(ROLE.CREW) + remaining(ROLE.JESTER);
  }
  function startVoting(firstRound) {
    if (!game || game.ended) return;
    show('vote');
    updateRemaining();
    $('remaining').parentElement.hidden = !rolesVisible;
    $('voteList').innerHTML = game.players.map((p, i) => p.ejected ? '' : `<button data-v="${i}">${esc(p.name)}</button>`).join('');
    if (firstRound) {
      const a = active();
      const starter = a[rnd(a.length)].name;
      const dir = rnd(2) ? 'Uhrzeigersinn' : 'Gegen den Uhrzeigersinn';
      dialog({ title: 'Los geht\u2019s', body: starter + ' beginnt.\n\nDie Runde geht in Richtung:\n' + dir, cancelable: false });
    }
  }
  $('voteList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    const p = game.players[+b.dataset.v];
    dialog({ title: p.name + ' rauswerfen?', buttons: [{ label: 'Abbrechen' }, { label: 'Rauswerfen', cls: 'primary', onClick: () => eject(p) }] });
  });

  function eject(p) {
    const firstEjection = !game.players.some((x) => x.ejected);
    p.ejected = true;
    show('result');
    $('guess').value = '';
    let text = p.name + ' wurde rausgeworfen.\n\nRolle: ' + ROLE_LABEL[p.role];
    $('guessBox').hidden = true; $('btnContinue').hidden = false; $('btnRestart').hidden = true;
    if (p.role === ROLE.IMPOSTOR && !game.impostorGame) {
      // An ejected impostor gets one guess at the crew word to steal the win.
      $('guessBox').hidden = false; $('btnContinue').hidden = true;
      setTimeout(() => $('guess').focus(), 50);
    } else if (p.role === ROLE.JESTER && firstEjection) {
      game.ended = true;
      text += '\n\nDer Jester wurde als Erster rausgeworfen und gewinnt alleine!';
    }
    $('resultText').textContent = text;
    if ($('guessBox').hidden && isGameOver()) endGame(game.ended ? null : '\n\nDas Spiel ist beendet.');
  }

  $('btnGuess').addEventListener('click', () => {
    const guess = $('guess').value.trim().toLowerCase();
    if (!guess) return toast('Bitte ein Wort eingeben.');
    const correct = guess === game.pair.crew.trim().toLowerCase();
    $('guessBox').hidden = true;
    if (correct) {
      game.ended = true;
      $('resultText').textContent = 'Richtig geraten! Die Impostor gewinnen.';
    } else {
      $('resultText').textContent += '\n\nFalsch geraten.';
    }
    if (isGameOver()) endGame(correct ? null : '\n\nDas Spiel ist beendet. Die Crew gewinnt!');
    else $('btnContinue').hidden = false;
  });
  $('guess').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnGuess').click(); });
  $('btnContinue').addEventListener('click', () => startVoting(false));

  function endGame(extra) {
    if (extra) $('resultText').textContent += extra;
    game.ended = true;
    $('btnContinue').hidden = true;
    $('btnRestart').hidden = false;
    dialog({ title: 'Spiel beendet', body: summary() });
  }

  function restart() {
    game = null;
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
    show('setup');
    renderSetup();
  }
  $('btnRestart').addEventListener('click', restart);
  $('btnStart').addEventListener('click', start);

  let rolesVisible = false;
  $('btnRoles').addEventListener('click', () => {
    if (!game) return;
    if (!$('vote').hidden) { rolesVisible = !rolesVisible; $('remaining').parentElement.hidden = !rolesVisible; return; }
    updateRemaining();
    dialog({ title: 'Verbleibende Rollen', body: `Impostor: ${remaining(ROLE.IMPOSTOR)}\nUndercover: ${remaining(ROLE.UNDERCOVER)}\nCrew: ${remaining(ROLE.CREW) + remaining(ROLE.JESTER)}` });
  });

  // Leaving mid-game: browser back / reload asks first, like the app's back button.
  window.addEventListener('beforeunload', (e) => { if (game && !game.ended) { e.preventDefault(); e.returnValue = ''; } });

  renderSetup();
})();
