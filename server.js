const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const rooms = new Map();

const PLAYER_COLORS = ['#e94560','#4ecdc4','#f39c12','#9b59b6','#2ecc71','#e67e22','#3498db','#1abc9c'];
const PLAYER_EMOJIS = ['🦊','🐙','🦁','🐸','🦄','🐯','🦇','🐲'];

setInterval(() => {
  for (const [code, room] of rooms) {
    const allDisconnected = Object.values(room.players).every(p => !p.ws);
    const hostGone = !room.hostWs || room.hostWs.readyState !== 1;
    if (allDisconnected && hostGone) {
      clearTimer(room);
      rooms.delete(code);
      console.log(`Cleaned up room ${code}`);
    }
  }
}, 5 * 60 * 1000);

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do { code = Array.from({length:4}, ()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function normalize(s) { return s.toLowerCase().replace(/[^a-z0-9]/g,'').trim(); }

function isTooSimilar(lie, truth, alts) {
  const nl = normalize(lie);
  const targets = [truth, ...(alts||[])].map(normalize);
  for (const t of targets) {
    if (nl === t) return true;
    if (nl.includes(t) || t.includes(nl)) return true;
    if (t.length > 2 && nl.length > 2) {
      const dist = levenshtein(nl, t);
      if (dist <= Math.max(1, Math.floor(t.length * 0.3))) return true;
    }
  }
  return false;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1},()=>Array(n+1).fill(0));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function getRoom(code) { return rooms.get(code); }

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  if (room.hostWs && room.hostWs.readyState === 1) room.hostWs.send(data);
  for (const p of Object.values(room.players)) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendTo(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function playerList(room) {
  return Object.values(room.players).map(p => ({
    name: p.name, score: p.score, connected: !!p.ws, color: p.color, emoji: p.emoji
  }));
}

function pickQuestions(room) {
  let sourceQuestions = questions;
  if (room.customQuestions && Array.isArray(room.customQuestions) && room.customQuestions.length > 0) {
    const custom = room.customQuestions.map((q, i) => ({
      id: 'custom_' + i, category: q.category || 'Custom', question: q.question,
      answer: q.answer, alternateAnswers: q.alternateAnswers || [], decoys: q.decoys || []
    }));
    sourceQuestions = [...custom, ...questions];
  }
  const used = new Set();
  const picked = [];
  const shuffled = [...sourceQuestions].sort(()=>Math.random()-0.5);
  for (const q of shuffled) {
    if (picked.length >= 20) break;
    const qid = q.id || q.question;
    if (!used.has(qid)) { picked.push(q); used.add(qid); }
  }
  room.questionPool = picked;
}

function getCategories(room) {
  const pool = room.questionPool;
  if (!pool || pool.length === 0) return [];
  const cats = [...new Set(pool.map(q=>q.category))];
  return cats.sort(()=>Math.random()-0.5).slice(0, 3);
}

function pickQuestionFromCategory(room, category) {
  const idx = room.questionPool.findIndex(q => q.category === category);
  if (idx === -1) return room.questionPool.splice(0,1)[0];
  return room.questionPool.splice(idx, 1)[0];
}

function roundMultiplier(room) {
  return 1;
}

function questionsInRound(round) {
  return 3;
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function computeAwards(room) {
  const awards = [];
  const playerCount = Object.keys(room.players).length;

  // Truth Detector
  let maxCorrect = 0;
  for (const p of Object.values(room.players)) { if ((p.correctPicks || 0) > maxCorrect) maxCorrect = p.correctPicks || 0; }
  if (maxCorrect > 0) {
    const winners = Object.values(room.players).filter(p => (p.correctPicks || 0) === maxCorrect);
    if (winners.length < playerCount) {
      for (const w of winners) awards.push({ title: 'Truth Detector', emoji: '🎯', playerName: w.name, playerEmoji: w.emoji, playerColor: w.color, stat: w.correctPicks + ' correct' });
    }
  }

  // Most Gullible
  let maxFooledStat = 0;
  for (const p of Object.values(room.players)) { if ((p.timesFooled || 0) > maxFooledStat) maxFooledStat = p.timesFooled || 0; }
  if (maxFooledStat > 0) {
    const winners = Object.values(room.players).filter(p => (p.timesFooled || 0) === maxFooledStat);
    if (winners.length < playerCount) {
      for (const w of winners) awards.push({ title: 'Most Gullible', emoji: '🤡', playerName: w.name, playerEmoji: w.emoji, playerColor: w.color, stat: 'fooled ' + w.timesFooled + ' times' });
    }
  }

  // Best Liar
  let maxBL = 0;
  for (const c of Object.values(room.bestLieScores || {})) { if (c > maxBL) maxBL = c; }
  if (maxBL > 0) {
    const blWinners = Object.entries(room.bestLieScores).filter(([n,c]) => c === maxBL);
    if (blWinners.length < playerCount) {
      for (const [n, c] of blWinners) {
        const p = room.players[n];
        awards.push({ title: 'Best Liar', emoji: '🎭', playerName: n, playerEmoji: p ? p.emoji : '', playerColor: p ? p.color : '', stat: c + ' best lie votes' });
      }
    }
  }

  // Master Manipulator
  let maxPF = 0;
  for (const p of Object.values(room.players)) { if ((p.peopleFooled || 0) > maxPF) maxPF = p.peopleFooled || 0; }
  if (maxPF > 0) {
    const winners = Object.values(room.players).filter(p => (p.peopleFooled || 0) === maxPF);
    if (winners.length < playerCount) {
      for (const w of winners) awards.push({ title: 'Master Manipulator', emoji: '🧠', playerName: w.name, playerEmoji: w.emoji, playerColor: w.color, stat: 'fooled ' + w.peopleFooled + ' people' });
    }
  }

  return awards;
}

function syncPlayerToCurrentPhase(room, name) {
  const p = room.players[name];
  if (!p || !p.ws) return;
  const ws = p.ws;
  switch (room.phase) {
    case 'category-select':
      sendTo(ws, { type: 'category-select', categories: room.categories, questionNum: room.questionNum, totalQuestions: 9, timeMs: 5000 });
      break;
    case 'show-question':
    case 'lie':
      sendTo(ws, { type: 'lie-phase', question: room.currentQuestion.question, timeMs: 15000 });
      break;
    case 'vote': {
      const displayAnswers = room.answerList.map((a,i) => ({ id: i, text: a.text }));
      const myAnswers = displayAnswers.filter(a => room.answerList[a.id].author !== name);
      sendTo(ws, { type: 'your-choices', answers: myAnswers });
      break;
    }
    case 'reveal':
      sendTo(ws, { type: 'sync', phase: 'reveal', message: 'Revealing answers...' });
      break;
    case 'scoreboard':
      sendTo(ws, { type: 'scoreboard', players: playerList(room) });
      break;
    case 'best-lie-vote':
      sendTo(ws, { type: 'sync', phase: 'best-lie-vote', message: 'Vote for Best Lie!' });
      break;
    case 'best-lie-result':
      sendTo(ws, { type: 'sync', phase: 'best-lie-result', message: 'Best Lie revealed!' });
      break;
    case 'fool-of-round':
      sendTo(ws, { type: 'sync', phase: 'fool-of-round', message: 'Fool of the Round!' });
      break;
    case 'game-over': {
      const sorted = playerList(room).sort((a,b) => b.score - a.score);
      let bestLiar = null; let maxBL = 0;
      for (const [n, c] of Object.entries(room.bestLieScores || {})) { if (c > maxBL) { maxBL = c; bestLiar = n; } }
      let bestLiarData = null;
      if (bestLiar && maxBL > 0) { const bp = room.players[bestLiar]; bestLiarData = { name: bestLiar, emoji: bp ? bp.emoji : '', color: bp ? bp.color : '', votes: maxBL }; }
      const awards = computeAwards(room);
      sendTo(ws, { type: 'game-over', players: sorted, bestLiar: bestLiarData, bestLieScores: room.bestLieScores, awards: awards });
      break;
    }
  }
}

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.state !== 'playing') continue;
    for (const p of Object.values(room.players)) {
      if (p.ws && p.ws.readyState === 1) sendTo(p.ws, { type: 'sync', phase: room.phase });
    }
  }
}, 5000);

