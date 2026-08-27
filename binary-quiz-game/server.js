'use strict';
/**
 * 진법 변환 퀴즈 게임 — Express + Socket.IO 서버
 *  - 방(room) 상태는 서버 메모리에만 보관 (DB 없음, 수업 1회성 세션)
 *  - 문제는 quiz.js 에서 매 게임 랜덤 생성
 */
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { generateQuestions, checkAnswer, MODES } = require('./quiz');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.redirect('/play.html'));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));

const server = http.createServer(app);
const io = new Server(server);

// ───────────────────────── 상수 ─────────────────────────
const REVEAL_MS = 9000; // 정답 공개 + 순위 화면 유지 시간
const GRACE_MS = 700; // 네트워크 지연 여유
const AVATARS = ['👾', '🤖', '👻', '🐱', '🦊', '🐸', '🐙', '🦖'];

const DEFAULT_SETTINGS = {
  totalQuestions: 12,
  timeLimitSec: 20,
  hardTimeLimitSec: 25,
  questionMode: 'all', // all | binary | hex
  answerFormat: 'mixed', // input | choice | mixed (직접 입력 | 4지선다 | 섞어서)
  difficultyMix: { easy: 0.3, medium: 0.5, hard: 0.2 },
  allowLeadingZeros: false,
  comboBonus: true,
  maxPlayers: 40,
};

/** @type {Map<string, object>} */
const rooms = new Map();

// ───────────────────────── 유틸 ─────────────────────────
function makeRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function makePlayerId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function sanitizeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  const clamp = (v, min, max, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
  };
  s.totalQuestions = clamp(s.totalQuestions, 3, 30, 12);
  s.timeLimitSec = clamp(s.timeLimitSec, 5, 120, 20);
  s.hardTimeLimitSec = clamp(s.hardTimeLimitSec, 5, 120, 25);
  s.maxPlayers = clamp(s.maxPlayers, 1, 200, 40);
  s.questionMode = MODES[s.questionMode] ? s.questionMode : 'all';
  s.answerFormat = ['input', 'choice', 'mixed'].indexOf(s.answerFormat) >= 0 ? s.answerFormat : 'mixed';
  const mix = Object.assign({}, DEFAULT_SETTINGS.difficultyMix, (raw && raw.difficultyMix) || {});
  let sum = ['easy', 'medium', 'hard'].reduce((a, k) => a + (Number(mix[k]) || 0), 0);
  if (sum <= 0) sum = 1;
  s.difficultyMix = {
    easy: (Number(mix.easy) || 0) / sum,
    medium: (Number(mix.medium) || 0) / sum,
    hard: (Number(mix.hard) || 0) / sum,
  };
  s.allowLeadingZeros = !!s.allowLeadingZeros;
  s.comboBonus = !!s.comboBonus;
  return s;
}

function uniqueNickname(room, raw) {
  let base = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 12);
  if (!base) base = '플레이어';
  const taken = new Set(Object.values(room.players).map((p) => p.nickname));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + i)) i += 1;
  return base + i;
}

const activePlayers = (room) => Object.values(room.players).filter((p) => p.connected);

function playerList(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    nickname: p.nickname,
    avatar: p.avatar,
    score: p.score,
    connected: p.connected,
  }));
}

function leaderboard(room) {
  return playerList(room)
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname))
    .map((p, i) => Object.assign({}, p, { rank: i + 1 }));
}

