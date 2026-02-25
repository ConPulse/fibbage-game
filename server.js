const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

const questions = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));
const rooms = new Map();

// Auto-cleanup abandoned rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
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
    // Levenshtein
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
    name: p.name, score: p.score, connected: !!p.ws
  }));
}

function pickQuestions(room) {
  const categoriesAvail = [...new Set(questions.map(q=>q.category))];
  // Pick 7 questions total, try diverse categories
  const used = new Set();
  const picked = [];
  const shuffled = [...questions].sort(()=>Math.random()-0.5);
  for (const q of shuffled) {
    if (picked.length >= 20) break;
    if (!used.has(q.id)) { picked.push(q); used.add(q.id); }
  }
  room.questionPool = picked;
}

function getCategories(room) {
  const pool = room.questionPool;
  if (!pool || pool.length === 0) return [];
  const cats = [...new Set(pool.map(q=>q.category))];
  // pick 3 random
  const shuffled = cats.sort(()=>Math.random()-0.5);
  return shuffled.slice(0, 3);
}

function pickQuestionFromCategory(room, category) {
  const idx = room.questionPool.findIndex(q => q.category === category);
  if (idx === -1) {
    // fallback: pick any
    return room.questionPool.splice(0,1)[0];
  }
  return room.questionPool.splice(idx, 1)[0];
}

function roundMultiplier(room) {
  if (room.round === 1) return 1;
  if (room.round === 2) return 2;
  return 3; // final
}

