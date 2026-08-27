/* 관리자(호스트) 화면 로직 */
(function () {
  'use strict';

  var socket = io();
  var $ = function (id) { return document.getElementById(id); };
  var state = { roomCode: null, offset: 0, endsAt: 0, limit: 20, raf: null, players: [] };

  // ── 화면 전환 ────────────────────────────────────────
  function show(name) {
    ['setup', 'lobby', 'question', 'reveal', 'board', 'final'].forEach(function (s) {
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

  // ── 사운드 (audio.js 공용 엔진) ──────────────────────
  var audio = window.RetroAudio;
  var sfx = function (n) { audio.sfx(n); };
  audio.mountToggle(); // 우측 상단 소리 on/off 버튼

  // ── 방 만들기 ────────────────────────────────────────
  $('btn-create').addEventListener('click', function () {
    if (!$('opt-sound').checked) { audio.setSfx(false); audio.setBgm(false); }
    socket.emit('host:create', {
      settings: {
        questionMode: $('opt-mode').value,
        answerFormat: $('opt-format').value,
        totalQuestions: +$('opt-count').value,
        timeLimitSec: +$('opt-time').value,
        hardTimeLimitSec: +$('opt-hardtime').value,
        difficultyMix: {
          easy: +$('opt-easy').value,
          medium: +$('opt-medium').value,
          hard: +$('opt-hard').value,
        },
        allowLeadingZeros: $('opt-zeros').checked,
        comboBonus: $('opt-combo').checked,
      },
    });
  });

  socket.on('room:created', function (d) {
    state.roomCode = d.roomCode;
    sessionStorage.setItem('hostRoom', d.roomCode);
    var url = location.origin + '/play?code=' + d.roomCode;
    $('room-code').textContent = d.roomCode;
    $('join-url').textContent = url;
    $('lobby-setting').textContent =
      d.settings.totalQuestions + '문제 / ' + d.settings.timeLimitSec + '초';

    // QR (인터넷 연결 시에만 표시)
    var wrap = $('qr-wrap');
    wrap.innerHTML = '';
    var img = new Image();
    img.width = 160; img.height = 160;
    img.alt = 'QR';
    img.style.imageRendering = 'pixelated';
    img.style.border = '4px solid #fff';
    img.onerror = function () { wrap.innerHTML = ''; };
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(url);
    wrap.appendChild(img);

    show('lobby');
    audio.playBgm('lobby'); // 대기실 배경음
  });

  // ── 대기실 ──────────────────────────────────────────
  socket.on('room:players', function (d) {
    state.players = d.players;
    $('lobby-count').textContent = d.count;
    var box = $('lobby-players');
    box.innerHTML = '';
    d.players.forEach(function (p) {
      var el = document.createElement('div');
      el.className = 'pcard' + (p.connected ? '' : ' off');
      el.textContent = p.avatar + ' ' + p.nickname;
      box.appendChild(el);
    });
    var btn = $('btn-start');
    var ok = d.count >= 1;
    btn.disabled = !ok;
    btn.classList.toggle('disabled', !ok);
    btn.textContent = ok ? '게임 시작 (' + d.count + '명)' : '게임 시작 (참여자 1명 이상)';
    if (d.count > 0) sfx('join');
  });

  $('btn-start').addEventListener('click', function () {
    socket.emit('host:start');
    sfx('start');
  });

  ['btn-skip', 'btn-skip2', 'btn-skip3'].forEach(function (id) {
    $(id).addEventListener('click', function () { socket.emit('host:next'); });
  });

  $('btn-restart').addEventListener('click', function () {
    audio.stopBgm();
    socket.emit('host:restart');
  });

  socket.on('game:reset', function () { audio.playBgm('lobby'); show('lobby'); });

  // ── 타이머 ──────────────────────────────────────────
  function stopTimer() {
    if (state.raf) { cancelAnimationFrame(state.raf); state.raf = null; }
  }
  function runTimer() {
    stopTimer();
    var bar = $('q-timerbar');
    var fill = bar.querySelector('i');
    var num = $('q-timer');
    var lastSec = -1;
    function tick() {
      var now = Date.now() + state.offset;
      var remain = Math.max(0, state.endsAt - now);
      var ratio = Math.max(0, Math.min(1, remain / (state.limit * 1000)));
      fill.style.width = (ratio * 100).toFixed(1) + '%';
      var sec = Math.ceil(remain / 1000);
      if (sec !== lastSec) {
        num.textContent = sec;
        if (sec <= 5 && sec > 0) sfx('tick');
        lastSec = sec;
      }
      var cls = ratio > 0.5 ? '' : ratio > 0.25 ? 'warn' : 'danger';
      bar.className = 'timerbar ' + cls;
      num.className = 'timernum ' + cls;
      if (remain > 0) state.raf = requestAnimationFrame(tick);
    }
    tick();
  }

  // ── 문제 진행 ───────────────────────────────────────
  socket.on('game:question', function (q) {
    state.offset = q.serverNow - Date.now();
    state.endsAt = q.endsAt;
    state.limit = q.timeLimitSec;
    $('q-index').textContent = q.index + ' / ' + q.total;
    $('q-diff').textContent = q.difficultyLabel;
    $('q-progress').style.width = ((q.index - 1) / q.total * 100) + '%';
    $('q-prompt').textContent = q.prompt;
    $('q-value').textContent = q.sourceValue;
    $('q-base').textContent = base(q.fromBase) + ' → ' + base(q.toBase);
    $('q-format').textContent = q.format === 'choice' ? '4지선다' : '직접 입력';

    // 4지선다면 프로젝터 화면에도 보기를 띄운다
    var box = $('q-choices');
    if (q.format === 'choice' && q.choices) {
      box.innerHTML = '';
      q.choices.forEach(function (c, i) {
        var el = document.createElement('div');
        el.className = 'choice';
        el.innerHTML = '<span class="mark">' + (i + 1) + '</span><span>' + escapeHtml(c) + '</span>';
        box.appendChild(el);
      });
      box.style.display = '';
    } else {
      box.style.display = 'none';
    }

    show('question');
    runTimer();
    audio.playBgm('game'); // 문제 푸는 동안 깔리는 배경음
    sfx('question');
  });

  function base(b) { return b === 2 ? '2진법' : b === 10 ? '10진법' : '16진법'; }

  socket.on('game:submitCount', function (d) {
    $('q-submitted').textContent = d.submitted + ' / ' + d.total + ' 명 제출';
  });

  socket.on('game:reveal', function (d) {
    stopTimer();
    $('r-prompt').textContent = d.prompt;
    $('r-source').textContent = d.sourceValue;
    $('r-answer').textContent = d.correctAnswer;
    $('r-explain').textContent = d.explanation;
    $('r-correct').textContent = d.correctCount;
    $('r-total').textContent = d.totalPlayers;
    var pct = d.totalPlayers ? (d.correctCount / d.totalPlayers * 100) : 0;
    $('r-bar').style.width = pct.toFixed(0) + '%';
    show('reveal');
    sfx('reveal');
  });

  socket.on('game:leaderboard', function (d) {
    var ul = $('board-list');
    ul.innerHTML = '';
    d.top.forEach(function (p) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="rk">' + p.rank + '위</span>' +
        '<span class="nm">' + p.avatar + ' ' + escapeHtml(p.nickname) + '</span>' +
        '<span class="sc">' + p.score + '</span>';
      ul.appendChild(li);
    });
    $('board-next').textContent = '다음 문제 ' + d.nextIndex + ' / ' + d.total + ' 준비 중...';
    show('board');
    sfx('reveal');
  });

  socket.on('game:final', function (d) {
    // 우승자
    var winner = d.ranking[0];
    $('winner-name').textContent = winner ? winner.avatar + ' ' + winner.nickname : '-';
    $('winner-score').textContent = (winner ? winner.score : 0) + ' 점';

    // 시상대
    var pod = $('podium');
    pod.innerHTML = '';
    var order = [1, 0, 2]; // 2위 - 1위 - 3위 순으로 배치
    order.forEach(function (i) {
      var p = d.ranking[i];
      if (!p) return;
      var div = document.createElement('div');
      div.className = 'p p' + (i + 1);
      div.innerHTML = '<div class="av">' + p.avatar + '</div>' +
        '<div class="who">' + escapeHtml(p.nickname) + '<br /><span class="mono yellow">' + p.score + '</span></div>' +
        '<div class="bar">' + (i + 1) + '</div>';
      pod.appendChild(div);
    });

    var ul = $('final-list');
    ul.innerHTML = '';
    d.ranking.forEach(function (p) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="rk">' + p.rank + '위</span>' +
        '<span class="nm">' + p.avatar + ' ' + escapeHtml(p.nickname) + '</span>' +
        '<span class="sc">' + p.score + '</span>';
      ul.appendChild(li);
    });

    var st = $('final-stats');
    st.innerHTML = '';
    (d.stats || []).forEach(function (s) {
      var pct = s.total ? Math.round(s.correctCount / s.total * 100) : 0;
      var row = document.createElement('div');
      row.style.marginBottom = '12px';
      row.innerHTML = '<div class="sub">' + s.index + '. ' + escapeHtml(s.prompt) +
        ' <span class="mono yellow">' + s.sourceValue + ' → ' + s.correctAnswer + '</span>' +
        ' <b class="' + (pct >= 50 ? 'green' : 'red') + '">' + pct + '%</b></div>' +
        '<div class="statbar"><i style="width:' + pct + '%;background:' + (pct >= 50 ? 'var(--green)' : 'var(--red)') + '"></i></div>';
      st.appendChild(row);
    });

    show('final');
    // 우승 팡파레 → 이어서 승리 배경음악 반복 재생
    sfx('victory');
    setTimeout(function () { audio.playBgm('victory'); }, 1600);
  });

  socket.on('error:msg', function (d) { toast(d.message); });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 새로고침 시 기존 방에 다시 붙기 시도
  var saved = sessionStorage.getItem('hostRoom');
  if (saved) socket.emit('host:resume', { roomCode: saved });
})();