function emitPlayers(room) {
  io.to(room.roomCode).emit('room:players', {
    players: playerList(room),
    count: activePlayers(room).length,
  });
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function publicQuestion(room, q) {
  return {
    index: room.currentQuestionIndex + 1,
    total: room.questions.length,
    difficulty: q.difficulty,
    difficultyLabel: q.difficultyLabel,
    prompt: q.prompt,
    sourceValue: q.sourceValue,
    fromBase: q.fromBase,
    toBase: q.toBase,
    format: q.format,
    choices: q.choices,
    timeLimitSec: q.timeLimitSec,
    endsAt: room.questionEndsAt,
    serverNow: Date.now(),
  };
}

// ───────────────────────── 게임 진행 ─────────────────────────
function startQuestion(room) {
  clearRoomTimer(room);
  const q = room.questions[room.currentQuestionIndex];
  room.phase = 'question';
  room.questionStartedAt = Date.now();
  room.questionEndsAt = room.questionStartedAt + q.timeLimitSec * 1000;
  room.submissions[q.id] = {};
  io.to(room.roomCode).emit('game:question', publicQuestion(room, q));
  io.to(room.roomCode).emit('game:submitCount', { submitted: 0, total: activePlayers(room).length });
  room.timer = setTimeout(() => endQuestion(room), q.timeLimitSec * 1000 + GRACE_MS);
}

function endQuestion(room) {
  clearRoomTimer(room);
  if (room.phase !== 'question') return;
  room.phase = 'reveal';
  const q = room.questions[room.currentQuestionIndex];
  const subs = room.submissions[q.id] || {};
  const board = leaderboard(room);
  const rankOf = new Map(board.map((p) => [p.id, p.rank]));

  let correctCount = 0;
  Object.entries(room.players).forEach(([pid, p]) => {
    const sub = subs[pid];
    const isCorrect = !!(sub && sub.isCorrect);
    if (isCorrect) correctCount += 1;
    if (p.socketId) {
      io.to(p.socketId).emit('player:result', {
        answered: !!sub,
        answer: sub ? sub.answer : '',
        isCorrect,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation,
        gained: sub ? sub.scoreGained : 0,
        score: p.score,
        streak: p.streak,
        rank: rankOf.get(pid) || board.length,
        totalPlayers: board.length,
      });
    }
  });

  const answered = Object.keys(subs).length;
  const totalP = Math.max(activePlayers(room).length, answered);
  room.stats.push({
    id: q.id,
    index: room.currentQuestionIndex + 1,
    type: q.type,
    prompt: q.prompt,
    sourceValue: q.sourceValue,
    correctAnswer: q.correctAnswer,
    correctCount,
    total: totalP,
  });

  const isLast = room.currentQuestionIndex >= room.questions.length - 1;

  // 정답 공개 화면에 순위를 함께 실어 보낸다.
  // (관리자 화면은 교실 프로젝터용이므로 정답을 읽는 동안 순위도 같이 보이게 한다)
  io.to(room.roomCode).emit('game:reveal', {
    index: room.currentQuestionIndex + 1,
    total: room.questions.length,
    sourceValue: q.sourceValue,
    prompt: q.prompt,
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    correctCount,
    answeredCount: answered,
    totalPlayers: totalP,
    ranking: leaderboard(room),
    isLast,
    nextInMs: REVEAL_MS,
  });

  room.timer = setTimeout(() => (isLast ? finishGame(room) : nextQuestion(room)), REVEAL_MS);
}

function nextQuestion(room) {
  clearRoomTimer(room);
  room.currentQuestionIndex += 1;
  if (room.currentQuestionIndex >= room.questions.length) {
    finishGame(room);
    return;
  }
  startQuestion(room);
}

function finishGame(room) {
  clearRoomTimer(room);
  room.phase = 'finished';
  room.status = 'finished';
  const board = leaderboard(room);
  io.to(room.roomCode).emit('game:final', { ranking: board, stats: room.stats });
  board.forEach((entry) => {
    const p = room.players[entry.id];
    if (p && p.socketId) {
      io.to(p.socketId).emit('player:final', {
        rank: entry.rank,
        score: entry.score,
        totalPlayers: board.length,
        top3: board.slice(0, 3),
      });
    }
  });
}

/** 정답 공개/순위 화면에서 호스트가 "다음"을 눌러 대기 시간을 건너뛴다 */
function skipWait(room) {
  if (room.phase === 'question') {
    endQuestion(room);
  } else if (room.phase === 'reveal') {
    const isLast = room.currentQuestionIndex >= room.questions.length - 1;
    if (isLast) finishGame(room);
    else nextQuestion(room);
  }
}

// ───────────────────────── 소켓 핸들러 ─────────────────────────
io.on('connection', (socket) => {
  const fail = (msg) => socket.emit('error:msg', { message: msg });

  socket.on('host:create', (payload) => {
    const settings = sanitizeSettings(payload && payload.settings);
    const roomCode = makeRoomCode();
    const room = {
      roomCode,
      status: 'waiting',
      phase: 'lobby',
      settings,
      hostSocketId: socket.id,
      players: {},
      questions: [],
      currentQuestionIndex: 0,
      submissions: {},
      stats: [],
      timer: null,
      createdAt: Date.now(),
    };
    rooms.set(roomCode, room);
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.isHost = true;
    socket.emit('room:created', { roomCode, settings });
    emitPlayers(room);
    console.log('[방 생성] ' + roomCode);
  });

  socket.on('host:resume', (payload) => {
    const room = rooms.get(String((payload && payload.roomCode) || ''));
    if (!room) return fail('해당 방이 없습니다. 방을 새로 만들어 주세요.');
    room.hostSocketId = socket.id;
    socket.join(room.roomCode);
    socket.data.roomCode = room.roomCode;
    socket.data.isHost = true;
    socket.emit('room:created', { roomCode: room.roomCode, settings: room.settings, resumed: true });
    emitPlayers(room);
  });

  socket.on('host:start', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return fail('호스트만 게임을 시작할 수 있습니다.');
    if (room.status === 'in_progress') return;
    if (activePlayers(room).length < 1) return fail('참여자가 최소 1명 필요합니다.');
    room.questions = generateQuestions(room.settings);
    room.currentQuestionIndex = 0;
    room.submissions = {};
    room.stats = [];
    room.status = 'in_progress';
    Object.values(room.players).forEach((p) => {
      p.score = 0;
      p.streak = 0;
    });
    io.to(room.roomCode).emit('game:started', { total: room.questions.length });
    setTimeout(() => startQuestion(room), 1200);
  });

  socket.on('host:next', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return;
    skipWait(room);
  });

  socket.on('host:restart', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return;
    clearRoomTimer(room);
    room.status = 'waiting';
    room.phase = 'lobby';
    room.questions = [];
    room.submissions = {};
    room.stats = [];
    room.currentQuestionIndex = 0;
    Object.values(room.players).forEach((p) => {
      p.score = 0;
      p.streak = 0;
    });
    io.to(room.roomCode).emit('game:reset', { roomCode: room.roomCode });
    emitPlayers(room);
  });

  socket.on('player:join', (payload) => {
    const code = String((payload && payload.roomCode) || '').trim();
    const room = rooms.get(code);
    if (!room) return fail('방 코드를 찾을 수 없습니다.');

    const prevId = payload && payload.playerId;
    let playerId = null;
    if (prevId && room.players[prevId]) {
      // 재접속
      playerId = prevId;
      room.players[playerId].connected = true;
      room.players[playerId].socketId = socket.id;
    } else {
      if (room.status === 'in_progress') return fail('이미 게임이 진행 중인 방입니다.');
      if (activePlayers(room).length >= room.settings.maxPlayers) return fail('인원이 가득 찼습니다.');
      playerId = makePlayerId();
      room.players[playerId] = {
        nickname: uniqueNickname(room, payload && payload.nickname),
        avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
        score: 0,
        streak: 0,
        connected: true,
        socketId: socket.id,
      };
    }

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    const me = room.players[playerId];
    socket.emit('player:joined', {
      playerId,
      roomCode: code,
      nickname: me.nickname,
      avatar: me.avatar,
      score: me.score,
      status: room.status,
      phase: room.phase,
    });
    emitPlayers(room);

    // 진행 중 재접속이면 현재 문제를 바로 전달
    if (room.phase === 'question') {
      socket.emit('game:question', publicQuestion(room, room.questions[room.currentQuestionIndex]));
    }
  });

  socket.on('player:answer', (payload) => {
    const room = rooms.get(socket.data.roomCode);
    const playerId = socket.data.playerId;
    if (!room || !playerId || !room.players[playerId]) return;
    if (room.phase !== 'question') return;

    const q = room.questions[room.currentQuestionIndex];
    const subs = room.submissions[q.id] || (room.submissions[q.id] = {});
    if (subs[playerId]) return; // 1문제 1회 제출

    const now = Date.now();
    const elapsedMs = now - room.questionStartedAt;
    const limitMs = q.timeLimitSec * 1000;
    const inTime = elapsedMs <= limitMs + GRACE_MS;
    const isCorrect = inTime && checkAnswer(q, payload && payload.answer, room.settings.allowLeadingZeros);

    const player = room.players[playerId];
    let gained = 0;
    if (isCorrect) {
      const remainRatio = Math.max(0, Math.min(1, (limitMs - elapsedMs) / limitMs));
      gained = Math.round(500 + 500 * remainRatio);
      player.streak += 1;
      if (room.settings.comboBonus && player.streak >= 2) {
        gained += Math.min(player.streak - 1, 5) * 100; // 연속 정답 콤보 보너스
      }
    } else {
      player.streak = 0;
    }
    player.score += gained;

    subs[playerId] = {
      answer: String((payload && payload.answer) || '').toUpperCase(),
      isCorrect,
      answeredAtMs: elapsedMs,
      scoreGained: gained,
    };

    socket.emit('player:submitted', { answer: subs[playerId].answer });

    const total = activePlayers(room).length;
    io.to(room.roomCode).emit('game:submitCount', { submitted: Object.keys(subs).length, total });
    if (Object.keys(subs).length >= total) {
      setTimeout(() => endQuestion(room), 400); // 전원 제출 시 조기 종료
    }
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.isHost && room.hostSocketId === socket.id) {
      clearRoomTimer(room);
      room.hostClosedAt = Date.now();
      console.log('[호스트 연결 끊김] ' + room.roomCode);
      return;
    }
    const pid = socket.data.playerId;
    if (pid && room.players[pid]) {
      room.players[pid].connected = false;
      room.players[pid].socketId = null;
      emitPlayers(room);
    }
  });
});

// 오래된 방 정리 (3시간)
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (now - room.createdAt > 3 * 60 * 60 * 1000) {
      clearRoomTimer(room);
      rooms.delete(code);
    }
  });
}, 10 * 60 * 1000);

function localIPs() {
  const list = [];
  Object.values(os.networkInterfaces()).forEach((ifaces) => {
    (ifaces || []).forEach((i) => {
      if (i.family === 'IPv4' && !i.internal) list.push(i.address);
    });
  });
  return list;
}

server.listen(PORT, () => {
  console.log('\n===============================================');
  console.log('  진법 변환 퀴즈 게임 서버가 시작되었습니다!');
  console.log('===============================================');
  console.log('  관리자 화면 : http://localhost:' + PORT + '/host');
  console.log('  참여자 화면 : http://localhost:' + PORT + '/play');
  localIPs().forEach((ip) => {
    console.log('  (같은 와이파이) 참여자 접속 주소 : http://' + ip + ':' + PORT + '/play');
  });
  console.log('===============================================\n');
});
