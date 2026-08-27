/* 참여자(플레이어) 화면 로직 */
(function () {
  'use strict';

  var socket = io();
  var $ = function (id) { return document.getElementById(id); };
  var state = {
    roomCode: null,
    playerId: null,
    answer: '',
    toBase: 10,
    offset: 0,
    endsAt: 0,
    limit: 20,
    raf: null,
    submitted: false,
  };

  function show(name) {
    ['code', 'nick', 'lobby', 'question', 'wait', 'result', 'final'].forEach(function (s) {
      $('s-' + s).classList.toggle('active', s === name);
    });
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.style.display = 'none'; }, 3000);
  }

  // ── 사운드 (audio.js 공용 엔진) ─────────────────────
  var audio = window.RetroAudio;
  var sfx = function (n) { audio.sfx(n); };
  audio.mountToggle(); // 우측 상단 소리 on/off 버튼

  // ── 정답 픽셀 파티클 ────────────────────────────────
  function particles() {
    var colors = ['#00ff41', '#00e5ff', '#ffe600', '#ff00a0'];
    for (var i = 0; i < 28; i++) {
      (function (i) {
        var el = document.createElement('div');
        el.className = 'particle';
        el.style.background = colors[i % colors.length];
        el.style.left = (45 + Math.random() * 10) + 'vw';
        el.style.top = '35vh';
        document.body.appendChild(el);
        var dx = (Math.random() - 0.5) * 500;
        var dy = -150 - Math.random() * 250;
        var t0 = performance.now();
        (function step(t) {
          var s = (t - t0) / 1000;
          if (s > 1.2) { el.remove(); return; }
          el.style.transform = 'translate(' + dx * s + 'px,' + (dy * s + 700 * s * s) + 'px)';
          requestAnimationFrame(step);
        })(t0);
      })(i);
    }
  }

  // ── 입장 ────────────────────────────────────────────
  var params = new URLSearchParams(location.search);
  var preCode = (params.get('code') || '').replace(/\D/g, '').slice(0, 4);
  if (preCode) $('in-code').value = preCode;

  $('in-code').addEventListener('input', function (e) {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });

  $('btn-code').addEventListener('click', function () {
    var code = $('in-code').value.trim();
    if (code.length !== 4) return toast('방 코드 4자리를 입력하세요.');
    state.roomCode = code;
    show('nick');
    $('in-nick').focus();
    sfx('join');
  });

  $('in-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btn-code').click();
  });
  $('in-nick').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btn-nick').click();
  });

  $('btn-nick').addEventListener('click', function () {
    var nick = $('in-nick').value.trim();
    if (!nick) return toast('닉네임을 입력하세요.');
    socket.emit('player:join', { roomCode: state.roomCode, nickname: nick });
    sfx('join');
  });

  socket.on('player:joined', function (d) {
    state.playerId = d.playerId;
    state.roomCode = d.roomCode;
    sessionStorage.setItem('bq_player', JSON.stringify({ id: d.playerId, room: d.roomCode }));
    $('me-nick').textContent = d.nickname;
    $('me-avatar').textContent = d.avatar;
    if (d.phase !== 'question') show('lobby');
  });

  socket.on('room:players', function (d) { $('lobby-count').textContent = d.count; });
  socket.on('game:reset', function () { audio.stopBgm(); show('lobby'); });
  socket.on('error:msg', function (d) {
    toast(d.message);
    if (!state.playerId) show('code');
  });

  // ── 키패드 ──────────────────────────────────────────
  var KEYS = {
    2: { cols: 'cols-2', keys: ['0', '1'] },
    10: { cols: 'cols-3', keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] },
    16: { cols: 'cols-4', keys: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'] },
  };

  function buildKeypad(toBase) {
    var conf = KEYS[toBase];
    var pad = $('keypad');
    pad.className = 'keypad ' + conf.cols;
    pad.innerHTML = '';
    conf.keys.forEach(function (k) {
      var b = document.createElement('button');
      b.className = 'key' + (/[A-F]/.test(k) ? ' hex' : '');
      b.textContent = k;
      b.addEventListener('click', function () { pushKey(k); });
      pad.appendChild(b);
    });
    var del = document.createElement('button');
    del.className = 'key del';
    del.textContent = '⌫ 지우기';
    del.addEventListener('click', function () {
      state.answer = state.answer.slice(0, -1);
      renderAnswer();
      sfx('del');
    });
    del.style.gridColumn = 'span ' + (toBase === 2 ? 2 : toBase === 10 ? 3 : 4);
    pad.appendChild(del);
  }

  function pushKey(k) {
    if (state.submitted) return;
    if (state.answer.length >= 16) return;
    state.answer += k;
    renderAnswer();
    sfx('key');
  }

  function renderAnswer() {
    $('answer-box').innerHTML = escapeHtml(state.answer) + '<span class="caret">_</span>';
  }

  // 노트북 사용자를 위한 물리 키보드 입력
  document.addEventListener('keydown', function (e) {
    if (!$('s-question').classList.contains('active')) return;
    var k = e.key.toUpperCase();
    if (k === 'ENTER') { submit(); return; }
    if (k === 'BACKSPACE') {
      state.answer = state.answer.slice(0, -1);
      renderAnswer();
      e.preventDefault();
      return;
    }
    var allowed = KEYS[state.toBase].keys;
    if (allowed.indexOf(k) >= 0) pushKey(k);
  });

  $('btn-submit').addEventListener('click', submit);

  function submit() {
    if (state.submitted) return;
    if (!state.answer) return toast('답을 입력하세요.');
    state.submitted = true;
    socket.emit('player:answer', { answer: state.answer });
  }

  socket.on('player:submitted', function (d) {
    $('wait-answer').textContent = d.answer;
    stopTimer();
    show('wait');
    sfx('submit');
  });

  // ── 타이머 ──────────────────────────────────────────
  function stopTimer() { if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; } }
  function runTimer() {
    stopTimer();
    var bar = $('q-timerbar');
    var fill = bar.querySelector('i');
    var num = $('q-timer');
    var lastSec = -1;
    function tick() {
      var remain = Math.max(0, state.endsAt - (Date.now() + state.offset));
      var ratio = Math.max(0, Math.min(1, remain / (state.limit * 1000)));
      fill.style.width = (ratio * 100).toFixed(1) + '%';
      var sec = Math.ceil(remain / 1000);
      if (sec !== lastSec) { num.textContent = sec; lastSec = sec; }
      var cls = ratio > 0.5 ? '' : ratio > 0.25 ? 'warn' : 'danger';
      bar.className = 'timerbar ' + cls;
      num.className = 'mono timernum ' + cls;
      if (remain > 0) state.raf = requestAnimationFrame(tick);
    }
    tick();
  }

  // ── 문제 수신 ───────────────────────────────────────
  socket.on('game:question', function (q) {
    state.offset = q.serverNow - Date.now();
    state.endsAt = q.endsAt;
    state.limit = q.timeLimitSec;
    state.toBase = q.toBase;
    state.answer = '';
    state.submitted = false;
    $('q-index').textContent = q.index + ' / ' + q.total;
    $('q-prompt').textContent = q.prompt;
    $('q-value').textContent = q.sourceValue;
    $('q-base').textContent = baseName(q.fromBase) + ' → ' + baseName(q.toBase) + ' (' + q.difficultyLabel + ')';
    renderAnswer();
    buildKeypad(q.toBase);
    show('question');
    runTimer();
    audio.stopBgm();
    sfx('question');
  });

  function baseName(b) { return b === 2 ? '2진법' : b === 10 ? '10진법' : '16진법'; }

  // ── 결과 ────────────────────────────────────────────
  socket.on('player:result', function (d) {
    stopTimer();
    var panel = $('result-panel');
    panel.className = 'panel center ' + (d.isCorrect ? 'glow-green' : 'glow-red');
    $('verdict').className = 'verdict ' + (d.isCorrect ? 'ok' : 'no');
    $('verdict').textContent = d.isCorrect ? '⭕ 정답!' : (d.answered ? '❌ 오답' : '⏰ 시간초과');
    $('gain').textContent = '+' + d.gained + ' 점';
    var combo = $('combo');
    if (d.isCorrect && d.streak >= 2) {
      combo.style.display = '';
      combo.textContent = 'COMBO x' + d.streak + '!';
    } else {
      combo.style.display = 'none';
    }
    $('res-answer').textContent = d.correctAnswer;
    $('res-explain').textContent = d.explanation;
    $('res-score').textContent = d.score;
    $('res-rank').textContent = d.rank;
    $('res-total').textContent = d.totalPlayers;
    show('result');
    if (d.isCorrect) { sfx('correct'); particles(); } else { sfx('wrong'); }
  });

  socket.on('player:final', function (d) {
    $('f-rank').textContent = d.rank + '위';
    $('f-total').textContent = d.totalPlayers;
    $('f-score').textContent = d.score + ' 점';
    var ul = $('f-top3');
    ul.innerHTML = '';
    d.top3.forEach(function (p) {
      var li = document.createElement('li');
      if (p.id === state.playerId) li.className = 'me';
      li.innerHTML = '<span class="rk">' + p.rank + '위</span>' +
        '<span class="nm">' + p.avatar + ' ' + escapeHtml(p.nickname) + '</span>' +
        '<span class="sc">' + p.score + '</span>';
      ul.appendChild(li);
    });
    show('final');
    if (d.rank <= 3) particles();
    // 우승 팡파레 → 이어서 승리 배경음악 반복 재생
    sfx('victory');
    setTimeout(function () { audio.playBgm('victory'); }, 1600);
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── 재접속 ──────────────────────────────────────────
  var saved = sessionStorage.getItem('bq_player');
  if (saved) {
    try {
      var s = JSON.parse(saved);
      if (s && s.id && s.room) {
        state.roomCode = s.room;
        socket.emit('player:join', { roomCode: s.room, playerId: s.id });
      }
    } catch (e) { /* 무시 */ }
  }
  socket.on('connect', function () {
    if (state.playerId && state.roomCode) {
      socket.emit('player:join', { roomCode: state.roomCode, playerId: state.playerId });
    }
  });
})();
