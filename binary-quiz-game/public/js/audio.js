/* ============================================================
   8비트 사운드 엔진 (효과음 + 배경음악)
   - 음원 파일 없이 Web Audio API로 칩튠을 직접 합성한다.
   - public/assets/sounds/ 에 mp3를 넣어두면 그 파일을 우선 재생한다.
   - 음소거 상태는 브라우저에 저장되어 새로고침해도 유지된다.
   ============================================================ */
window.RetroAudio = (function () {
  'use strict';

  var STORE_KEY = 'bq_sound';
  var enabled = load();
  var ctx = null;
  var bgmTimer = null;   // 합성 배경음 스텝 타이머
  var bgmEl = null;      // mp3 재생용 <audio>
  var currentTrack = null;

  function load() {
    try { return localStorage.getItem(STORE_KEY) !== 'off'; } catch (e) { return true; }
  }
  function save(v) {
    try { localStorage.setItem(STORE_KEY, v ? 'on' : 'off'); } catch (e) { /* 무시 */ }
  }

  function ac() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ── 음이름 → 주파수 ────────────────────────────────
  var STEP = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
  function freq(note) {
    if (typeof note === 'number') return note;
    var m = /^([A-G]#?)(-?\d)$/.exec(note);
    if (!m) return 440;
    var midi = (parseInt(m[2], 10) + 1) * 12 + STEP[m[1]];
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** 한 음 재생 */
  function tone(note, dur, type, vol) {
    if (!enabled) return;
    var c = ac();
    if (!c) return;
    try {
      var o = c.createOscillator();
      var g = c.createGain();
      o.type = type || 'square';
      o.frequency.value = freq(note);
      var v = vol == null ? 0.06 : vol;
      var t = c.currentTime;
      // 8비트 느낌을 위해 짧은 어택 + 빠른 감쇠
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(v, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.12));
      o.connect(g);
      g.connect(c.destination);
      o.start(t);
      o.stop(t + (dur || 0.12) + 0.02);
    } catch (e) { /* 소리 실패는 게임 진행에 영향 없음 */ }
  }

  function seq(notes, gap, dur, type, vol) {
    notes.forEach(function (n, i) {
      setTimeout(function () { tone(n, dur || 0.12, type, vol); }, i * (gap || 90));
    });
  }

  // ── 효과음 ─────────────────────────────────────────
  var SFX = {
    key: function () { tone('C6', 0.04, 'square', 0.04); },
    del: function () { tone('E4', 0.05, 'square', 0.04); },
    submit: function () { seq(['E5', 'A5'], 70, 0.09); },
    join: function () { seq(['A5', 'E6'], 70, 0.08, 'square', 0.05); },
    tick: function () { tone('C7', 0.04, 'square', 0.035); },
    question: function () { seq(['E5', 'G5'], 80, 0.1); },
    reveal: function () { seq(['G5', 'C6'], 90, 0.14); },
    correct: function () { seq(['C5', 'E5', 'G5', 'C6'], 70, 0.11, 'square', 0.07); },
    wrong: function () { seq(['E4', 'C4', 'A3'], 110, 0.2, 'sawtooth', 0.06); },
    start: function () { seq(['C5', 'E5', 'G5', 'C6'], 100, 0.13, 'square', 0.07); },
    // 우승자 발표 팡파레
    victory: function () {
      seq(['C5', 'C5', 'C5', 'C5', 'E5', 'G5', 'C6', 'G5', 'C6'],
        130, 0.2, 'square', 0.08);
      [0, 130, 260, 390].forEach(function (d, i) {
        setTimeout(function () { tone(['C3', 'C3', 'C3', 'C3'][i], 0.2, 'triangle', 0.09); }, d);
      });
    },
  };

  function sfx(name) {
    if (!enabled) return;
    var fn = SFX[name];
    if (fn) fn();
  }

  // ── 배경음악 ───────────────────────────────────────
  // null = 쉼표. 8분음표 단위 시퀀스.
  var TRACKS = {
    victory: {
      file: '/assets/sounds/victory.mp3',
      bpm: 128,
      lead: ['C5', 'E5', 'G5', 'C6', 'B5', 'G5', 'E5', 'G5',
             'A5', 'C6', 'E6', 'C6', 'G5', 'E5', 'C5', null],
      bass: ['C3', null, 'G2', null, 'E3', null, 'G2', null,
             'F3', null, 'C3', null, 'G2', null, 'C3', null],
    },
    lobby: {
      file: '/assets/sounds/lobby.mp3',
      bpm: 104,
      lead: ['E5', null, 'G5', null, 'A5', null, 'G5', null,
             'E5', null, 'D5', null, 'E5', null, null, null],
      bass: ['A2', null, null, null, 'E2', null, null, null,
             'F2', null, null, null, 'G2', null, null, null],
    },
  };

  function startSynth(name) {
    var track = TRACKS[name];
    if (!track) return;
    var stepMs = 60000 / track.bpm / 2;
    var step = 0;
    bgmTimer = setInterval(function () {
      if (!enabled) return;
      var l = track.lead[step % track.lead.length];
      var b = track.bass[step % track.bass.length];
      if (l) tone(l, stepMs * 0.85 / 1000, 'square', 0.045);
      if (b) tone(b, stepMs * 1.7 / 1000, 'triangle', 0.05);
      step += 1;
    }, stepMs);
  }

  /** 배경음악 재생 — mp3가 있으면 mp3, 없으면 합성음 */
  function playBgm(name) {
    stopBgm();
    currentTrack = name;
    if (!enabled || !TRACKS[name]) return;
    var usedFallback = false;
    var fallback = function () {
      if (usedFallback) return;
      usedFallback = true;
      bgmEl = null;
      startSynth(name);
    };
    try {
      var el = new Audio(TRACKS[name].file);
      el.loop = true;
      el.volume = 0.35;
      el.addEventListener('error', fallback);
      var p = el.play();
      if (p && p.catch) p.catch(fallback);
      bgmEl = el;
    } catch (e) {
      fallback();
    }
  }

  function stopBgm() {
    if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
    if (bgmEl) { try { bgmEl.pause(); } catch (e) { /* 무시 */ } bgmEl = null; }
    currentTrack = null;
  }

  // ── 켜기/끄기 ──────────────────────────────────────
  function setEnabled(v) {
    enabled = !!v;
    save(enabled);
    var track = currentTrack;
    if (!enabled) {
      // 재생 중이던 곡은 기억해 두고 멈춘다
      stopBgm();
      currentTrack = track;
    } else if (track) {
      playBgm(track);
    }
    updateToggle();
  }

  function toggle() { setEnabled(!enabled); }

  var btn = null;
  function updateToggle() {
    if (!btn) return;
    btn.textContent = enabled ? '🔊 소리 ON' : '🔇 소리 OFF';
    btn.classList.toggle('off', !enabled);
    btn.setAttribute('aria-pressed', String(enabled));
  }

  /** 화면 우측 상단에 소리 on/off 버튼을 붙인다 */
  function mountToggle() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'sound-toggle';
    btn.className = 'sound-toggle';
    btn.type = 'button';
    btn.addEventListener('click', function () {
      toggle();
      if (enabled) sfx('join'); // 켤 때 소리로 확인
    });
    document.body.appendChild(btn);
    updateToggle();
    return btn;
  }

  return {
    sfx: sfx,
    tone: tone,
    playBgm: playBgm,
    stopBgm: stopBgm,
    setEnabled: setEnabled,
    toggle: toggle,
    mountToggle: mountToggle,
    isEnabled: function () { return enabled; },
  };
})();