function startGame(room) {
  room.state = 'playing';
  room.questionNum = 0;
  room.nobodyGotItCount = 0;
  for (const p of Object.values(room.players)) { p.score = 0; p.correctPicks = 0; p.timesFooled = 0; p.peopleFooled = 0; }
  pickQuestions(room);
  broadcast(room, { type: 'game-start', players: playerList(room) });
  nextQuestion(room);
}

function nextQuestion(room) {
  room.questionNum++;
  if (room.questionNum > 9) { endGame(room); return; }
  room.phase = 'category-select';
  room.categories = getCategories(room);
  room.categoryVotes = {};
  if (room.categories.length === 0) { endGame(room); return; }
  broadcast(room, { type: 'category-select', categories: room.categories, questionNum: room.questionNum, totalQuestions: 9, timeMs: 15000 });
  clearTimer(room);
  room.timer = setTimeout(() => selectCategory(room), 15000);
}

function selectCategory(room) {
  clearTimer(room);
  const votes = {};
  for (const cat of Object.values(room.categoryVotes)) votes[cat] = (votes[cat]||0)+1;
  let chosen = room.categories[Math.floor(Math.random()*room.categories.length)];
  let max = 0;
  for (const [cat, count] of Object.entries(votes)) { if (count > max) { max=count; chosen=cat; } }
  const q = pickQuestionFromCategory(room, chosen);
  room.currentQuestion = q;
  room.lies = {};
  room.votes = {};
  room.phase = 'show-question';
  broadcast(room, { type: 'show-question', question: q.question, category: q.category, timeMs: 3000 });
  room.timer = setTimeout(() => startLiePhase(room), 3000);
}

