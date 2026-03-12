const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3002;

const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, req.url === '/' ? 'poker.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ─── DECK ─────────────────────────────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, val: RANK_VAL[r] });
  return d;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── HAND EVALUATION ─────────────────────────────────────────────────────────
function getBestHand(cards) {
  // cards = up to 7 cards, find best 5-card hand
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = evalHand(combo);
    if (!best || compareScore(score, best.score) > 0) best = { score, cards: combo };
  }
  return best;
}

function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [...combinations(rest, k-1).map(c => [first, ...c]), ...combinations(rest, k)];
}

function evalHand(cards) {
  const vals = cards.map(c => c.val).sort((a,b) => b-a);
  const suits = cards.map(c => c.suit);
  const rankCounts = {};
  vals.forEach(v => { rankCounts[v] = (rankCounts[v]||0)+1; });
  const counts = Object.values(rankCounts).sort((a,b) => b-a);
  const uniqueVals = [...new Set(vals)].sort((a,b) => b-a);
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = uniqueVals.length === 5 && (uniqueVals[0] - uniqueVals[4] === 4);
  // Wheel straight A-2-3-4-5
  const isWheel = JSON.stringify(uniqueVals) === JSON.stringify([14,5,4,3,2]);

  if (isFlush && (isStraight || isWheel)) {
    const high = isWheel ? 5 : uniqueVals[0];
    return [8, high];
  }
  if (counts[0] === 4) return [7, ...sortByCount(rankCounts)];
  if (counts[0] === 3 && counts[1] === 2) return [6, ...sortByCount(rankCounts)];
  if (isFlush) return [5, ...uniqueVals];
  if (isStraight || isWheel) return [4, isWheel ? 5 : uniqueVals[0]];
  if (counts[0] === 3) return [3, ...sortByCount(rankCounts)];
  if (counts[0] === 2 && counts[1] === 2) return [2, ...sortByCount(rankCounts)];
  if (counts[0] === 2) return [1, ...sortByCount(rankCounts)];
  return [0, ...uniqueVals];
}

function sortByCount(rankCounts) {
  return Object.entries(rankCounts)
    .sort((a,b) => b[1]-a[1] || b[0]-a[0])
    .map(([v]) => parseInt(v));
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i]||0) !== (b[i]||0)) return (a[i]||0) - (b[i]||0);
  }
  return 0;
}

const HAND_NAMES = ['Carta alta','Par','Doble par','Trío','Escalera','Color','Full','Póker','Escalera de color'];

// ─── ROOMS ────────────────────────────────────────────────────────────────────
const rooms = {};

function createRoom(code, maxPlayers) {
  return {
    code, maxPlayers: Math.min(9, Math.max(2, maxPlayers||6)),
    players: [],
    state: 'waiting',
    deck: [],
    community: [],
    pot: 0,
    sidePots: [],
    currentBet: 0,
    minRaise: 20,
    round: 0,
    dealer: 0,
    currentTurn: -1,
    street: 'preflop', // preflop, flop, turn, river, showdown
    smallBlind: 10,
    bigBlind: 20,
    lastRaiseIdx: -1,
    actionsThisStreet: 0,
    readyForNext: [],
    log: [],
  };
}

function broadcast(room, msg) {
  room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); });
}
function sendTo(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }
function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 80) room.log.shift();
  broadcast(room, { type: 'log', msg });
}

function buildStateFor(room, player) {
  const myIdx = room.players.indexOf(player);
  const activePlayers = room.players.filter(p => !p.folded && !p.eliminated);
  return {
    roomCode: room.code, maxPlayers: room.maxPlayers,
    gameState: room.state,
    street: room.street,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name,
      chips: p.chips,
      bet: p.bet || 0,
      folded: p.folded || false,
      allIn: p.allIn || false,
      eliminated: p.eliminated || false,
      isDealer: i === room.dealer,
      isYou: p.id === player.id,
      hand: p.id === player.id ? p.hand : (room.state === 'showdown' && !p.folded ? p.hand : null),
      handName: room.state === 'showdown' && !p.folded ? p.handName : null,
      cardCount: p.hand ? p.hand.length : 0,
    })),
    community: room.community,
    pot: room.pot,
    currentBet: room.currentBet,
    minRaise: room.minRaise,
    currentTurn: room.currentTurn,
    myIdx,
    round: room.round,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    winners: room.winners || null,
  };
}
function sendState(room) {
  room.players.forEach(p => sendTo(p, { type: 'state', state: buildStateFor(room, p) }));
}

