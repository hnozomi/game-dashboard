(function () {
  const PREFIX = 'yorunoyuugijou:rank:';
  const TALLY_PREFIX = 'yorunoyuugijou:tally:';
  const NAME_KEY = 'yorunoyuugijou:playerName';
  const DEFAULT_MAX = 10;
  const DEFAULT_NAME = '名無しさん';

  function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function read(gameKey) {
    try { return safeParse(localStorage.getItem(PREFIX + gameKey), []); }
    catch (e) { return []; }
  }

  function write(gameKey, entries) {
    try { localStorage.setItem(PREFIX + gameKey, JSON.stringify(entries)); } catch (e) {}
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getPlayerName() {
    try { return localStorage.getItem(NAME_KEY) || null; } catch (e) { return null; }
  }

  // Pass an empty/blank name to clear it.
  function setPlayerName(name) {
    const trimmed = name && String(name).trim() ? String(name).trim().slice(0, 14) : '';
    try {
      if (trimmed) localStorage.setItem(NAME_KEY, trimmed);
      else localStorage.removeItem(NAME_KEY);
    } catch (e) {}
    return trimmed || null;
  }

  // The dashboard hands off the current player's name via `?name=...` on each game link.
  // Capture it into the shared store as soon as this script loads, so it's ready before
  // the game's own script runs (both for the start-screen ranking and for later record()s).
  (function captureNameFromUrl() {
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('name');
      if (fromUrl && fromUrl.trim()) setPlayerName(fromUrl);
    } catch (e) {}
  })();

  // Explicit, user-triggered rename (e.g. the "名前を変更" button) — not called automatically.
  function changeName() {
    let input = null;
    try { input = window.prompt('ランキングに表示する名前を入力してください', getPlayerName() || ''); } catch (e) { input = null; }
    if (input === null) return getPlayerName() || DEFAULT_NAME; // cancelled
    return setPlayerName(input) || DEFAULT_NAME;
  }

  // Adds one score to the game's ranking list, keeping only the top `maxEntries`.
  function record(gameKey, value, opts) {
    opts = opts || {};
    const sortDir = opts.sortDir || 'desc';
    const maxEntries = opts.maxEntries || DEFAULT_MAX;
    const name = opts.name !== undefined ? opts.name : (getPlayerName() || DEFAULT_NAME);
    const entries = read(gameKey);
    const entry = { value: value, date: Date.now(), name: name, meta: opts.meta || null };
    entries.push(entry);
    entries.sort(function (a, b) {
      return sortDir === 'asc' ? a.value - b.value : b.value - a.value;
    });
    const trimmed = entries.slice(0, maxEntries);
    write(gameKey, trimmed);
    const idx = trimmed.indexOf(entry);
    return {
      entries: trimmed,
      entry: entry,
      rank: idx === -1 ? null : idx + 1,
      isNewBest: trimmed.length > 0 && trimmed[0] === entry,
      best: trimmed.length ? trimmed[0].value : value
    };
  }

  function getAll(gameKey) { return read(gameKey); }

  function getBest(gameKey, fallback) {
    const entries = read(gameKey);
    return entries.length ? entries[0].value : (fallback === undefined ? 0 : fallback);
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  let stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected || document.getElementById('ranking-shared-styles')) { stylesInjected = true; return; }
    const style = document.createElement('style');
    style.id = 'ranking-shared-styles';
    style.textContent =
      '.rank-side-layout{display:flex;flex-wrap:wrap;gap:30px;align-items:flex-start;justify-content:center;max-width:660px;}' +
      '.rank-side-left{flex:1 1 300px;display:flex;flex-direction:column;align-items:center;gap:14px;min-width:260px;}' +
      '.rank-side-right{flex:0 1 260px;min-width:220px;padding-top:2px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px 14px 12px;}' +
      '.rank-box{width:100%;max-width:280px;margin:2px auto 0;text-align:left;}' +
      '.rank-box .rank-title{font-size:11.5px;opacity:.6;letter-spacing:.12em;text-align:center;margin-bottom:8px;}' +
      '.rank-list{list-style:none;display:flex;flex-direction:column;gap:5px;max-height:196px;overflow-y:auto;padding:0 2px 0 0;margin:0;}' +
      '.rank-list li{display:flex;align-items:baseline;gap:8px;font-size:13px;padding:6px 12px;border-radius:8px;background:rgba(255,255,255,.06);}' +
      '.rank-list li.is-latest{background:rgba(255,217,138,.2);box-shadow:inset 0 0 0 1px rgba(255,217,138,.55);}' +
      '.rank-list .rk-pos{width:1.5em;font-weight:700;opacity:.65;flex-shrink:0;}' +
      '.rank-list li:nth-child(1) .rk-pos{color:#ffd98a;opacity:1;}' +
      '.rank-list .rk-val{font-weight:700;flex-grow:1;font-variant-numeric:tabular-nums;}' +
      '.rank-list .rk-meta{font-size:11px;opacity:.6;flex-shrink:0;max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.rank-list .rk-empty{font-size:12.5px;opacity:.5;text-align:center;padding:10px 0;list-style:none;}' +
      '.rank-name-btn{display:block;width:100%;margin-top:8px;padding:6px 0 2px;font:inherit;font-size:11px;color:inherit;opacity:.55;background:transparent;border:none;border-top:1px solid rgba(255,255,255,.12);cursor:pointer;text-align:center;}' +
      '.rank-name-btn:hover{opacity:.9;}';
    document.head.appendChild(style);
    stylesInjected = true;
  }

  function renderList(gameKey, opts) {
    opts = opts || {};
    ensureStyles();
    const entries = read(gameKey);
    const unit = opts.unit || '';
    const formatValue = opts.formatValue || function (v) { return v + unit; };
    const formatMeta = opts.formatMeta || function (e) { return escapeHtml(e.name || DEFAULT_NAME); };
    const highlightDate = opts.highlightDate || null;

    let rows;
    if (!entries.length) {
      rows = '<li class="rk-empty">まだ記録がありません。一番のりを目指せ!</li>';
    } else {
      rows = entries.map(function (e, i) {
        const cls = highlightDate && e.date === highlightDate ? ' class="is-latest"' : '';
        return '<li' + cls + '>' +
          '<span class="rk-pos">' + (i + 1) + '</span>' +
          '<span class="rk-val">' + formatValue(e.value) + '</span>' +
          '<span class="rk-meta">' + formatMeta(e) + '</span>' +
          '</li>';
      }).join('');
    }

    const currentName = escapeHtml(getPlayerName() || DEFAULT_NAME);
    const nameBtn = opts.showNameControl === false ? '' :
      '<button type="button" class="rank-name-btn" data-rank-namebtn>いまの名前: ' + currentName + '(変更する)</button>';

    return '<div class="rank-box"><div class="rank-title">' +
      (opts.title || 'ランキング TOP ' + (opts.maxEntries || DEFAULT_MAX)) +
      '</div><ol class="rank-list">' + rows + '</ol>' + nameBtn + '</div>';
  }

  function mount(container, gameKey, opts) {
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return;
    el.innerHTML = renderList(gameKey, opts);
    const btn = el.querySelector('[data-rank-namebtn]');
    if (btn) {
      btn.addEventListener('click', function () {
        changeName();
        mount(container, gameKey, opts);
      });
    }
  }

  // For games without a numeric score (e.g. a duel): a simple local win/loss tally.
  function recordTally(gameKey, won) {
    const key = TALLY_PREFIX + gameKey;
    const t = safeParse(localStorage.getItem(key), null) || { wins: 0, losses: 0, streak: 0, bestStreak: 0 };
    if (won) {
      t.wins++;
      t.streak++;
      t.bestStreak = Math.max(t.bestStreak, t.streak);
    } else {
      t.losses++;
      t.streak = 0;
    }
    try { localStorage.setItem(key, JSON.stringify(t)); } catch (e) {}
    return t;
  }

  function getTally(gameKey) {
    const key = TALLY_PREFIX + gameKey;
    return safeParse(localStorage.getItem(key), null) || { wins: 0, losses: 0, streak: 0, bestStreak: 0 };
  }

  window.Ranking = {
    record: record,
    getAll: getAll,
    getBest: getBest,
    renderList: renderList,
    mount: mount,
    formatDate: formatDate,
    formatTime: formatTime,
    recordTally: recordTally,
    getTally: getTally,
    getPlayerName: getPlayerName,
    setPlayerName: setPlayerName,
    changeName: changeName,
    escapeHtml: escapeHtml
  };
})();