function startLiePhase(room) {
  clearTimer(room);
  room.phase = 'lie';
  broadcast(room, { type: 'lie-phase', question: room.currentQuestion.question, timeMs: 45000 });
  room.timer = setTimeout(() => startVoting(room), 45000);
}

function checkAllLiesIn(room) {
  const activePlayers = Object.values(room.players).filter(p => p.ws);
  const allIn = activePlayers.every(p => room.lies[p.name]);
  if (allIn && activePlayers.length > 0) {
    clearTimer(room);
    broadcast(room, { type: 'all-lies-in' });
    room.timer = setTimeout(() => startVoting(room), 3000);
  }
}

function startVoting(room) {
  clearTimer(room);
  room.phase = 'vote';
  const answers = [];
  const truth = room.currentQuestion.answer;
  answers.push({ text: truth, isTrue: true, author: null });
  for (const [playerName, lie] of Object.entries(room.lies)) answers.push({ text: lie, isTrue: false, author: playerName });
  const decoys = room.currentQuestion.decoys || [];
  const playerCount = Object.keys(room.lies).length;
  const decoysNeeded = Math.max(0, 6 - (1 + playerCount));
  const usedTexts = new Set(answers.map(a => normalize(a.text)));
  let decoysAdded = 0;
  for (const d of decoys) {
    if (decoysAdded >= decoysNeeded) break;
    if (!usedTexts.has(normalize(d))) { answers.push({ text: d, isTrue: false, author: '__GAME__' }); usedTexts.add(normalize(d)); decoysAdded++; }
  }
  room.answerList = answers.sort(() => Math.random() - 0.5);
  room.votes = {};
  const displayAnswers = room.answerList.map((a,i) => ({ id: i, text: a.text }));
  broadcast(room, { type: 'vote-phase', question: room.currentQuestion.question, answers: displayAnswers, timeMs: 30000 });
  for (const p of Object.values(room.players)) {
    if (p.ws && p.ws.readyState === 1) {
      const myAnswers = displayAnswers.filter(a => room.answerList[a.id].author !== p.name);
      sendTo(p.ws, { type: 'your-choices', answers: myAnswers });
    }
  }
  room.timer = setTimeout(() => doReveal(room), 30000);
}

function checkAllVotesIn(room) {
  const activePlayers = Object.values(room.players).filter(p => p.ws);
  const allIn = activePlayers.every(p => room.votes[p.name] !== undefined);
  if (allIn && activePlayers.length > 0) { clearTimer(room); room.timer = setTimeout(() => doReveal(room), 1500); }
}