// ─── GAME LOGIC ───────────────────────────────────────────────────────────────
function startGame(room) {
  room.players.forEach(p => { p.chips = 1000; p.eliminated = false; });
  room.round = 0;
  room.dealer = 0;
  addLog(room, `🃏 ¡Comienza el poker! ${room.players.length} jugadores, 1,000 fichas cada uno`);
  startHand(room);
}

function startHand(room) {
  const activePlayers = room.players.filter(p => !p.eliminated);
  if (activePlayers.length < 2) {
    const winner = activePlayers[0] || room.players.reduce((b,p) => p.chips > b.chips ? p : b);
    broadcast(room, { type: 'game_over', winner: winner.name, chips: winner.chips });
    addLog(room, `🏆 ¡${winner.name} gana la partida!`);
    room.state = 'game_over';
    sendState(room); return;
  }

  room.round++;
  room.deck = shuffle(makeDeck());
  room.community = [];
  room.pot = 0;
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.winners = null;
  room.readyForNext = [];
  room.state = 'playing';
  room.street = 'preflop';

  // Reset players
  activePlayers.forEach(p => {
    p.hand = [room.deck.pop(), room.deck.pop()];
    p.folded = false;
    p.allIn = false;
    p.bet = 0;
    p.totalBet = 0;
    p.handName = null;
    p.actedThisStreet = false;
  });
  room.players.filter(p => p.eliminated).forEach(p => { p.hand = []; p.bet = 0; p.folded = true; });

  // Advance dealer to next active player
  const n = room.players.length;
  let d = room.dealer;
  do { d = (d + 1) % n; } while (room.players[d].eliminated);
  room.dealer = d;

  // Blinds — heads-up: dealer = SB, other = BB. 3+ players: dealer+1 = SB, dealer+2 = BB
  const active = activePlayers.filter(p => !p.eliminated);
  const dealerPos = active.indexOf(room.players[room.dealer]);
  let sbPlayer, bbPlayer;
  if (active.length === 2) {
    // Heads-up: dealer posts SB, other posts BB
    sbPlayer = active[dealerPos];
    bbPlayer = active[(dealerPos + 1) % 2];
  } else {
    sbPlayer = active[(dealerPos + 1) % active.length];
    bbPlayer = active[(dealerPos + 2) % active.length];
  }

  postBlind(room, sbPlayer, room.smallBlind, 'small blind');
  postBlind(room, bbPlayer, room.bigBlind, 'big blind');
  room.currentBet = room.bigBlind;
  room.lastRaiseIdx = room.players.indexOf(bbPlayer);

  addLog(room, `🃏 Mano ${room.round} — Dealer: ${room.players[room.dealer].name}`);

  // First to act preflop: after BB
  const bbIdx = room.players.indexOf(bbPlayer);
  setNextTurn(room, bbIdx);
  sendState(room);
}

function postBlind(room, player, amount, label) {
  const actual = Math.min(amount, player.chips);
  player.chips -= actual;
  player.bet = actual;
  player.totalBet = actual;
  room.pot += actual;
  if (player.chips === 0) player.allIn = true;
  // Blinds count as forced bets, NOT as voluntary actions — actedThisStreet stays false
  addLog(room, `  ${player.name} posta ${label}: ${actual}`);
}

function setNextTurn(room, afterIdx) {
  const n = room.players.length;
  let idx = (afterIdx + 1) % n;
  let checked = 0;
  while (checked < n) {
    const p = room.players[idx];
    if (!p.folded && !p.allIn && !p.eliminated) {
      room.currentTurn = idx;
      return;
    }
    idx = (idx + 1) % n;
    checked++;
  }
  // No one can act — advance street
  room.currentTurn = -1;
  advanceStreet(room);
}

