/*!
 * au12 Arcade SDK v1 — https://github.com/au12/arcade
 * MIT License.
 *
 * Drop this file into a game and load it with a plain script tag:
 *
 *   <script src="arcade.js" data-game="totem"></script>
 *
 * Then report what happens. Every call is safe to make whether or not the
 * game is running inside the arcade: outside it, they quietly do nothing.
 *
 *   await Arcade.ready;                       // resolves with the player, or null
 *   Arcade.player                             // { id, name, initials, color, ... } or null
 *   Arcade.score(123450)                      // a finished game's score ("score" board)
 *   Arcade.score(42, { board: 'stars' })      // another board
 *   Arcade.result('win', { meta: { vs: 'bot' } })
 *   Arcade.achieve('special')                 // one of the game's catalog achievements
 *   Arcade.status('playing')                  // menu | playing | paused | over
 *   Arcade.invite('https://swipe.example.com/r/lucky-riffle-42', 'Join my table')
 *   Arcade.exit()                             // back to the arcade
 *   Arcade.on('pause', fn); Arcade.on('resume', fn)
 *   Arcade.storageKey('mygame.save')          // "mygame.save" or "mygame.save@<player id>"
 *
 * Two ways in:
 *  - Embedded: the arcade opens the game in a frame. The SDK says hello to the
 *    page above it, which answers with the player; scores go up as messages
 *    and the arcade posts them.
 *  - Direct: the game is opened on its own. If the game's server publishes
 *    /arcade.json ({ "url": "https://arcade.example.com" }), the SDK asks the
 *    arcade which player this browser plays as (a same-site cookie) and posts
 *    scores straight to it.
 */