function checkAllBestLieVotesIn(room) {
  const activePlayers = Object.values(room.players).filter(p => p.ws);
  const allIn = activePlayers.every(p => room.bestLieVotes[p.name] !== undefined);
  if (allIn && activePlayers.length > 0) { clearTimer(room); resolveBestLieVote(room); }
}

function startBestLieVote(room) {
  clearTimer(room);
  const playerLies = [];
  room.bestLieLookup = {};
  let lieId = 0;
  for (const [playerName, lieText] of Object.entries(room.lies)) {
    const p = room.players[playerName];
    if (p) { const id = lieId++; playerLies.push({ id, text: lieText }); room.bestLieLookup[id] = { author: playerName, text: lieText }; }
  }
  // Include game decoys in best lie vote
  if (room.answerList) {
    for (const a of room.answerList) {
      if (a.author === '__GAME__') { const id = lieId++; playerLies.push({ id, text: a.text }); room.bestLieLookup[id] = { author: '__GAME__', text: a.text }; }
    }
  }
  if (playerLies.length <= 1) { showFoolAndScoreboard(room); return; }
  room.phase = 'best-lie-vote';
  room.bestLieVotes = {};
  broadcast(room, { type: 'best-lie-vote', lies: allLies, timeMs: 15000 });
  room.timer = setTimeout(() => resolveBestLieVote(room), 15000);
}

function resolveBestLieVote(room) {
  clearTimer(room);
  room.phase = 'best-lie-result';
  const voteCounts = {};
  for (const lieId of Object.values(room.bestLieVotes)) voteCounts[lieId] = (voteCounts[lieId] || 0) + 1;
  let maxVotes = 0; let winners = [];
  for (const [lieId, count] of Object.entries(voteCounts)) {
    if (count > maxVotes) { maxVotes = count; winners = [lieId]; }
    else if (count === maxVotes) winners.push(lieId);
  }
  let winnerData = null;
  if (winners.length > 0 && maxVotes > 0) {
    const winnerLieId = winners[Math.floor(Math.random() * winners.length)];
    const entry = room.bestLieLookup[winnerLieId];
    const winnerName = entry.author;
    if (winnerName && winnerName !== '__GAME__') {
      room.bestLieScores[winnerName] = (room.bestLieScores[winnerName] || 0) + 1;
    }
    winnerData = { text: entry.text, votes: maxVotes };
  }
  broadcast(room, { type: 'best-lie-result', winner: winnerData });
  room.timer = setTimeout(() => showFoolAndScoreboard(room), 4000);
}

