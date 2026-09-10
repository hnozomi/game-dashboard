(function () {
  // ============================================================
  //  みんなで番付を共有するしくみ(登録・サーバー不要)
  //
  //  だれか1台が bandai.html を開くと「番台」になり、4桁の合言葉が出ます。
  //  あそぶ人はダッシュボードでその合言葉を一度入れるだけ。
  //  以降どのゲームで遊んでも、記録が番台に送られ、
  //  番台から全員ぶんの番付が返ってきて各自の画面に並びます。
  //
  //  合言葉を入れていなければ、これまで通りこの端末だけの記録になります。
  // ============================================================
  var PEER_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js';
  var PEER_PREFIX = 'yorunoyuugijou-bandai-';

  var PREFIX = 'yorunoyuugijou:rank:';
  var TALLY_PREFIX = 'yorunoyuugijou:tally:';
  var NAME_KEY = 'yorunoyuugijou:playerName';
  var BANDAI_KEY = 'yorunoyuugijou:bandai';   // 合言葉(4桁)
  var SHARED_KEY = 'yorunoyuugijou:shared';   // 番台からもらった番付
  var OUTBOX_KEY = 'yorunoyuugijou:outbox';   // まだ番台に届いていない自分の記録
  var DEVICE_KEY = 'yorunoyuugijou:deviceId';
  var DEFAULT_MAX = 10;
  var DEFAULT_NAME = '名無しさん';

  // 値が小さいほど上位のゲーム。載っていないものは大きいほど上位。
  var SORT_DIRS = { 'tsukiyo-no-shosai': 'asc' };
  var CONNECT_TIMEOUT_MS = 12000;
  var RETRY_MIN_MS = 4000;
  var RETRY_MAX_MS = 30000;

  function safeParse(raw, fallback) {
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function lsDel(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  function read(gameKey) {
    return safeParse(lsGet(PREFIX + gameKey), []) || [];
  }

  function write(gameKey, entries) {
    lsSet(PREFIX + gameKey, JSON.stringify(entries));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function getPlayerName() {
    return lsGet(NAME_KEY) || null;
  }

  // Pass an empty/blank name to clear it.
  function setPlayerName(name) {
    var trimmed = name && String(name).trim() ? String(name).trim().slice(0, 14) : '';
    if (trimmed) lsSet(NAME_KEY, trimmed);
    else lsDel(NAME_KEY);
    return trimmed || null;
  }

  // The dashboard hands off the current player's name via `?name=...` on each game link.
  // Capture it into the shared store as soon as this script loads, so it's ready before
  // the game's own script runs (both for the start-screen ranking and for later record()s).
  // 合言葉も同じように `?bandai=1234` で引き継ぐ。
  (function captureFromUrl() {
    try {
      var q = new URLSearchParams(window.location.search);
      var fromUrl = q.get('name');
      if (fromUrl && fromUrl.trim()) setPlayerName(fromUrl);
      var code = q.get('bandai');
      if (code && /^\d{4}$/.test(code.trim())) lsSet(BANDAI_KEY, code.trim());
    } catch (e) {}
  })();

  // Explicit, user-triggered rename (e.g. the "名前を変更" button) — not called automatically.
  function changeName() {
    var input = null;
    try { input = window.prompt('ランキングに表示する名前を入力してください', getPlayerName() || ''); } catch (e) { input = null; }
    if (input === null) return getPlayerName() || DEFAULT_NAME; // cancelled
    return setPlayerName(input) || DEFAULT_NAME;
  }

  // ---- 端末を見分けるID(記録の重複をふせぐためだけに使う) ----
  function deviceId() {
    var id = lsGet(DEVICE_KEY);
    if (!id) {
      id = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
      lsSet(DEVICE_KEY, id);
    }
    return id;
  }

  function makeEntryId(date) {
    return deviceId() + '-' + date.toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }

  // ---- 並び順 ----
  function sortDirFor(gameKey) { return SORT_DIRS[gameKey] || 'desc'; }

  function comparatorFor(gameKey) {
    var asc = sortDirFor(gameKey) === 'asc';
    return function (a, b) {
      if (a.value !== b.value) return asc ? a.value - b.value : b.value - a.value;
      return (a.date || 0) - (b.date || 0); // 同点なら先に出した人が上
    };
  }

  // 共有前に保存された古い記録には id がないので、内容から鍵を作る
  function entryKey(e) {
    return e.id || (e.name + '|' + e.value + '|' + e.date);
  }

  function dedupe(entries) {
    var seen = {}, out = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || typeof e.value !== 'number') continue;
      var k = entryKey(e);
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(e);
    }
    return out;
  }

  // ---- 合言葉 ----
  function getBandaiCode() { return lsGet(BANDAI_KEY) || null; }

  function setBandaiCode(code) {
    var c = code && String(code).trim();
    if (c && /^\d{4}$/.test(c)) {
      if (c !== getBandaiCode()) {
        lsSet(BANDAI_KEY, c);
        lsDel(SHARED_KEY);   // 別の番台の記録が混ざらないように捨てる
        disconnect();
      }
      connect();
      return c;
    }
    lsDel(BANDAI_KEY);
    lsDel(SHARED_KEY);
    disconnect();
    refreshAll();
    return null;
  }

  // ---- 番付の保管 ----
  function sharedScores() {
    return safeParse(lsGet(SHARED_KEY), []) || [];
  }

  function setSharedScores(scores) {
    lsSet(SHARED_KEY, JSON.stringify(scores));
  }

  function outbox() {
    return safeParse(lsGet(OUTBOX_KEY), []) || [];
  }

  function enqueue(entry) {
    var q = outbox();
    q.push(entry);
    lsSet(OUTBOX_KEY, JSON.stringify(q.slice(-50)));
  }

  // 番台から返ってきた番付に載っているものだけ、送信済みとみなして取り除く
  function reconcileOutbox(board) {
    var landed = {};
    for (var i = 0; i < board.length; i++) if (board[i] && board[i].id) landed[board[i].id] = 1;
    var rest = outbox().filter(function (e) { return !landed[e.id]; });
    lsSet(OUTBOX_KEY, JSON.stringify(rest));
  }

  // この端末の記録 + 未送信ぶん + 番台の番付 をまとめて並べる
  function mergedEntries(gameKey) {
    var mine = read(gameKey);
    var pending = outbox().filter(function (e) { return e.game === gameKey; });
    var theirs = sharedScores().filter(function (e) { return e.game === gameKey; });
    var all = dedupe(mine.concat(pending, theirs));
    all.sort(comparatorFor(gameKey));
    return all;
  }

  // ---- 番台との通信 ----
  var peer = null;
  var conn = null;
  var state = 'idle';   // idle | connecting | open | lost | absent
  var retryMs = RETRY_MIN_MS;
  var retryTimer = null;
  var connectTimer = null;
  var peerLibPromise = null;

  function loadPeerLib() {
    if (typeof window.Peer === 'function') return Promise.resolve();
    if (peerLibPromise) return peerLibPromise;
    peerLibPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PEER_LIB;
      s.onload = function () { resolve(); };
      s.onerror = function () { peerLibPromise = null; reject(new Error('peerjs load failed')); };
      document.head.appendChild(s);
    });
    return peerLibPromise;
  }

  function clearTimers() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  }

  function teardown() {
    clearTimers();
    if (conn) { try { conn.close(); } catch (e) {} conn = null; }
    if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
  }

  function disconnect() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    teardown();
    state = 'idle';
  }

  function scheduleRetry() {
    if (retryTimer || !getBandaiCode()) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  function fail(nextState) {
    teardown();
    state = nextState;
    refreshAll();
    scheduleRetry();
  }

  function connect() {
    var code = getBandaiCode();
    if (!code) return;
    if (state === 'connecting' || state === 'open') return;
    if (typeof RTCPeerConnection !== 'function') { state = 'unsupported'; refreshAll(); return; }

    state = 'connecting';
    refreshAll();

    loadPeerLib().then(function () {
      if (getBandaiCode() !== code) return;   // 待っている間に合言葉が変わった
      var p = new window.Peer();
      peer = p;

      connectTimer = setTimeout(function () {
        if (state !== 'open') fail('lost');
      }, CONNECT_TIMEOUT_MS);

      p.on('open', function () {
        if (peer !== p) return;
        var c = p.connect(PEER_PREFIX + code, { reliable: true });
        conn = c;

        c.on('open', function () {
          if (conn !== c) return;
          clearTimers();
          state = 'open';
          retryMs = RETRY_MIN_MS;
          sendPending();
          refreshAll();
        });

        c.on('data', function (msg) {
          if (!msg || msg.type !== 'board' || !Array.isArray(msg.scores)) return;
          setSharedScores(msg.scores);
          reconcileOutbox(msg.scores);
          refreshAll();
        });

        c.on('close', function () {
          if (conn !== c) return;
          fail('lost');
        });

        c.on('error', function () {
          if (conn !== c) return;
          fail('lost');
        });
      });

      p.on('error', function (err) {
        if (peer !== p) return;
        // 'peer-unavailable' = その合言葉の番台がひらいていない
        fail(err && err.type === 'peer-unavailable' ? 'absent' : 'lost');
      });

      p.on('disconnected', function () {
        if (peer !== p || state !== 'open') return;
        fail('lost');
      });
    }, function () {
      fail('lost');
    });
  }

  function sendPending() {
    if (!conn || !conn.open) return;
    // 空でも送る(番台に最新の番付を返してもらうため)
    try { conn.send({ type: 'submit', scores: outbox() }); } catch (e) {}
  }

  function statusText() {
    if (!getBandaiCode()) return 'この端末だけの記録';
    if (state === 'unsupported') return 'この環境では共有できません';
    if (state === 'open') return outbox().length ? '番台に送っています…' : 'みんなの番付と共有中 (' + getBandaiCode() + ')';
    if (state === 'connecting') return '番台につないでいます…';
    if (state === 'absent') return '⚠ 番台がひらいていません';
    return '⚠ 番台にとどきません';
  }

  // ---- 描画 ----
  var stylesInjected = false;
  function ensureStyles() {
    if (stylesInjected || document.getElementById('ranking-shared-styles')) { stylesInjected = true; return; }
    var style = document.createElement('style');
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
      '.rank-list li.is-mine .rk-meta{opacity:.85;font-weight:500;}' +
      '.rank-list .rk-pos{width:1.5em;font-weight:700;opacity:.65;flex-shrink:0;}' +
      '.rank-list li:nth-child(1) .rk-pos{color:#ffd98a;opacity:1;}' +
      '.rank-list .rk-val{font-weight:700;flex-grow:1;font-variant-numeric:tabular-nums;}' +
      '.rank-list .rk-meta{font-size:11px;opacity:.6;flex-shrink:0;max-width:9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.rank-list .rk-empty{font-size:12.5px;opacity:.5;text-align:center;padding:10px 0;list-style:none;}' +
      '.rank-status{font-size:10.5px;opacity:.45;text-align:center;margin-top:8px;letter-spacing:.05em;}' +
      '.rank-name-btn{display:block;width:100%;margin-top:6px;padding:6px 0 2px;font:inherit;font-size:11px;color:inherit;opacity:.55;background:transparent;border:none;border-top:1px solid rgba(255,255,255,.12);cursor:pointer;text-align:center;}' +
      '.rank-name-btn:hover{opacity:.9;}';
    document.head.appendChild(style);
    stylesInjected = true;
  }

  function renderList(gameKey, opts) {
    opts = opts || {};
    ensureStyles();
    var maxEntries = opts.maxEntries || DEFAULT_MAX;
    var entries = mergedEntries(gameKey).slice(0, maxEntries);
    var unit = opts.unit || '';
    var formatValue = opts.formatValue || function (v) { return v + unit; };
    var formatMeta = opts.formatMeta || function (e) { return escapeHtml(e.name || DEFAULT_NAME); };
    var highlightDate = opts.highlightDate || null;
    var me = deviceId();

    var rows;
    if (!entries.length) {
      rows = '<li class="rk-empty">まだ記録がありません。一番のりを目指せ!</li>';
    } else {
      rows = entries.map(function (e, i) {
        var cls = [];
        if (highlightDate && e.date === highlightDate) cls.push('is-latest');
        if (e.id && e.id.indexOf(me + '-') === 0) cls.push('is-mine');
        return '<li' + (cls.length ? ' class="' + cls.join(' ') + '"' : '') + '>' +
          '<span class="rk-pos">' + (i + 1) + '</span>' +
          '<span class="rk-val">' + formatValue(e.value) + '</span>' +
          '<span class="rk-meta">' + formatMeta(e) + '</span>' +
          '</li>';
      }).join('');
    }

    var currentName = escapeHtml(getPlayerName() || DEFAULT_NAME);
    var nameBtn = opts.showNameControl === false ? '' :
      '<button type="button" class="rank-name-btn" data-rank-namebtn>いまの名前: ' + currentName + '(変更する)</button>';

    return '<div class="rank-box"><div class="rank-title">' +
      (opts.title || 'ランキング TOP ' + maxEntries) +
      '</div><ol class="rank-list">' + rows + '</ol>' +
      '<div class="rank-status">' + escapeHtml(statusText()) + '</div>' + nameBtn + '</div>';
  }

  // 番台から番付が届いたら、表示中のランキングを描きなおす
  var mounts = [];
  var listeners = [];

  function renderInto(m) {
    if (!m.el.isConnected) return;
    m.el.innerHTML = renderList(m.gameKey, m.opts);
    var btn = m.el.querySelector('[data-rank-namebtn]');
    if (btn) {
      btn.addEventListener('click', function () {
        changeName();
        refreshAll();
      });
    }
  }

  function refreshAll() {
    mounts = mounts.filter(function (m) { return m.el.isConnected; });
    mounts.forEach(renderInto);
    listeners.forEach(function (fn) {
      try { fn(state, statusText()); } catch (e) {}
    });
  }

  function mount(container, gameKey, opts) {
    var el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) return;
    var m = { el: el, gameKey: gameKey, opts: opts || {} };
    var replaced = false;
    for (var i = 0; i < mounts.length; i++) {
      if (mounts[i].el === el) { mounts[i] = m; replaced = true; break; }
    }
    if (!replaced) mounts.push(m);
    renderInto(m);   // まずは手元の記録ですぐ表示
    connect();       // 番台の番付は届きしだい上書き
  }

  // Adds one score to the game's ranking list, keeping only the top `maxEntries`.
  // 返り値はこれまで通り「この端末の」記録にもとづく結果(じこベスト表示用)。
  function record(gameKey, value, opts) {
    opts = opts || {};
    var sortDir = opts.sortDir || sortDirFor(gameKey);
    var maxEntries = opts.maxEntries || DEFAULT_MAX;
    var name = opts.name !== undefined ? opts.name : (getPlayerName() || DEFAULT_NAME);
    var date = Date.now();
    var entries = read(gameKey);
    var entry = {
      id: makeEntryId(date),
      game: gameKey,
      value: value,
      date: date,
      name: name,
      meta: opts.meta || null
    };
    entries.push(entry);
    entries.sort(function (a, b) {
      return sortDir === 'asc' ? a.value - b.value : b.value - a.value;
    });
    var trimmed = entries.slice(0, maxEntries);
    write(gameKey, trimmed);

    enqueue(entry);
    if (state === 'open') sendPending(); else connect();

    var idx = trimmed.indexOf(entry);
    return {
      entries: trimmed,
      entry: entry,
      rank: idx === -1 ? null : idx + 1,
      isNewBest: trimmed.length > 0 && trimmed[0] === entry,
      best: trimmed.length ? trimmed[0].value : value
    };
  }

  function getAll(gameKey) { return mergedEntries(gameKey); }

  // じこベスト表示に使われるので、こちらはこの端末の記録だけを見る。
  function getBest(gameKey, fallback) {
    var entries = read(gameKey);
    return entries.length ? entries[0].value : (fallback === undefined ? 0 : fallback);
  }

  function formatDate(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // For games without a numeric score (e.g. a duel): a simple local win/loss tally.
  function recordTally(gameKey, won) {
    var key = TALLY_PREFIX + gameKey;
    var t = safeParse(lsGet(key), null) || { wins: 0, losses: 0, streak: 0, bestStreak: 0 };
    if (won) {
      t.wins++;
      t.streak++;
      t.bestStreak = Math.max(t.bestStreak, t.streak);
    } else {
      t.losses++;
      t.streak = 0;
    }
    lsSet(key, JSON.stringify(t));
    return t;
  }

  function getTally(gameKey) {
    return safeParse(lsGet(TALLY_PREFIX + gameKey), null) || { wins: 0, losses: 0, streak: 0, bestStreak: 0 };
  }

  // 画面に戻ってきたとき・通信が回復したときはつなぎ直す
  window.addEventListener('online', function () { retryMs = RETRY_MIN_MS; connect(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { retryMs = RETRY_MIN_MS; connect(); }
  });
  window.addEventListener('pagehide', disconnect);

  if (getBandaiCode()) connect();

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
    escapeHtml: escapeHtml,
    getBandaiCode: getBandaiCode,
    setBandaiCode: setBandaiCode,
    shareState: function () { return getBandaiCode() ? state : 'off'; },
    statusText: statusText,
    onChange: function (fn) {
      listeners.push(fn);
      try { fn(state, statusText()); } catch (e) {}
    },
    PEER_PREFIX: PEER_PREFIX
  };
})();
