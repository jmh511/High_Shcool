'use strict';
/**
 * 문제 생성 / 채점 / 풀이 설명 로직 (문제 은행 없이 매 게임 랜덤 생성)
 */

const TYPES = {
  bin2dec: { from: 2, to: 10 },
  dec2bin: { from: 10, to: 2 },
  bin2hex: { from: 2, to: 16 },
  hex2bin: { from: 16, to: 2 },
  dec2hex: { from: 10, to: 16 },
  hex2dec: { from: 16, to: 10 },
};

const BASE_NAME = { 2: '2진법', 10: '10진법', 16: '16진법' };

// 난이도별 값 범위 + 출제 유형 풀(pool). 같은 유형을 여러 번 넣어 가중치를 준다.
const DIFFICULTY = {
  easy: {
    label: '★ 쉬움',
    range: [8, 15], // 4비트: 2진수 4자리, 16진수 1자리
    pool: ['bin2dec', 'bin2dec', 'dec2bin', 'dec2bin', 'dec2hex', 'hex2dec'],
  },
  medium: {
    label: '★★ 보통',
    range: [16, 255], // 8비트: 16진수 2자리
    pool: ['bin2dec', 'dec2bin', 'bin2hex', 'hex2bin', 'dec2hex', 'hex2dec'],
  },
  hard: {
    label: '★★★ 어려움',
    range: [16, 255],
    // 10진수를 거치지 않는 2↔16 직접 변환 비중을 높인다
    pool: ['bin2hex', 'bin2hex', 'bin2hex', 'hex2bin', 'hex2bin', 'hex2bin', 'dec2bin', 'hex2dec'],
  },
};

// 출제 범위 모드 — 관리자가 진법을 골라서 출제할 수 있다.
const MODES = {
  all: {
    label: '전체 (2·10·16진법)',
    types: ['bin2dec', 'dec2bin', 'bin2hex', 'hex2bin', 'dec2hex', 'hex2dec'],
  },
  binary: {
    label: '2진법만 (2 ↔ 10)',
    types: ['bin2dec', 'dec2bin'],
  },
  hex: {
    label: '16진법 위주',
    types: ['dec2hex', 'hex2dec', 'bin2hex', 'hex2bin'],
  },
};

/** 난이도 풀에서 선택한 모드에 해당하는 유형만 남긴다 */
function poolFor(conf, mode) {
  const allowed = (MODES[mode] || MODES.all).types;
  const filtered = conf.pool.filter((t) => allowed.indexOf(t) >= 0);
  // 한 방향만 남으면 단조로워지므로 해당 모드의 전체 유형을 쓴다
  return new Set(filtered).size >= 2 ? filtered : allowed.slice();
}

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

function toBase(n, base) {
  return n.toString(base).toUpperCase();
}

/**
 * 4지선다 보기 만들기.
 * 아무 숫자나 넣지 않고, 학생들이 실제로 하는 실수를 오답으로 만든다.
 *  - 1 차이 (계산 실수)
 *  - 2배 / 절반 (자릿수를 하나 밀린 경우)
 *  - 정답의 두 자리를 바꾼 형태
 *  - 정답을 거꾸로 쓴 형태 (자리값 순서를 반대로 읽은 경우)
 */
function makeChoices(n, base, correct) {
  const seen = new Set([correct]);
  const wrong = [];
  const add = (s) => {
    if (!s || seen.has(s)) return;
    seen.add(s);
    wrong.push(s);
  };
  const addValue = (v) => {
    if (!Number.isFinite(v) || v < 1) return;
    add(toBase(Math.floor(v), base));
  };

  addValue(n + 1);
  addValue(n - 1);
  addValue(n * 2);
  addValue(Math.floor(n / 2));

  // 정답의 인접한 두 자리를 바꿔치기
  if (correct.length >= 2) {
    const i = randInt(0, correct.length - 2);
    const swapped = (correct.slice(0, i) + correct[i + 1] + correct[i] + correct.slice(i + 2)).replace(/^0+/, '');
    add(swapped);
  }
  // 정답을 거꾸로
  add(correct.split('').reverse().join('').replace(/^0+/, ''));

  // 그래도 부족하면 근처 값으로 채운다
  let guard = 0;
  while (wrong.length < 3 && guard < 60) {
    addValue(n + randInt(-9, 9));
    guard += 1;
  }

  // 정답과 자릿수가 비슷한 오답을 우선 쓴다 (자릿수가 확 다르면 답이 티가 난다)
  shuffle(wrong).sort((a, b) => Math.abs(a.length - correct.length) - Math.abs(b.length - correct.length));
  return shuffle([correct].concat(wrong.slice(0, 3)));
}

/** 문제별 출제 형식(직접 입력 / 4지선다) 배분 */
function planFormats(total, format) {
  if (format === 'input' || format === 'choice') return new Array(total).fill(format);
  // mixed — 절반씩 섞는다
  const arr = [];
  for (let i = 0; i < total; i += 1) arr.push(i % 2 === 0 ? 'input' : 'choice');
  return shuffle(arr);
}

