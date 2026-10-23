/* ============================================================
   8비트 사운드 엔진 (효과음 + 배경음악)
   - 음원 파일 없이 Web Audio API로 칩튠을 직접 합성한다.
   - public/assets/sounds/ 에 mp3를 넣어두면 그 파일을 우선 재생한다.
   - 효과음과 배경음악을 각각 따로 끄고 켤 수 있고,
     그 설정은 브라우저에 저장되어 새로고침해도 유지된다.
   ============================================================ */
window.RetroAudio = (function () {
  'use strict';

  var SFX_KEY = 'bq_sfx';
  var BGM_KEY = 'bq_bgm';
  var sfxOn = load(SFX_KEY);
  var bgmOn = load(BGM_KEY);

  var ctx = null;
  var bgmTimer = null;   // 합성 배경음 스텝 타이머
  var bgmEl = null;      // mp3 재생용 <audio>
  var currentTrack = null;

  function load(key) {
    try { return localStorage.getItem(key) !== 'off'; } catch (e) { return true; }
  }
  function save(key, v) {
    try { localStorage.setItem(key, v ? 'on' : 'off'); } catch (e) { /* 무시 */ }
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
      setTimeout(function () { if (sfxOn) tone(n, dur || 0.12, type, vol); }, i * (gap || 90));
    });
  }

  // ── 효과음 ─────────────────────────────────────────
  var SFX = {
    key: function () { tone('C6', 0.04, 'square', 0.04); },
    del: function () { tone('E4', 0.05, 'square', 0.04); },
    select: function () { seq(['G5', 'C6'], 60, 0.07); },
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
      seq(['C5', 'C5', 'C5', 'C5', 'E5', 'G5', 'C6', 'G5', 'C6'], 130, 0.2, 'square', 0.08);
      [0, 130, 260, 390].forEach(function (d) {
        setTimeout(function () { if (sfxOn) tone('C3', 0.2, 'triangle', 0.09); }, d);
      });
    },
  };

  function sfx(name) {
    if (!sfxOn) return;
    var fn = SFX[name];
    if (fn) fn();
  }

  // ── 배경음악 ───────────────────────────────────────
  // null = 쉼표. 8분음표 단위 시퀀스.
  var TRACKS = {
    // 대기실 — 밝고 통통 튀는 분위기.
    // 다장조 + 요즘 팝에서 가장 많이 쓰는 코드 진행(C - G - Am - F).
    // 예전에는 가단조라 으스스하게 들렸다.
    lobby: {
      file: '/assets/sounds/lobby.mp3',
      bpm: 116,
      vol: 0.035,
      lead: ['C5', 'E5', 'G5', 'E5', 'B4', 'D5', 'G5', 'D5',
             'A4', 'C5', 'E5', 'C5', 'F4', 'A4', 'C5', 'A4'],
      bass: ['C3', null, 'G2', null, 'G2', null, 'D3', null,
             'A2', null, 'E3', null, 'F2', null, 'C3', null],
    },
    // 문제 푸는 중 — 다장조 C - F - G - C.
    // 문제 집중을 방해하지 않게 음을 띄엄띄엄 두고 음량도 가장 작게 잡았다.
    game: {
      file: '/assets/sounds/game.mp3',
      bpm: 120,
      vol: 0.03,
      lead: ['E5', null, 'G5', null, 'F5', null, 'A5', null,
             'G5', null, 'B5', null, 'G5', null, 'E5', null],
      bass: ['C3', null, 'G2', null, 'F2', null, 'C3', null,
             'G2', null, 'D3', null, 'C3', null, 'G2', null],
    },
    // 최종 결과 — 승리의 행진곡
    victory: {
      file: '/assets/sounds/victory.mp3',
      bpm: 128,
      vol: 0.045,
      lead: ['C5', 'E5', 'G5', 'C6', 'B5', 'G5', 'E5', 'G5',
             'A5', 'C6', 'E6', 'C6', 'G5', 'E5', 'C5', null],
      bass: ['C3', null, 'G2', null, 'E3', null, 'G2', null,
             'F3', null, 'C3', null, 'G2', null, 'C3', null],
    },
  };

  function startSynth(name) {
    var track = TRACKS[name];
    if (!track) return;
    var stepMs = 60000 / track.bpm / 2;
    var step = 0;
    bgmTimer = setInterval(function () {
      if (!bgmOn) return;
      var l = track.lead[step % track.lead.length];
      var b = track.bass[step % track.bass.length];
      if (l) tone(l, stepMs * 0.85 / 1000, 'square', track.vol);
      // 베이스를 짧게 끊어 통통 튀게 한다.
      // 예전처럼 길게 깔면 저음이 웅- 하고 끌려서 음산하게 들린다.
      if (b) tone(b, stepMs * 0.7 / 1000, 'triangle', track.vol * 1.15);
      step += 1;
    }, stepMs);
  }

  /**
   * 배경음악 재생 — mp3가 있으면 mp3, 없으면 합성음.
   * 이미 같은 곡이 흐르고 있으면 끊지 않고 그대로 둔다.
   */
  function playBgm(name) {
    if (currentTrack === name && (bgmTimer || bgmEl)) return;
    stopBgm();
    currentTrack = name;
    if (!bgmOn || !TRACKS[name]) return;
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
  function setSfx(v) {
    sfxOn = !!v;
    save(SFX_KEY, sfxOn);
    updateToggles();
  }

  function setBgm(v) {
    bgmOn = !!v;
    save(BGM_KEY, bgmOn);
    var track = currentTrack;
    if (!bgmOn) {
      stopBgm();
      currentTrack = track; // 다시 켤 때 이어서 틀 수 있도록 기억해 둔다
    } else if (track) {
      currentTrack = null;
      playBgm(track);
    }
    updateToggles();
  }

  var sfxBtn = null;
  var bgmBtn = null;
  function updateToggles() {
    if (sfxBtn) {
      sfxBtn.textContent = sfxOn ? '🔊 효과음' : '🔇 효과음';
      sfxBtn.classList.toggle('off', !sfxOn);
    }
    if (bgmBtn) {
      bgmBtn.textContent = bgmOn ? '🎵 배경음악' : '🔇 배경음악';
      bgmBtn.classList.toggle('off', !bgmOn);
    }
  }

  /** 화면 우측 상단에 효과음 / 배경음악 on-off 버튼을 붙인다 */
  function mountToggle() {
    if (sfxBtn) return;
    var box = document.createElement('div');
    box.className = 'sound-box';

    sfxBtn = document.createElement('button');
    sfxBtn.className = 'sound-toggle';
    sfxBtn.type = 'button';
    sfxBtn.id = 'sfx-toggle';
    sfxBtn.addEventListener('click', function () {
      setSfx(!sfxOn);
      if (sfxOn) sfx('select');
    });

    bgmBtn = document.createElement('button');
    bgmBtn.className = 'sound-toggle';
    bgmBtn.type = 'button';
    bgmBtn.id = 'bgm-toggle';
    bgmBtn.addEventListener('click', function () { setBgm(!bgmOn); });

    box.appendChild(sfxBtn);
    box.appendChild(bgmBtn);
    document.body.appendChild(box);
    updateToggles();
  }

  return {
    sfx: sfx,
    tone: tone,
    playBgm: playBgm,
    stopBgm: stopBgm,
    setSfx: setSfx,
    setBgm: setBgm,
    mountToggle: mountToggle,
    isSfxOn: function () { return sfxOn; },
    isBgmOn: function () { return bgmOn; },
    currentTrack: function () { return currentTrack; },
  };
})();