(function (root) {
  'use strict';
  if (root.Arcade && root.Arcade.version) return;

  var VERSION = '1.0.0';
  var PROTOCOL = 1;
  var script = typeof document !== 'undefined' ? document.currentScript : null;
  var listeners = {};
  var pending = {};
  var rid = 0;
  var arcadeOrigin = null;
  var arcadeUrl = null;
  var session = null;
  var beatTimer = null;
  var lastActivity = 0;
  var readyResolve;

  var api = {
    version: VERSION,
    mode: 'pending', // pending → embedded | direct | off
    player: null,
    game: null,
    kiosk: false,
    arcade: null, // { name, url } once connected
    ready: null,
  };
  api.ready = new Promise(function (resolve) {
    readyResolve = resolve;
  });

  function emit(type, data) {
    var list = (listeners[type] || []).slice();
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](data);
      } catch (e) {
        if (root.console) console.error('[arcade]', e);
      }
    }
  }

  function settle(mode) {
    if (api.mode !== 'pending' && api.mode !== mode) return;
    api.mode = mode;
    readyResolve(api.player);
  }

  // ───────────── embedded: talking to the arcade page ─────────────

  var framed = false;
  try {
    framed = root.parent && root.parent !== root;
  } catch (e) {
    framed = true;
  }

  function post(type, data) {
    if (!framed) return;
    var msg = { __arcade: PROTOCOL, type: type, sdk: VERSION };
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) msg[k] = data[k];
    try {
      root.parent.postMessage(msg, arcadeOrigin || '*');
    } catch (e) {
      /* the parent went away */
    }
  }

  function request(type, data) {
    if (api.mode === 'embedded') {
      return new Promise(function (resolve) {
        var id = ++rid;
        var timer = setTimeout(function () {
          delete pending[id];
          resolve(null);
        }, 10000);
        pending[id] = function (res) {
          clearTimeout(timer);
          resolve(res);
        };
        var payload = {};
        for (var k in data) payload[k] = data[k];
        payload.rid = id;
        post(type, payload);
      });
    }
    if (api.mode === 'direct') return direct(type, data);
    if (api.mode === 'pending') {
      return api.ready.then(function () {
        return api.mode === 'off' ? null : request(type, data);
      });
    }
    return Promise.resolve(null);
  }

  function onMessage(ev) {
    var m = ev.data;
    if (!m || m.__arcade !== PROTOCOL || ev.source !== root.parent) return;
    if (arcadeOrigin && ev.origin !== arcadeOrigin) return;
    switch (m.type) {
      case 'welcome':
        arcadeOrigin = ev.origin;
        api.arcade = m.arcade || null;
        api.kiosk = Boolean(m.kiosk);
        var changed = JSON.stringify(api.player) !== JSON.stringify(m.player || null);
        api.player = m.player || null;
        settle('embedded');
        if (changed) emit('player', api.player);
        emit('connect', { arcade: api.arcade, player: api.player });
        break;
      case 'player':
        api.player = m.player || null;
        emit('player', api.player);
        break;
      case 'ack':
        if (pending[m.rid]) {
          var fn = pending[m.rid];
          delete pending[m.rid];
          fn(m.ok ? m.data || {} : null);
        }
        break;
      case 'pause':
        emit('pause', {});
        break;
      case 'resume':
        emit('resume', {});
        break;
      case 'mute':
        emit('mute', { muted: Boolean(m.muted) });
        break;
    }
  }

  // ───────────── direct: the game on its own, posting to the arcade ─────────────

  function direct(type, data) {
    var path;
    var body = { game: api.game, session: session };
    if (type === 'score') {
      path = '/api/v1/scores';
      body.board = data.board;
      body.value = data.value;
      body.meta = data.meta;
    } else if (type === 'result') {
      path = '/api/v1/results';
      body.outcome = data.outcome;
      body.meta = data.meta;
    } else if (type === 'achieve') {
      path = '/api/v1/achievements';
      body.id = data.id;
    } else return Promise.resolve(null);
    return send(path, body);
  }

  function send(path, body, keepalive) {
    if (!arcadeUrl || typeof fetch !== 'function') return Promise.resolve(null);
    // text/plain keeps these "simple" requests: no preflight, and they still
    // go out with keepalive when the page is closing.
    return fetch(arcadeUrl + path, {
      method: 'POST',
      credentials: 'include',
      keepalive: Boolean(keepalive),
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body),
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .catch(function () {
        return null;
      });
  }

  function startDirect() {
    var cfgUrl = (script && script.getAttribute('data-config')) || '/arcade.json';
    if (typeof fetch !== 'function') return settle('off');
    fetch(cfgUrl, { cache: 'no-store', credentials: 'omit' })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (cfg) {
        var url = cfg && typeof cfg.url === 'string' ? cfg.url.replace(/\/+$/, '') : '';
        if (!/^https?:\/\//.test(url)) return settle('off');
        arcadeUrl = url;
        return fetch(url + '/api/v1/me', { credentials: 'include', cache: 'no-store' })
          .then(function (r) {
            return r.ok ? r.json() : null;
          })
          .then(function (me) {
            if (!me || !me.player) return settle('off');
            api.player = me.player;
            api.arcade = { name: cfg.name || 'Arcade', url: url };
            settle('direct');
            emit('player', api.player);
            emit('connect', { arcade: api.arcade, player: api.player });
            if (api.game) beginSession();
          });
      })
      .catch(function () {
        settle('off');
      });
  }

  function beginSession() {
    if (session || api.mode !== 'direct') return;
    send('/api/v1/sessions', { game: api.game }).then(function (s) {
      if (!s || !s.id) return;
      session = s.id;
      beatTimer = setInterval(function () {
        if (document.visibilityState === 'visible') send('/api/v1/sessions/' + session + '/beat', {});
      }, 60000);
    });
  }

  function endSession() {
    if (!session) return;
    send('/api/v1/sessions/' + session + '/end', {}, true);
    session = null;
    if (beatTimer) clearInterval(beatTimer);
    beatTimer = null;
  }

  // ───────────── the public calls ─────────────

  function cleanMeta(meta) {
    if (!meta || typeof meta !== 'object') return undefined;
    try {
      var s = JSON.stringify(meta);
      return s.length > 1900 ? undefined : JSON.parse(s);
    } catch (e) {
      return undefined;
    }
  }

  /** Configure the SDK (optional when the script tag has data-game). */
  api.init = function (opts) {
    opts = opts || {};
    if (opts.game) api.game = String(opts.game);
    if (api.mode === 'direct' && api.game) beginSession();
    return api.ready;
  };

  api.on = function (type, fn) {
    (listeners[type] = listeners[type] || []).push(fn);
    if (type === 'player' && api.mode !== 'pending') {
      try {
        fn(api.player);
      } catch (e) {
        /* ignore */
      }
    }
    return function () {
      api.off(type, fn);
    };
  };

  api.off = function (type, fn) {
    listeners[type] = (listeners[type] || []).filter(function (f) {
      return f !== fn;
    });
  };

  /** A finished game's score. Resolves with the arcade's verdict (rank, record, tickets) or null. */
  api.score = function (value, opts) {
    opts = opts || {};
    var v = Number(value);
    if (!isFinite(v)) return Promise.resolve(null);
    return request('score', { board: opts.board || 'score', value: v, meta: cleanMeta(opts.meta) });
  };

  /** A finished match: 'win', 'loss' or 'draw'. */
  api.result = function (outcome, opts) {
    opts = opts || {};
    if (outcome !== 'win' && outcome !== 'loss' && outcome !== 'draw') return Promise.resolve(null);
    return request('result', { outcome: outcome, meta: cleanMeta(opts.meta) });
  };

  /** One of the game's own achievements (its id in the arcade catalog). */
  api.achieve = function (id) {
    return request('achieve', { id: String(id) });
  };

  /** What the game is doing, so the arcade knows when it's safe to interrupt. */
  api.status = function (state) {
    if (api.mode === 'embedded' || (api.mode === 'pending' && framed)) post('status', { state: String(state) });
  };

  /** A link other people can use to join (shown as a QR code on the cabinet). */
  api.invite = function (url, label) {
    if (framed) post('invite', { url: url ? String(url) : null, label: label ? String(label) : '' });
  };

  /** Ask the arcade to close the game. */
  api.exit = function () {
    if (api.mode === 'embedded') post('exit', {});
  };

  /** Ask the arcade to show its menu (as the cabinet's menu button does). */
  api.menu = function () {
    if (api.mode === 'embedded') post('menu', {});
  };

  /** A storage key per player, so each family member keeps their own progress. */
  api.storageKey = function (base) {
    return api.player && api.player.id ? base + '@' + api.player.id : base;
  };

  // ───────────── start up ─────────────

  if (script && script.getAttribute('data-game')) api.game = script.getAttribute('data-game');

  if (typeof window !== 'undefined') {
    window.addEventListener('message', onMessage);
    if (framed) {
      // Say hello until someone answers; if nobody does, try going direct.
      var tries = 0;
      var hello = function () {
        if (api.mode !== 'pending') return;
        if (tries++ >= 6) return startDirect();
        post('hello', { game: api.game, url: location.href });
        setTimeout(hello, 250);
      };
      hello();
    } else {
      startDirect();
    }

    // Let the arcade know someone is still playing (its idle timer can't see in here).
    var activity = function () {
      var now = Date.now();
      if (api.mode === 'embedded' && now - lastActivity > 4000) {
        lastActivity = now;
        post('activity', {});
      }
    };
    window.addEventListener('keydown', function (e) {
      activity();
      // F9 is the arcade's menu key (a cabinet's menu button sends it too).
      if (e.code === 'F9' && api.mode === 'embedded') {
        e.preventDefault();
        e.stopImmediatePropagation();
        post('menu', {});
      }
    }, true);
    window.addEventListener('pointerdown', activity, true);
    window.addEventListener('touchstart', activity, { capture: true, passive: true });
    window.addEventListener('pagehide', endSession);
  }

  root.Arcade = api;
})(typeof window !== 'undefined' ? window : globalThis);