function allActed(room) {
  const active = room.players.filter(p => !p.folded && !p.eliminated);
  const canAct = active.filter(p => !p.allIn);
  if (canAct.length === 0) return true;
  const betsMatch = canAct.every(p => p.bet === room.currentBet);
  const allHadTurn = canAct.every(p => p.actedThisStreet);
  return betsMatch && allHadTurn;
}

// ─── SIDE POTS ────────────────────────────────────────────────────────────────
function calcSidePots(room) {
  // Build side pots from totalBet amounts
  const active = room.players.filter(p => !p.folded && !p.eliminated && p.totalBet > 0);
  const allIn = active.filter(p => p.allIn).sort((a,b) => a.totalBet - b.totalBet);
  if (allIn.length === 0) return null; // no side pots needed

  const pots = [];
  let covered = 0;
  for (const allinP of allIn) {
    const level = allinP.totalBet;
    if (level <= covered) continue;
    const contribution = level - covered;
    const eligible = room.players.filter(p => !p.eliminated && !p.folded && p.totalBet >= level);
    // Amount = contribution from ALL players who put in at least this level (including folded — they already contributed)
    const contributors = room.players.filter(p => !p.eliminated && p.totalBet >= level);
    const amount = contribution * contributors.length;
    pots.push({ amount, eligible: eligible.map(p => p.id) });
    covered = level;
  }

  // Main pot for remaining players above last all-in level
  const remaining = room.players.filter(p => !p.eliminated && !p.folded && p.totalBet > covered);
  if (remaining.length > 0) {
    const extra = room.players.reduce((sum, p) => sum + Math.max(0, (p.totalBet||0) - covered), 0);
    if (extra > 0) pots.push({ amount: extra, eligible: remaining.map(p => p.id) });
  }

  return pots.length > 0 ? pots : null;
}

function advanceStreet(room) {
  const active = room.players.filter(p => !p.folded && !p.eliminated);
  if (active.length === 1) { endHand(room); return; }

  // Reset bets and actions for new street
  room.players.forEach(p => { p.bet = 0; p.actedThisStreet = false; });
  room.currentBet = 0;
  room.minRaise = room.bigBlind;

  if (room.street === 'preflop') {
    room.street = 'flop';
    room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    addLog(room, `🂠 Flop: ${room.community.map(cardStr).join(' ')}`);
  } else if (room.street === 'flop') {
    room.street = 'turn';
    room.community.push(room.deck.pop());
    addLog(room, `🂠 Turn: ${cardStr(room.community[3])}`);
  } else if (room.street === 'turn') {
    room.street = 'river';
    room.community.push(room.deck.pop());
    addLog(room, `🂠 River: ${cardStr(room.community[4])}`);
  } else {
    endHand(room); return;
  }

  // First to act post-flop: first active after dealer
  const n = room.players.length;
  let idx = (room.dealer + 1) % n;
  let checked = 0;
  while (checked < n) {
    const p = room.players[idx];
    if (!p.folded && !p.allIn && !p.eliminated) { room.currentTurn = idx; sendState(room); return; }
    idx = (idx + 1) % n;
    checked++;
  }
  // All remaining players are all-in — run out the board
  room.currentTurn = -1;
  advanceStreet(room);
}

function cardStr(c) { return `${c.rank}${c.suit}`; }