function questionsInRound(round) {
  if (round === 1) return 3;
  if (round === 2) return 3;
  return 1;
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

function syncPlayerToCurrentPhase(room, name) {
  const p = room.players[name];
  if (!p || !p.ws) return;
  const ws = p.ws;
  
  switch (room.phase) {
    case 'category-select':
      sendTo(ws, {
        type: 'category-select',
        categories: room.categories,
        round: room.round,
        questionNum: room.questionNum,
        totalQuestions: questionsInRound(room.round),
        timeMs: 5000 // shortened since timer already running
      });
      break;
    case 'show-question':
    case 'lie':
      sendTo(ws, {
        type: 'lie-phase',
        question: room.currentQuestion.question,
        timeMs: 15000 // give them some time even if phase started earlier
      });
      break;
    case 'vote':
      const displayAnswers = room.answerList.map((a,i) => ({ id: i, text: a.text }));
      const myAnswers = displayAnswers.filter(a => {
        const entry = room.answerList[a.id];
        return entry.author !== name;
      });
      sendTo(ws, { type: 'your-choices', answers: myAnswers });
      break;
    case 'reveal':
      sendTo(ws, { type: 'wait', message: 'Revealing answers...' });
      break;
    case 'scoreboard':
      sendTo(ws, { type: 'scoreboard', players: playerList(room) });
      break;
  }
}

function startGame(room) {
  room.state = 'playing';
  room.round = 1;
  room.questionNum = 0;
  for (const p of Object.values(room.players)) p.score = 0;
  pickQuestions(room);
  broadcast(room, { type: 'game-start', players: playerList(room) });
  nextQuestion(room);
}

function nextQuestion(room) {
  room.questionNum++;
  const totalInRound = questionsInRound(room.round);
  if (room.questionNum > totalInRound) {
    room.round++;
    room.questionNum = 1;
    if (room.round > 3) {
      endGame(room);
      return;
    }
    broadcast(room, { type: 'new-round', round: room.round });
  }
  // Category select phase
  room.phase = 'category-select';
  room.categories = getCategories(room);
  room.categoryVotes = {};
  if (room.categories.length === 0) { endGame(room); return; }
  broadcast(room, {
    type: 'category-select',
    categories: room.categories,
    round: room.round,
    questionNum: room.questionNum,
    totalQuestions: questionsInRound(room.round),
    timeMs: 15000
  });
  clearTimer(room);
  room.timer = setTimeout(() => selectCategory(room), 15000);
}

function selectCategory(room) {
  clearTimer(room);
  // Tally votes or pick random
  const votes = {};
  for (const cat of Object.values(room.categoryVotes)) votes[cat] = (votes[cat]||0)+1;
  let chosen = room.categories[Math.floor(Math.random()*room.categories.length)];
  let max = 0;
  for (const [cat, count] of Object.entries(votes)) { if (count > max) { max=count; chosen=cat; } }

  const q = pickQuestionFromCategory(room, chosen);
  room.currentQuestion = q;
  room.lies = {};
  room.votes = {};

  // Show question phase
  room.phase = 'show-question';
  broadcast(room, {
    type: 'show-question',
    question: q.question,
    category: q.category,
    round: room.round,
    timeMs: 3000
  });
  room.timer = setTimeout(() => startLiePhase(room), 3000);
}

function startLiePhase(room) {
  clearTimer(room);
  room.phase = 'lie';
  broadcast(room, {
    type: 'lie-phase',
    question: room.currentQuestion.question,
    timeMs: 45000
  });
  room.timer = setTimeout(() => startVoting(room), 45000);
}

function checkAllLiesIn(room) {
  const activePlayers = Object.values(room.players).filter(p => p.ws);
  const allIn = activePlayers.every(p => room.lies[p.name]);
  if (allIn && activePlayers.length > 0) {
    clearTimer(room);
    // Show "All lies in!" transition before revealing answers
    broadcast(room, { type: 'all-lies-in' });
    room.timer = setTimeout(() => startVoting(room), 3000);
  }
}

function startVoting(room) {
  clearTimer(room);
  room.phase = 'vote';
  // Build answer list: all lies + the truth + game decoys, shuffled
  const answers = [];
  const truth = room.currentQuestion.answer;
  answers.push({ text: truth, isTrue: true, author: null });
  for (const [playerName, lie] of Object.entries(room.lies)) {
    answers.push({ text: lie, isTrue: false, author: playerName });
  }
  // Add game-generated decoy lies to pad to at least 6 total options
  const decoys = room.currentQuestion.decoys || [];
  const playerCount = Object.keys(room.lies).length;
  const totalWithoutDecoys = 1 + playerCount; // truth + player lies
  const decoysNeeded = Math.max(0, 6 - totalWithoutDecoys);
  const usedTexts = new Set(answers.map(a => normalize(a.text)));
  let decoysAdded = 0;
  for (const d of decoys) {
    if (decoysAdded >= decoysNeeded) break;
    if (!usedTexts.has(normalize(d))) {
      answers.push({ text: d, isTrue: false, author: '__GAME__' });
      usedTexts.add(normalize(d));
      decoysAdded++;
    }
  }
  // Shuffle
  room.answerList = answers.sort(() => Math.random() - 0.5);
  room.votes = {};

  // Send to host (show all answers)
  const displayAnswers = room.answerList.map((a,i) => ({ id: i, text: a.text }));
  broadcast(room, {
    type: 'vote-phase',
    question: room.currentQuestion.question,
    answers: displayAnswers,
    timeMs: 30000
  });
  // Each player shouldn't see their own lie — handled client-side by filtering
  for (const p of Object.values(room.players)) {
    if (p.ws && p.ws.readyState === 1) {
      const myAnswers = displayAnswers.filter(a => {
        const entry = room.answerList[a.id];
        return entry.author !== p.name; // hide own lie
      });
      sendTo(p.ws, { type: 'your-choices', answers: myAnswers });
    }
  }
  room.timer = setTimeout(() => doReveal(room), 30000);
}

function checkAllVotesIn(room) {
  const activePlayers = Object.values(room.players).filter(p => p.ws);
  const allIn = activePlayers.every(p => room.votes[p.name] !== undefined);
  if (allIn && activePlayers.length > 0) {
    clearTimer(room);
    room.timer = setTimeout(() => doReveal(room), 1500);
  }
}

function doReveal(room) {
  clearTimer(room);
  room.phase = 'reveal';
  const mult = roundMultiplier(room);
  const results = [];
  const truth = room.currentQuestion.answer;

  // Compute scoring
  // For each answer, who picked it
  const picks = {}; // answerId -> [playerNames]
  for (const [playerName, answerId] of Object.entries(room.votes)) {
    if (!picks[answerId]) picks[answerId] = [];
    picks[answerId].push(playerName);
  }

  // Score: picking the truth = 1000 * mult
  // Fooling someone with your lie = 500 * mult per person fooled
  const scoreChanges = {};
  for (const p of Object.values(room.players)) scoreChanges[p.name] = 0;

  for (const [answerId, voters] of Object.entries(picks)) {
    const answer = room.answerList[parseInt(answerId)];
    if (!answer) continue;
    if (answer.isTrue) {
      for (const v of voters) scoreChanges[v] = (scoreChanges[v]||0) + 1000 * mult;
    } else if (answer.author === '__GAME__') {
      // Penalty for picking a game decoy
      for (const v of voters) scoreChanges[v] = (scoreChanges[v]||0) - 500 * mult;
    } else if (answer.author) {
      scoreChanges[answer.author] = (scoreChanges[answer.author]||0) + 500 * mult * voters.length;
    }
  }

  // Apply scores
  for (const [name, change] of Object.entries(scoreChanges)) {
    if (room.players[name]) room.players[name].score += change;
  }

  // Build reveal data
  const revealData = room.answerList.map((a, i) => ({
    id: i,
    text: a.text,
    isTrue: a.isTrue,
    author: a.author,
    pickedBy: picks[i] || []
  }));

  broadcast(room, {
    type: 'reveal',
    reveals: revealData,
    truth: truth,
    scoreChanges,
    players: playerList(room)
  });

  // After reveal, show scoreboard then next question
  const revealTime = Math.max(3000, revealData.length * 3000);
  room.timer = setTimeout(() => {
    room.phase = 'scoreboard';
    broadcast(room, { type: 'scoreboard', players: playerList(room), round: room.round });
    room.timer = setTimeout(() => nextQuestion(room), 5000);
  }, revealTime);
}

function endGame(room) {
  clearTimer(room);
  room.phase = 'game-over';
  room.state = 'ended';
  const sorted = playerList(room).sort((a,b) => b.score - a.score);
  broadcast(room, { type: 'game-over', players: sorted });
}

wss.on('connection', (ws) => {
  let myRoom = null;
  let myName = null;
  let isHost = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        const code = genCode();
        const room = {
          code, hostWs: ws, players: {}, state: 'lobby', phase: 'lobby',
          round: 0, questionNum: 0, timer: null, questionPool: [],
          currentQuestion: null, lies: {}, votes: {}, answerList: [],
          categories: [], categoryVotes: {}
        };
        rooms.set(code, room);
        myRoom = code;
        isHost = true;
        sendTo(ws, { type: 'room-created', code });
        break;
      }
      case 'join-room': {
        const code = (msg.code||'').toUpperCase();
        const name = (msg.name||'').trim().substring(0, 16);
        const room = getRoom(code);
        if (!room) { sendTo(ws, { type: 'error', message: 'Room not found' }); return; }
        if (room.state !== 'lobby' && !room.players[name]) {
          sendTo(ws, { type: 'error', message: 'Game already in progress' }); return;
        }
        if (Object.keys(room.players).length >= 8 && !room.players[name]) {
          sendTo(ws, { type: 'error', message: 'Room is full (max 8)' }); return;
        }
        if (!name) { sendTo(ws, { type: 'error', message: 'Name required' }); return; }
        // Check for duplicate name with active connection (not a rejoin)
        if (room.players[name] && room.players[name].ws && room.players[name].ws.readyState === 1 && room.players[name].ws !== ws) {
          sendTo(ws, { type: 'error', message: 'Name already taken! Pick another.' }); return;
        }
        // Rejoin or new join
        if (room.players[name]) {
          room.players[name].ws = ws;
        } else {
          room.players[name] = { name, score: 0, ws };
        }
        myRoom = code;
        myName = name;
        sendTo(ws, { type: 'joined', code, name, score: room.players[name].score, phase: room.phase });
        broadcast(room, { type: 'player-list', players: playerList(room) });
        // Sync rejoining player to current game state
        if (room.state === 'playing') {
          syncPlayerToCurrentPhase(room, name);
        }
        break;
      }
      case 'host-join': {
        const code = (msg.code||'').toUpperCase();
        const room = getRoom(code);
        if (!room) { sendTo(ws, { type: 'error', message: 'Room not found' }); return; }
        room.hostWs = ws;
        myRoom = code;
        isHost = true;
        sendTo(ws, { type: 'host-joined', code, players: playerList(room), phase: room.phase, state: room.state });
        break;
      }
      case 'start-game': {
        if (!isHost || !myRoom) return;
        const room = getRoom(myRoom);
        if (!room || room.state !== 'lobby') return;
        if (Object.keys(room.players).length < 2) {
          sendTo(ws, { type: 'error', message: 'Need at least 2 players' }); return;
        }
        startGame(room);
        break;
      }
      case 'vote-category': {
        if (!myRoom || !myName) return;
        const room = getRoom(myRoom);
        if (!room || room.phase !== 'category-select') return;
        if (room.categories.includes(msg.category)) {
          room.categoryVotes[myName] = msg.category;
          // Auto-advance when all players have voted
          const activePlayers = Object.values(room.players).filter(p => p.ws);
          const allVoted = activePlayers.every(p => room.categoryVotes[p.name]);
          if (allVoted && activePlayers.length > 0) {
            clearTimer(room);
            room.timer = setTimeout(() => selectCategory(room), 1000);
          }
        }
        break;
      }
      case 'submit-lie': {
        if (!myRoom || !myName) return;
        const room = getRoom(myRoom);
        if (!room || room.phase !== 'lie') return;
        const lie = (msg.lie||'').trim();
        if (!lie || lie.length > 80) return;
        if (isTooSimilar(lie, room.currentQuestion.answer, room.currentQuestion.alternateAnswers)) {
          sendTo(ws, { type: 'lie-rejected', message: 'Too close to the real answer! Try again.' });
          return;
        }
        room.lies[myName] = lie;
        sendTo(ws, { type: 'lie-accepted' });
        // Notify host
        sendTo(room.hostWs, { type: 'lie-count', count: Object.keys(room.lies).length, total: Object.keys(room.players).length });
        checkAllLiesIn(room);
        break;
      }
      case 'submit-vote': {
        if (!myRoom || !myName) return;
        const room = getRoom(myRoom);
        if (!room || room.phase !== 'vote') return;
        const aid = parseInt(msg.answerId);
        if (isNaN(aid) || aid < 0 || aid >= room.answerList.length) return;
        // Can't vote for own lie
        if (room.answerList[aid].author === myName) return;
        room.votes[myName] = aid;
        sendTo(ws, { type: 'vote-accepted' });
        sendTo(room.hostWs, { type: 'vote-count', count: Object.keys(room.votes).length, total: Object.keys(room.players).length });
        checkAllVotesIn(room);
        break;
      }
      case 'play-again': {
        if (!isHost || !myRoom) return;
        const room = getRoom(myRoom);
        if (!room) return;
        room.state = 'lobby';
        room.phase = 'lobby';
        room.round = 0;
        room.questionNum = 0;
        for (const p of Object.values(room.players)) p.score = 0;
        broadcast(room, { type: 'back-to-lobby', players: playerList(room) });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myRoom && myName) {
      const room = getRoom(myRoom);
      if (room && room.players[myName]) {
        room.players[myName].ws = null;
        broadcast(room, { type: 'player-list', players: playerList(room) });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Sounds Legit server running on port ${PORT}`));
