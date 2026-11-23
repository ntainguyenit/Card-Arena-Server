const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());

const rooms = new Map();
const waitingByBet = new Map();

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', game: 'card-arena-2d', rooms: rooms.size });
});

const server = http.createServer(app);
const io = new Server(server, {
    allowEIO3: true,
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const SUITS = [
    { code: 'S', power: 4 },
    { code: 'H', power: 3 },
    { code: 'D', power: 2 },
    { code: 'C', power: 1 }
];

const VALID_BETS = [50, 150, 500];

function sanitizeBet(raw) {
    return VALID_BETS.includes(raw) ? raw : 50;
}

function createShuffledDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (let value = 2; value <= 14; value++) {
            deck.push({
                id: `${value}_${suit.code}`,
                value,
                suit: suit.code,
                suitPower: suit.power
            });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = deck[i];
        deck[i] = deck[j];
        deck[j] = tmp;
    }
    return deck;
}

function getEffectivePower(card, trumpSuit) {
    return card.value + (card.suit === trumpSuit ? 4 : 0);
}

function compareCards(a, b, trumpSuit) {
    const pA = getEffectivePower(a, trumpSuit);
    const pB = getEffectivePower(b, trumpSuit);
    if (pA !== pB) {
        return pA > pB ? 1 : -1;
    }
    if (a.value !== b.value) {
        return a.value > b.value ? 1 : -1;
    }
    return a.suitPower > b.suitPower ? 1 : -1;
}

function removeFromQueues(socketId) {
    for (const [bet, entry] of waitingByBet.entries()) {
        if (entry && entry.socket.id === socketId) {
            waitingByBet.delete(bet);
        }
    }
}

function createRoom(p1Socket, p1Name, p2Socket, p2Name, isBotMatch, bet) {
    const deck = createShuffledDeck();
    const trumpSuit = SUITS[Math.floor(Math.random() * SUITS.length)].code;
    const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const room = {
        id: roomId,
        isBotMatch,
        bet,
        totalPot: bet * 2,
        doubled: false,
        trumpSuit,
        round: 1,
        maxRounds: 5,
        finished: false,
        players: [
            {
                socketId: p1Socket.id,
                name: p1Name || 'Người chơi 1',
                hand: deck.slice(0, 5),
                score: 0,
                pickedCard: null,
                isBot: false
            },
            {
                socketId: p2Socket ? p2Socket.id : 'BOT_AI',
                name: p2Name || (isBotMatch ? 'Ocean Bot' : 'Người chơi 2'),
                hand: deck.slice(5, 10),
                score: 0,
                pickedCard: null,
                isBot: isBotMatch
            }
        ]
    };

    rooms.set(roomId, room);
    p1Socket.join(roomId);
    if (p2Socket) {
        p2Socket.join(roomId);
    }

    p1Socket.emit('match_start', {
        roomId,
        isBotMatch,
        bet: room.bet,
        totalPot: room.totalPot,
        trumpSuit: room.trumpSuit,
        round: room.round,
        myName: room.players[0].name,
        oppName: room.players[1].name,
        hand: room.players[0].hand,
        myScore: 0,
        oppScore: 0
    });

    if (p2Socket) {
        p2Socket.emit('match_start', {
            roomId,
            isBotMatch,
            bet: room.bet,
            totalPot: room.totalPot,
            trumpSuit: room.trumpSuit,
            round: room.round,
            myName: room.players[1].name,
            oppName: room.players[0].name,
            hand: room.players[1].hand,
            myScore: 0,
            oppScore: 0
        });
    }
}

function chooseBotCard(botHand, trumpSuit) {
    if (botHand.length === 1) return 0;
    const scored = botHand.map((c, idx) => ({ idx, power: getEffectivePower(c, trumpSuit) }));
    scored.sort((a, b) => b.power - a.power);
    return Math.random() < 0.65 ? scored[0].idx : scored[Math.floor(Math.random() * scored.length)].idx;
}

function resolveRound(room) {
    const p0 = room.players[0];
    const p1 = room.players[1];
    if (!p0.pickedCard || !p1.pickedCard || room.finished) {
        return;
    }

    const cmp = compareCards(p0.pickedCard, p1.pickedCard, room.trumpSuit);
    if (cmp > 0) {
        p0.score += 1;
    } else {
        p1.score += 1;
    }

    const isMatchOver = p0.score >= 3 || p1.score >= 3 || room.round >= room.maxRounds;
    let winnerIndex = -1;
    if (isMatchOver) {
        room.finished = true;
        if (p0.score > p1.score) winnerIndex = 0;
        else if (p1.score > p0.score) winnerIndex = 1;
    }

    const emitResultFor = (idx) => {
        const me = room.players[idx];
        const opp = room.players[1 - idx];
        if (me.isBot) return;
        const roundWinner = (idx === 0 ? cmp > 0 : cmp < 0) ? 'me' : 'opp';
        const matchWinner = !isMatchOver
            ? null
            : winnerIndex === idx
                ? 'me'
                : winnerIndex === 1 - idx
                    ? 'opp'
                    : 'draw';

        io.to(me.socketId).emit('round_result', {
            roomId: room.id,
            round: room.round,
            myCard: me.pickedCard,
            oppCard: opp.pickedCard,
            myPower: getEffectivePower(me.pickedCard, room.trumpSuit),
            oppPower: getEffectivePower(opp.pickedCard, room.trumpSuit),
            myIsTrump: me.pickedCard.suit === room.trumpSuit,
            oppIsTrump: opp.pickedCard.suit === room.trumpSuit,
            roundWinner,
            myScore: me.score,
            oppScore: opp.score,
            isMatchOver,
            matchWinner,
            totalPot: room.totalPot
        });
    };

    emitResultFor(0);
    emitResultFor(1);

    p0.pickedCard = null;
    p1.pickedCard = null;

    if (isMatchOver) {
        rooms.delete(room.id);
    } else {
        room.round += 1;
    }
}

io.on('connection', (socket) => {
    socket.on('join_bot', (payload) => {
        const bet = sanitizeBet(payload?.bet);
        const name = payload?.name || 'Bạn';
        removeFromQueues(socket.id);
        createRoom(socket, name, null, 'Ocean Bot', true, bet);
    });

    socket.on('join_pvp', (payload) => {
        const bet = sanitizeBet(payload?.bet);
        const name = payload?.name || `Thuyền trưởng ${socket.id.slice(0, 4)}`;
        removeFromQueues(socket.id);

        const waiting = waitingByBet.get(bet);
        if (waiting && waiting.socket.connected && waiting.socket.id !== socket.id) {
            waitingByBet.delete(bet);
            createRoom(waiting.socket, waiting.name, socket, name, false, bet);
        } else {
            waitingByBet.set(bet, { socket, name });
            socket.emit('waiting_opponent', { bet });
        }
    });

    socket.on('cancel_queue', () => {
        removeFromQueues(socket.id);
    });

    socket.on('double_pot', (payload) => {
        const room = rooms.get(payload?.roomId);
        if (!room || room.finished || room.doubled) return;
        const idx = room.players.findIndex((p) => p.socketId === socket.id);
        if (idx === -1) return;

        room.doubled = true;
        const extraBet = room.bet;
        room.totalPot = room.bet * 4;

        room.players.forEach((p, i) => {
            if (p.isBot) return;
            io.to(p.socketId).emit('pot_doubled', {
                roomId: room.id,
                byMe: i === idx,
                byName: room.players[idx].name,
                extraBet,
                totalPot: room.totalPot
            });
        });
    });

    socket.on('play_card', (payload) => {
        const room = rooms.get(payload?.roomId);
        if (!room || room.finished) return;

        const playerIdx = room.players.findIndex((p) => p.socketId === socket.id);
        if (playerIdx === -1) return;

        const player = room.players[playerIdx];
        const opp = room.players[1 - playerIdx];
        if (player.pickedCard) return;

        const cardIdx = player.hand.findIndex((c) => c.id === payload?.cardId);
        if (cardIdx === -1) return;

        player.pickedCard = player.hand.splice(cardIdx, 1)[0];

        if (room.isBotMatch && opp.isBot && !opp.pickedCard && opp.hand.length > 0) {
            const botIdx = chooseBotCard(opp.hand, room.trumpSuit);
            opp.pickedCard = opp.hand.splice(botIdx, 1)[0];
            setTimeout(() => resolveRound(room), 480);
        } else {
            if (!opp.isBot) {
                io.to(opp.socketId).emit('opponent_picked', { roomId: room.id });
            }
            if (opp.pickedCard) {
                setTimeout(() => resolveRound(room), 320);
            }
        }
    });

    socket.on('quick_emote', (payload) => {
        const room = rooms.get(payload?.roomId);
        if (!room) return;
        const playerIdx = room.players.findIndex((p) => p.socketId === socket.id);
        if (playerIdx === -1) return;
        const opp = room.players[1 - playerIdx];
        if (!opp.isBot) {
            io.to(opp.socketId).emit('opponent_emote', { text: String(payload?.text || '').slice(0, 32) });
        }
    });

    socket.on('disconnect', () => {
        removeFromQueues(socket.id);
        for (const [roomId, room] of rooms.entries()) {
            const idx = room.players.findIndex((p) => p.socketId === socket.id);
            if (idx !== -1 && !room.finished) {
                room.finished = true;
                const opp = room.players[1 - idx];
                if (!opp.isBot) {
                    io.to(opp.socketId).emit('opponent_left', { roomId, totalPot: room.totalPot });
                }
                rooms.delete(roomId);
            }
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Card Arena 2D server running on http://localhost:${PORT}`);
});