function endHand(room) {
  room.street = 'showdown';
  const active = room.players.filter(p => !p.folded && !p.eliminated);

  // Evaluate hands
  active.forEach(p => {
    const allCards = [...p.hand, ...room.community];
    if (allCards.length >= 5) {
      const best = getBestHand(allCards);
      p.bestScore = best.score;
      p.handName = HAND_NAMES[best.score[0]];
    } else {
      // Not enough community cards (e.g. everyone folded early)
      p.bestScore = [0];
      p.handName = 'Carta alta';
    }
  });

  // ── SIDE POTS ──
  const sidePots = calcSidePots(room);
  const winnersAll = [];

  if (sidePots && sidePots.length > 0) {
    addLog(room, `💰 Calculando botes separados (${sidePots.length})...`);
    sidePots.forEach((pot, i) => {
      const eligible = active.filter(p => pot.eligible.includes(p.id));
      if (eligible.length === 0) return;
      let bestScore = null;
      eligible.forEach(p => { if (!bestScore || compareScore(p.bestScore, bestScore) > 0) bestScore = p.bestScore; });
      const winners = eligible.filter(p => compareScore(p.bestScore, bestScore) === 0);
      const share = Math.floor(pot.amount / winners.length);
      winners.forEach(p => {
        p.chips += share;
        addLog(room, `🏆 ${p.name} gana bote${sidePots.length>1?' '+(i+1):''}: ${share} fichas con ${p.handName}`);
        if (!winnersAll.find(w => w.name === p.name)) winnersAll.push({ name: p.name, handName: p.handName, chips: p.chips });
      });
    });
  } else {
    // Simple single pot
    let bestScore = null;
    active.forEach(p => { if (!bestScore || compareScore(p.bestScore, bestScore) > 0) bestScore = p.bestScore; });
    const winners = active.filter(p => compareScore(p.bestScore, bestScore) === 0);
    const share = Math.floor(room.pot / winners.length);
    winners.forEach(p => {
      p.chips += share;
      addLog(room, `🏆 ${p.name} gana ${share} fichas con ${p.handName}!`);
      winnersAll.push({ name: p.name, handName: p.handName, chips: p.chips });
    });
  }

  room.winners = winnersAll;

  // Eliminate broke players
  room.players.forEach(p => { if (p.chips <= 0 && !p.eliminated) { p.eliminated = true; addLog(room, `💀 ${p.name} eliminado`); } });

  room.state = 'hand_end';
  room.currentTurn = -1;
  sendState(room);
  broadcast(room, { type: 'hand_end', winners: room.winners, pot: room.pot });
}