function doReveal(room) {
  clearTimer(room);
  room.phase = 'reveal';
  const mult = 1;
  const truth = room.currentQuestion.answer;

  const picks = {};
  for (const [playerName, answerId] of Object.entries(room.votes)) {
    if (!picks[answerId]) picks[answerId] = [];
    picks[answerId].push(playerName);
  }

  // Nobody Got It check
  const truthIdx = room.answerList.findIndex(a => a.isTrue);
  const truthVoters = picks[truthIdx] || [];
  const nobodyGotIt = truthVoters.length === 0;
  if (nobodyGotIt) room.nobodyGotItCount = (room.nobodyGotItCount || 0) + 1;

  const scoreChanges = {};
  for (const p of Object.values(room.players)) scoreChanges[p.name] = 0;

  for (const [answerId, voters] of Object.entries(picks)) {
    const answer = room.answerList[parseInt(answerId)];
    if (!answer) continue;
    if (answer.isTrue) {
      for (const v of voters) {
        scoreChanges[v] = (scoreChanges[v]||0) + 1000 * mult;
        if (room.players[v]) room.players[v].correctPicks = (room.players[v].correctPicks || 0) + 1;
      }
    } else if (answer.author === '__GAME__') {
      for (const v of voters) {
        scoreChanges[v] = (scoreChanges[v]||0) - 500 * mult;
        if (room.players[v]) room.players[v].timesFooled = (room.players[v].timesFooled || 0) + 1;
      }
    } else if (answer.author) {
      scoreChanges[answer.author] = (scoreChanges[answer.author]||0) + 500 * mult * voters.length;
      if (room.players[answer.author]) room.players[answer.author].peopleFooled = (room.players[answer.author].peopleFooled || 0) + voters.length;
      for (const v of voters) {
        if (room.players[v]) room.players[v].timesFooled = (room.players[v].timesFooled || 0) + 1;
      }
    }
  }

  for (const [name, change] of Object.entries(scoreChanges)) {
    if (room.players[name]) room.players[name].score += change;
  }

  const revealData = room.answerList.map((a, i) => {
    const authorPlayer = a.author && a.author !== '__GAME__' ? room.players[a.author] : null;
    const pickedByData = (picks[i] || []).map(pName => {
      const pp = room.players[pName];
      return { name: pName, emoji: pp ? pp.emoji : '', color: pp ? pp.color : '' };
    });
    return { id: i, text: a.text, isTrue: a.isTrue, author: a.author, authorEmoji: authorPlayer ? authorPlayer.emoji : '', authorColor: authorPlayer ? authorPlayer.color : '', pickedBy: picks[i] || [], pickedByDetails: pickedByData };
  });

  let foolData = null; let maxFooled = 0; const foolCandidates = [];
  for (const [answerId, voters] of Object.entries(picks)) {
    const answer = room.answerList[parseInt(answerId)];
    if (!answer || answer.isTrue || answer.author === '__GAME__' || !answer.author) continue;
    if (voters.length > maxFooled) { maxFooled = voters.length; foolCandidates.length = 0; foolCandidates.push({ name: answer.author, count: voters.length, text: answer.text }); }
    else if (voters.length === maxFooled && voters.length > 0) foolCandidates.push({ name: answer.author, count: voters.length, text: answer.text });
  }
  if (foolCandidates.length > 0 && maxFooled > 0) {
    const pick = foolCandidates[Math.floor(Math.random() * foolCandidates.length)];
    const fp = room.players[pick.name];
    foolData = { name: pick.name, count: pick.count, text: pick.text, emoji: fp ? fp.emoji : '', color: fp ? fp.color : '' };
  }

  broadcast(room, { type: 'reveal', reveals: revealData, truth, scoreChanges, players: playerList(room), foolOfRound: foolData, nobodyGotIt });

  room.currentFoolData = foolData;
  const revealTime = Math.max(3500, revealData.length * 3200);
  const extraDelay = nobodyGotIt ? 3500 : 0;
  room.timer = setTimeout(() => startBestLieVote(room), revealTime + extraDelay);
}

function showFoolAndScoreboard(room) {
  clearTimer(room);
  const foolData = room.currentFoolData;
  const foolDelay = foolData ? 4000 : 0;
  if (foolData) { room.phase = 'fool-of-round'; broadcast(room, { type: 'fool-of-round', fool: foolData }); }
  room.timer = setTimeout(() => {
    room.phase = 'scoreboard';
    broadcast(room, { type: 'scoreboard', players: playerList(room) });
    room.timer = setTimeout(() => nextQuestion(room), 5000);
  }, foolDelay);
}

function endGame(room) {
  clearTimer(room);
  room.phase = 'game-over';
  room.state = 'ended';
  const sorted = playerList(room).sort((a,b) => b.score - a.score);
  let bestLiar = null; let maxBL = 0;
  for (const [name, count] of Object.entries(room.bestLieScores)) { if (count > maxBL) { maxBL = count; bestLiar = name; } }
  let bestLiarData = null;
  if (bestLiar && maxBL > 0) { const p = room.players[bestLiar]; bestLiarData = { name: bestLiar, emoji: p ? p.emoji : '', color: p ? p.color : '', votes: maxBL }; }
  const awards = computeAwards(room);
  broadcast(room, { type: 'game-over', players: sorted, bestLiar: bestLiarData, bestLieScores: room.bestLieScores, awards });
}