/** 난이도별 문제 수 계산 (합계가 total이 되도록 보정) */
function planDifficulties(total, mix) {
  const order = ['easy', 'medium', 'hard'];
  const raw = order.map((k) => (mix[k] || 0) * total);
  const counts = raw.map((v) => Math.floor(v));
  let rest = total - counts.reduce((a, b) => a + b, 0);
  // 소수점이 큰 순서대로 나머지 배분
  const frac = raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f);
  let k = 0;
  while (rest > 0) {
    counts[frac[k % 3].i] += 1;
    rest -= 1;
    k += 1;
  }
  const plan = [];
  order.forEach((d, i) => {
    for (let j = 0; j < counts[i]; j += 1) plan.push(d);
  });
  return plan; // 쉬움 → 보통 → 어려움 순서 (앞쉬움/뒤어려움 자동 상승)
}

function makeQuestion(difficulty, id, timeLimitSec, seen, mode, format) {
  const conf = DIFFICULTY[difficulty];
  const pool = poolFor(conf, mode);
  // 2진법만 모드의 어려움 단계는 항상 8자리가 나오도록 범위를 좁힌다
  const range = mode === 'binary' && difficulty === 'hard' ? [128, 255] : conf.range;
  let type;
  let n;
  let key;
  let guard = 0;
  do {
    type = pick(pool);
    n = randInt(range[0], range[1]);
    key = `${type}:${n}`;
    guard += 1;
  } while (seen.has(key) && guard < 200);
  seen.add(key);

  const { from, to } = TYPES[type];
  const sourceValue = toBase(n, from);
  const correctAnswer = toBase(n, to);

  return {
    id,
    difficulty,
    difficultyLabel: conf.label,
    type,
    fromBase: from,
    toBase: to,
    prompt: `${BASE_NAME[from]} 수를 ${BASE_NAME[to]}으로 변환하시오`,
    sourceValue,
    correctAnswer,
    value: n,
    timeLimitSec,
    format: format === 'choice' ? 'choice' : 'input',
    choices: format === 'choice' ? makeChoices(n, to, correctAnswer) : null,
    explanation: explain(type, n, sourceValue, correctAnswer),
  };
}

function generateQuestions(settings) {
  const { totalQuestions, timeLimitSec, hardTimeLimitSec, difficultyMix, questionMode, answerFormat } = settings;
  const plan = planDifficulties(totalQuestions, difficultyMix);
  const formats = planFormats(plan.length, answerFormat);
  const seen = new Set();
  return plan.map((d, i) =>
    makeQuestion(d, `q${i + 1}`, d === 'hard' ? hardTimeLimitSec : timeLimitSec, seen, questionMode, formats[i])
  );
}

/** 정답 공개 시 함께 보여줄 간단한 풀이 과정 */
function explain(type, n, src, ans) {
  const binTerms = (bin) => {
    const len = bin.length;
    return bin
      .split('')
      .map((b, i) => `${b}×${Math.pow(2, len - 1 - i)}`)
      .join(' + ');
  };
  const hexTerms = (hex) => {
    const len = hex.length;
    return hex
      .split('')
      .map((h, i) => `${parseInt(h, 16)}×${Math.pow(16, len - 1 - i)}`)
      .join(' + ');
  };
  const nibbles = (bin) => {
    const padded = bin.padStart(Math.ceil(bin.length / 4) * 4, '0');
    return padded.match(/.{4}/g) || [padded];
  };

  switch (type) {
    case 'bin2dec':
      return `${src} = ${binTerms(src)} = ${ans}`;
    case 'dec2bin':
      return `${src} = ${binTerms(ans)} → ${ans}`;
    case 'hex2dec':
      return `${src} = ${hexTerms(src)} = ${ans}`;
    case 'dec2hex':
      return `${src} = ${hexTerms(ans)} → ${ans}`;
    case 'bin2hex': {
      const nb = nibbles(src);
      return `${nb.join(' ')} → ${nb.map((b) => toBase(parseInt(b, 2), 16)).join('')} (4자리씩 끊어서 변환)`;
    }
    case 'hex2bin': {
      const parts = src.split('').map((h) => `${h}=${parseInt(h, 16).toString(2).padStart(4, '0')}`);
      const joined = src.split('').map((h) => parseInt(h, 16).toString(2).padStart(4, '0')).join('');
      const tail = joined === ans ? ans : `${joined} → ${ans} (앞의 0 생략)`;
      return `${parts.join(', ')} → ${tail}`;
    }
    default:
      return `${src} → ${ans}`;
  }
}

const PATTERN = { 2: /^[01]+$/, 10: /^[0-9]+$/, 16: /^[0-9A-F]+$/ };

/**
 * 정답 판정
 * - 10진법 답: 정수 값으로 비교 ("011" == "11")
 * - 2/16진법 답: 앞자리 0 없는 표준 형태만 정답 (allowLeadingZeros 설정 시 허용)
 * - 16진법은 대소문자 무시
 */
function checkAnswer(question, rawAnswer, allowLeadingZeros) {
  const a = String(rawAnswer == null ? '' : rawAnswer).trim().toUpperCase();
  if (!a) return false;
  const base = question.toBase;
  if (!PATTERN[base].test(a)) return false;
  if (base === 10) return parseInt(a, 10) === question.value;
  if (a === question.correctAnswer) return true;
  if (allowLeadingZeros && parseInt(a, base) === question.value) return true;
  return false;
}

module.exports = { generateQuestions, checkAnswer, DIFFICULTY, MODES, BASE_NAME };