function handleAction(room, playerIdx, action, amount) {
  const player = room.players[playerIdx];

  player.actedThisStreet = true;

  if (action === 'fold') {
    player.folded = true;
    addLog(room, `${player.name} se retira`);
    const active = room.players.filter(p => !p.folded && !p.eliminated);
    if (active.length === 1) { endHand(room); return; }

  } else if (action === 'check') {
    addLog(room, `${player.name} pasa`);

  } else if (action === 'call') {
    const toCall = Math.min(room.currentBet - player.bet, player.chips);
    player.chips -= toCall;
    player.bet += toCall;
    player.totalBet = (player.totalBet || 0) + toCall;
    room.pot += toCall;
    if (player.chips === 0) player.allIn = true;
    addLog(room, `${player.name} iguala ${room.currentBet}`);

  } else if (action === 'raise') {
    const raiseTotal = Math.min(amount, player.chips + player.bet);
    const toAdd = raiseTotal - player.bet;
    player.chips -= toAdd;
    room.pot += toAdd;
    player.totalBet = (player.totalBet || 0) + toAdd;
    room.minRaise = raiseTotal - room.currentBet;
    room.currentBet = raiseTotal;
    player.bet = raiseTotal;
    if (player.chips === 0) player.allIn = true;
    room.lastRaiseIdx = playerIdx;
    addLog(room, `${player.name} sube a ${raiseTotal}`);
    // Bug 2 fix: when someone raises, reset actedThisStreet for all OTHER active players
    room.players.forEach((p, i) => { if (i !== playerIdx && !p.folded && !p.eliminated && !p.allIn) p.actedThisStreet = false; });

  } else if (action === 'allin') {
    const toAdd = player.chips;
    player.bet += toAdd;
    player.totalBet = (player.totalBet || 0) + toAdd;
    room.pot += toAdd;
    if (player.bet > room.currentBet) {
      room.minRaise = player.bet - room.currentBet;
      room.currentBet = player.bet;
      room.lastRaiseIdx = playerIdx;
      // Reset others so they can respond to the all-in raise
      room.players.forEach((p, i) => { if (i !== playerIdx && !p.folded && !p.eliminated && !p.allIn) p.actedThisStreet = false; });
    }
    player.chips = 0;
    player.allIn = true;
    addLog(room, `${player.name} va ALL-IN con ${player.bet}`);
  }

  // Check if street is over
  if (allActed(room)) {
    advanceStreet(room);
  } else {
    setNextTurn(room, playerIdx);
    sendState(room);
  }
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
let counter = 0;

wss.on('connection', ws => {
  const playerId = `p${++counter}`;
  let playerRoom = null;
  let playerData = null;

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'createRoom') {
      const code = Math.random().toString(36).substring(2,6).toUpperCase();
      rooms[code] = createRoom(code, msg.maxPlayers || 6);
      const room = rooms[code];
      const p = { id: playerId, ws, name: msg.name || 'Jugador', chips: 1000, hand: [], folded: false, eliminated: false, bet: 0, totalBet: 0 };
      room.players.push(p);
      playerRoom = room; playerData = p;
      sendTo(p, { type: 'joined', roomCode: code, playerId });
      sendState(room); return;
    }

    if (msg.type === 'joinRoom') {
      const room = rooms[msg.code];
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala no encontrada' })); return; }
      if (room.players.length >= room.maxPlayers) { ws.send(JSON.stringify({ type: 'error', msg: 'Sala llena' })); return; }
      if (room.state !== 'waiting') { ws.send(JSON.stringify({ type: 'error', msg: 'Partida en curso' })); return; }
      const p = { id: playerId, ws, name: msg.name || 'Jugador', chips: 1000, hand: [], folded: false, eliminated: false, bet: 0, totalBet: 0 };
      room.players.push(p);
      playerRoom = room; playerData = p;
      sendTo(p, { type: 'joined', roomCode: room.code, playerId });
      addLog(room, `👤 ${p.name} se unió`);
      sendState(room);
      return;
    }

    if (msg.type === 'startGame') {
      if (!playerRoom || playerRoom.state !== 'waiting') return;
      if (playerRoom.players.length < 2) { sendTo(playerData, { type: 'error', msg: 'Se necesitan al menos 2 jugadores' }); return; }
      startGame(playerRoom); return;
    }

    if (!playerRoom || !playerData) return;

    if (msg.type === 'action') {
      if (playerRoom.state !== 'playing') return;
      const pidx = playerRoom.players.indexOf(playerData);
      if (pidx !== playerRoom.currentTurn) { sendTo(playerData, { type: 'error', msg: 'No es tu turno' }); return; }
      handleAction(playerRoom, pidx, msg.action, msg.amount);
      return;
    }

    if (msg.type === 'nextHand') {
      if (playerRoom.state !== 'hand_end') return;
      if (!playerRoom.readyForNext.includes(playerId)) {
        playerRoom.readyForNext.push(playerId);
        broadcast(playerRoom, { type: 'ready_count', count: playerRoom.readyForNext.length, total: playerRoom.players.filter(p => !p.eliminated).length });
      }
      if (playerRoom.readyForNext.length >= playerRoom.players.filter(p => !p.eliminated).length) {
        startHand(playerRoom);
      }
      return;
    }

    if (msg.type === 'chat') {
      broadcast(playerRoom, { type: 'chat', from: playerData.name, msg: msg.text });
      return;
    }
  });

  ws.on('close', () => {
    if (!playerRoom || !playerData) return;
    broadcast(playerRoom, { type: 'log', msg: `⚠️ ${playerData.name} se fue` });
    playerRoom.players = playerRoom.players.filter(p => p.id !== playerId);
    if (playerRoom.players.length === 0) { delete rooms[playerRoom.code]; return; }
    if (playerRoom.currentTurn >= playerRoom.players.length) playerRoom.currentTurn = 0;
    sendState(playerRoom);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => console.log(`♠ Poker Server — puerto ${PORT}`));