wss.on('connection', (ws) => {
  let myRoom = null; let myName = null; let isHost = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        const code = genCode();
        const room = { code, hostWs: ws, players: {}, state: 'lobby', phase: 'lobby', round: 0, questionNum: 0, timer: null, questionPool: [], currentQuestion: null, lies: {}, votes: {}, answerList: [], categories: [], categoryVotes: {}, customQuestions: msg.customQuestions || null, bestLieScores: {}, bestLieVotes: {}, nobodyGotItCount: 0 };
        rooms.set(code, room);
        myRoom = code; isHost = true;
        sendTo(ws, { type: 'room-created', code });
        break;
      }
      case 'join-room': {
        const code = (msg.code||'').toUpperCase();
        const name = (msg.name||'').trim().substring(0, 16);
        const room = getRoom(code);
        if (!room) { sendTo(ws, { type: 'error', message: 'Room not found' }); return; }
        if (room.state !== 'lobby' && !room.players[name]) { sendTo(ws, { type: 'error', message: 'Game already in progress' }); return; }
        if (Object.keys(room.players).length >= 8 && !room.players[name]) { sendTo(ws, { type: 'error', message: 'Room is full (max 8)' }); return; }
        if (!name) { sendTo(ws, { type: 'error', message: 'Name required' }); return; }
        if (room.players[name] && room.players[name].ws && room.players[name].ws.readyState === 1 && room.players[name].ws !== ws) { sendTo(ws, { type: 'error', message: 'Name already taken! Pick another.' }); return; }
        if (room.players[name]) { room.players[name].ws = ws; }
        else { const idx = Object.keys(room.players).length; room.players[name] = { name, score: 0, ws, color: PLAYER_COLORS[idx % 8], emoji: PLAYER_EMOJIS[idx % 8], correctPicks: 0, timesFooled: 0, peopleFooled: 0 }; }
        myRoom = code; myName = name;
        sendTo(ws, { type: 'joined', code, name, score: room.players[name].score, phase: room.phase, color: room.players[name].color, emoji: room.players[name].emoji });
        broadcast(room, { type: 'player-list', players: playerList(room) });
        if (room.state === 'playing') syncPlayerToCurrentPhase(room, name);
        break;
      }
      case 'host-join': {
        const code = (msg.code||'').toUpperCase();
        const room = getRoom(code);
        if (!room) { sendTo(ws, { type: 'error', message: 'Room not found' }); return; }
        room.hostWs = ws; myRoom = code; isHost = true;
        sendTo(ws, { type: 'host-joined', code, players: playerList(room), phase: room.phase, state: room.state });
        break;
      }
      case 'start-game': {
        if (!isHost || !myRoom) return;
        const room = getRoom(myRoom);
        if (!room || room.state !== 'lobby') return;
        if (Object.keys(room.players).length < 2) { sendTo(ws, { type: 'error', message: 'Need at least 2 players' }); return; }
        startGame(room);
        break;
      }
      case 'vote-category': {
        if (!myRoom || !myName) return;
        const room = getRoom(myRoom);
        if (!room || room.phase !== 'category-select') return;
        if (room.categories.includes(msg.category)) {
          room.categoryVotes[myName] = msg.category;
          const activePlayers = Object.values(room.players).filter(p => p.ws);
          if (activePlayers.every(p => room.categoryVotes[p.name]) && activePlayers.length > 0) { clearTimer(room); room.timer = setTimeout(() => selectCategory(room), 1000); }
        }
        break;
      }
      case 'submit-lie': {
        if (!myRoom || !myName) return;
        const room = getRoom(myRoom);
        if (!room || room.phase !== 'lie') return;
        const lie = (msg.lie||'').trim();
        if (!lie || lie.length > 80) return;
        if (isTooSimilar(lie, room.currentQuestion.answer, room.currentQuestion.alternateAnswers)) { sendTo(ws, { type: 'lie-rejected', message: 'Too close to the real answer! Try again.' }); return; }
        room.lies[myName] = lie;
        sendTo(ws, { type: 'lie-accepted' });
        const activeLiePlayers = Object.values(room.players).filter(p => p.ws);
        const lieWaiting = activeLiePlayers.filter(p => !room.lies[p.name]).map(p => ({ name: p.name, emoji: p.emoji, color: p.color }));
        sendTo(room.hostWs, { type: 'lie-count', count: Object.keys(room.lies).length, total: Object.keys(room.players).length, waiting: lieWaiting });
        checkAllLiesIn(room);
        break;
      }
      case 'submit-vote': {
        if (!myRoom || !myName) return;
        const room = getRoom(myRoom);
        if (!room || room.phase !== 'vote') return;
        const aid = parseInt(msg.answerId);
        if (isNaN(aid) || aid < 0 || aid >= room.answerList.length) return;
        if (room.answerList[aid].author === myName) return;
        room.votes[myName] = aid;
        sendTo(ws, { type: 'vote-accepted' });
        const activeVotePlayers = Object.values(room.players).filter(p => p.ws);
        const voteWaiting = activeVotePlayers.filter(p => room.votes[p.name] === undefined).map(p => ({ name: p.name, emoji: p.emoji, color: p.color }));
        sendTo(room.hostWs, { type: 'vote-count', count: Object.keys(room.votes).length, total: Object.keys(room.players).length, waiting: voteWaiting });
        checkAllVotesIn(room);
        break;
      }
      case 'vote-best-lie': {
        if (!myRoom || !myName) return;
        const room = getRoom(myRoom);
        if (!room || room.phase !== 'best-lie-vote') return;
        const lieId = msg.lieId;
        if (lieId === undefined || !room.bestLieLookup || !room.bestLieLookup[lieId]) return;
        if (room.bestLieLookup[lieId].author === myName) return;
        room.bestLieVotes[myName] = lieId;
        sendTo(ws, { type: 'best-lie-vote-accepted' });
        const activeBLPlayers = Object.values(room.players).filter(p => p.ws);
        const blWaiting = activeBLPlayers.filter(p => room.bestLieVotes[p.name] === undefined).map(p => ({ name: p.name, emoji: p.emoji, color: p.color }));
        sendTo(room.hostWs, { type: 'best-lie-vote-count', count: Object.keys(room.bestLieVotes).length, total: Object.keys(room.players).length, waiting: blWaiting });
        checkAllBestLieVotesIn(room);
        break;
      }
      case 'pause-game': {
        if (!isHost || !myRoom) return;
        const room = getRoom(myRoom);
        if (!room || room.state !== 'playing') return;
        clearTimer(room);
        room.paused = true;
        broadcast(room, { type: 'game-paused' });
        break;
      }
      case 'resume-game': {
        if (!isHost || !myRoom) return;
        const room = getRoom(myRoom);
        if (!room || room.state !== 'playing' || !room.paused) return;
        room.paused = false;
        broadcast(room, { type: 'game-resumed' });
        // Re-sync all players to current phase
        for (const name of Object.keys(room.players)) syncPlayerToCurrentPhase(room, name);
        // Restart the current phase timer
        switch (room.phase) {
          case 'category-select': room.timer = setTimeout(() => selectCategory(room), 15000); break;
          case 'lie': room.timer = setTimeout(() => startVoting(room), 45000); break;
          case 'vote': room.timer = setTimeout(() => doReveal(room), 30000); break;
          case 'best-lie-vote': room.timer = setTimeout(() => resolveBestLieVote(room), 15000); break;
        }
        break;
      }
      case 'end-game': {
        if (!isHost || !myRoom) return;
        const room = getRoom(myRoom);
        if (!room) return;
        room.paused = false;
        endGame(room);
        break;
      }
      case 'play-again': {
        if (!isHost || !myRoom) return;
        const room = getRoom(myRoom);
        if (!room) return;
        room.state = 'lobby'; room.phase = 'lobby'; room.questionNum = 0; room.nobodyGotItCount = 0;
        for (const p of Object.values(room.players)) { p.score = 0; p.correctPicks = 0; p.timesFooled = 0; p.peopleFooled = 0; }
        room.bestLieScores = {};
        broadcast(room, { type: 'back-to-lobby', players: playerList(room) });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myRoom && myName) {
      const room = getRoom(myRoom);
      if (room && room.players[myName]) { room.players[myName].ws = null; broadcast(room, { type: 'player-list', players: playerList(room) }); }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Sounds Legit server running on port ${PORT}`));
