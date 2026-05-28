const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 3456;
const COLORS = ['red', 'blue', 'green', 'yellow'];
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2'];
const WILD_VALUES = ['wild', 'wild4'];

function createDeck() {
    const deck = [];
    let id = 0;
    for (const color of COLORS) {
        for (const value of VALUES) {
            if (value === '0') {
                deck.push({ id: id++, color, value, display: `${color}_${value}` });
            } else {
                deck.push({ id: id++, color, value, display: `${color}_${value}` });
                deck.push({ id: id++, color, value, display: `${color}_${value}` });
            }
        }
    }
    for (const value of WILD_VALUES) {
        for (let i = 0; i < 4; i++) {
            deck.push({ id: id++, color: 'wild', value, display: value });
        }
    }
    return deck;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function canPlayCard(card, topCard, chosenColor) {
    if (!topCard) return true;
    if (card.color === 'wild') return true;
    const effectiveColor = chosenColor || topCard.chosenColor || topCard.color;
    if (card.color === effectiveColor) return true;
    if (card.value === topCard.value) return true;
    if (topCard.color === 'wild' && topCard.chosenColor && card.color === topCard.chosenColor) return true;
    return false;
}

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

const rooms = new Map();
const players = new Map();

function createRoom() {
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    const room = {
        code,
        players: [],
        hostId: null,
        state: 'waiting',
        deck: [],
        discardPile: [],
        currentTurn: 0,
        direction: 1,
        turnTimer: null,
        timeLeft: 30,
        scores: {},
        chatHistory: [],
    };
    rooms.set(code, room);
    return room;
}

function getRoomByPlayer(playerId) {
    for (const [code, room] of rooms) {
        if (room.players.find(p => p.id === playerId)) return room;
    }
    return null;
}

function broadcast(room, data, excludeId = null) {
    const msg = JSON.stringify(data);
    for (const p of room.players) {
        if (excludeId && p.id === excludeId) continue;
        const ws = players.get(p.id);
        if (ws && ws.readyState === 1) ws.send(msg);
    }
}

function sendTo(playerId, data) {
    const ws = players.get(playerId);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getGameState(room, forPlayerId) {
    const state = {
        type: 'game_state',
        currentTurn: room.currentTurn,
        direction: room.direction,
        topCard: room.discardPile[room.discardPile.length - 1] || null,
        discardCount: room.discardPile.length,
        drawCount: room.deck.length,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.cards.length,
            calledUno: p.calledUno,
            isReady: p.isReady,
            isHost: p.id === room.hostId,
        })),
        timeLeft: room.timeLeft,
        state: room.state,
    };
    const player = room.players.find(p => p.id === forPlayerId);
    if (player) {
        state.yourHand = player.cards;
        state.yourId = forPlayerId;
    }
    return state;
}

function startTurnTimer(room) {
    clearInterval(room.turnTimer);
    room.timeLeft = 30;
    broadcast(room, { type: 'timer_update', timeLeft: room.timeLeft });
    room.turnTimer = setInterval(() => {
        room.timeLeft--;
        broadcast(room, { type: 'timer_update', timeLeft: room.timeLeft });
        if (room.timeLeft <= 0) {
            clearInterval(room.turnTimer);
            forceDraw(room);
        }
    }, 1000);
}

function forceDraw(room) {
    const currentPlayer = room.players[room.currentTurn];
    if (!currentPlayer) return;
    const drawn = drawCards(room, 1);
    if (drawn.length > 0) {
        currentPlayer.cards.push(...drawn);
        broadcast(room, { type: 'card_drawn', playerId: currentPlayer.id, count: 1 });
        broadcast(room, getGameState(room, currentPlayer.id));
    }
    broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${currentPlayer.name} 超时自动抽牌` });
    nextTurn(room);
}

function drawCards(room, count) {
    const drawn = [];
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) {
            if (room.discardPile.length <= 1) break;
            const topCard = room.discardPile.pop();
            room.deck = shuffle(room.discardPile);
            room.discardPile = [topCard];
            broadcast(room, { type: 'deck_reshuffled' });
        }
        drawn.push(room.deck.pop());
    }
    return drawn;
}

function nextTurn(room) {
    clearInterval(room.turnTimer);
    const totalPlayers = room.players.length;
    room.currentTurn = ((room.currentTurn + room.direction) % totalPlayers + totalPlayers) % totalPlayers;

    const currentPlayer = room.players[room.currentTurn];
    broadcast(room, { type: 'turn_changed', playerId: currentPlayer.id, direction: room.direction });
    broadcast(room, getGameState(room, currentPlayer.id));

    for (const p of room.players) {
        sendTo(p.id, getGameState(room, p.id));
    }
    startTurnTimer(room);
}

function handlePlayCard(room, player, cardIndex, chosenColor) {
    if (room.state !== 'playing') return;
    if (room.players[room.currentTurn].id !== player.id) {
        sendTo(player.id, { type: 'error', message: '还没轮到你' });
        return;
    }
    if (cardIndex < 0 || cardIndex >= player.cards.length) {
        sendTo(player.id, { type: 'error', message: '无效的卡牌' });
        return;
    }

    const card = player.cards[cardIndex];
    const topCard = room.discardPile[room.discardPile.length - 1];

    if (card.color === 'wild') {
        if (!chosenColor || !COLORS.includes(chosenColor)) {
            sendTo(player.id, { type: 'need_color', cardIndex });
            return;
        }
    }

    if (!canPlayCard(card, topCard, chosenColor)) {
        sendTo(player.id, { type: 'error', message: '不能出这张牌，颜色或数字不匹配' });
        return;
    }

    player.cards.splice(cardIndex, 1);

    const playedCard = { ...card };
    if (chosenColor) playedCard.chosenColor = chosenColor;

    room.discardPile.push(playedCard);

    broadcast(room, {
        type: 'card_played',
        playerId: player.id,
        playerName: player.name,
        card: playedCard,
        chosenColor: chosenColor || null,
    });

    const cardName = card.color === 'wild' ? (card.value === 'wild4' ? '+4万能牌' : '万能牌') : `${card.color} ${card.value}`;
    broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${player.name} 出了 ${cardName}${chosenColor ? ' (选' + chosenColor + ')' : ''}` });

    if (player.cards.length === 0) {
        endGame(room, player);
        return;
    }

    if (player.cards.length === 1 && !player.calledUno) {
        player.cards.push(...drawCards(room, 2));
        broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${player.name} 剩1张牌没说UNO！罚抽2张` });
        broadcast(room, { type: 'uno_penalty', playerId: player.id, count: 2 });
    }

    applyCardEffect(room, card, chosenColor, player);

    if (player.cards.length === 0) {
        endGame(room, player);
    }
}

function applyCardEffect(room, card, chosenColor, player) {
    switch (card.value) {
        case 'skip': {
            const skippedIdx = ((room.currentTurn + room.direction) % room.players.length + room.players.length) % room.players.length;
            const skipped = room.players[skippedIdx];
            broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${skipped.name} 被跳过!` });
            room.currentTurn = skippedIdx;
            break;
        }
        case 'reverse': {
            room.direction *= -1;
            broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: '方向反转!' });
            if (room.players.length === 2) {
                const skippedIdx = ((room.currentTurn + room.direction) % room.players.length + room.players.length) % room.players.length;
                room.currentTurn = skippedIdx;
                broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${room.players[room.currentTurn].name} 被跳过!` });
            }
            break;
        }
        case 'draw2': {
            const targetIdx = ((room.currentTurn + room.direction) % room.players.length + room.players.length) % room.players.length;
            const target = room.players[targetIdx];
            const drawn = drawCards(room, 2);
            target.cards.push(...drawn);
            broadcast(room, { type: 'card_drawn', playerId: target.id, count: 2 });
            broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${target.name} 被罚抽2张!` });
            room.currentTurn = targetIdx;
            break;
        }
        case 'wild4': {
            const targetIdx = ((room.currentTurn + room.direction) % room.players.length + room.players.length) % room.players.length;
            const target = room.players[targetIdx];
            const drawn = drawCards(room, 4);
            target.cards.push(...drawn);
            broadcast(room, { type: 'card_drawn', playerId: target.id, count: 4 });
            broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${target.name} 被罚抽4张!` });
            room.currentTurn = targetIdx;
            break;
        }
    }
    nextTurn(room);
}

function endGame(room, winner) {
    clearInterval(room.turnTimer);
    room.state = 'finished';

    const scores = {};
    for (const p of room.players) {
        let total = 0;
        for (const c of p.cards) {
            if (c.value === 'draw2' || c.value === 'skip' || c.value === 'reverse') total += 20;
            else if (c.value === 'wild' || c.value === 'wild4') total += 50;
            else total += parseInt(c.value) || 0;
        }
        scores[p.id] = total;
    }

    room.scores[winner.id] = (room.scores[winner.id] || 0) + Object.values(scores).reduce((a, b) => a + b, 0) - scores[winner.id];

    broadcast(room, {
        type: 'game_over',
        winnerId: winner.id,
        winnerName: winner.name,
        scores,
        totalScores: room.scores,
    });

    for (const p of room.players) {
        sendTo(p.id, getGameState(room, p.id));
    }
}

// ========== HTTP + WebSocket Server ==========
const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/uno-game.html' : req.url;
    filePath = path.join(__dirname, filePath);

    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'text/plain';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    let playerId = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (e) { return; }

        switch (msg.type) {
            case 'create_room': {
                const room = createRoom();
                const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                const player = {
                    id, name: msg.name || '玩家', cards: [], calledUno: false,
                    isReady: true, joinedAt: Date.now(),
                };
                room.players.push(player);
                room.hostId = id;
                players.set(id, ws);
                playerId = id;
                sendTo(id, { type: 'room_created', code: room.code, playerId: id });
                sendTo(id, getGameState(room, id));
                broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${player.name} 创建了房间` }, id);
                break;
            }

            case 'join_room': {
                const room = rooms.get(msg.code?.toUpperCase());
                if (!room) { sendRaw(ws, { type: 'error', message: '房间不存在' }); break; }
                if (room.state !== 'waiting') { sendRaw(ws, { type: 'error', message: '游戏已开始' }); break; }
                if (room.players.length >= 6) { sendRaw(ws, { type: 'error', message: '房间已满(最多6人)' }); break; }

                const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                const player = {
                    id, name: msg.name || '玩家', cards: [], calledUno: false,
                    isReady: true, joinedAt: Date.now(),
                };
                room.players.push(player);
                players.set(id, ws);
                playerId = id;
                sendTo(id, { type: 'room_joined', code: room.code, playerId: id });
                sendTo(id, getGameState(room, id));
                for (const p of room.players) {
                    if (p.id !== id) sendTo(p.id, getGameState(room, p.id));
                }
                broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${player.name} 加入了房间 (${room.players.length}/6)` }, id);
                broadcast(room, { type: 'player_joined', player: { id, name: player.name, cardCount: 0, isReady: true, isHost: false } });
                break;
            }

            case 'start_game': {
                const room = getRoomByPlayer(playerId);
                if (!room || room.hostId !== playerId) { sendRaw(ws, { type: 'error', message: '只有房主能开始游戏' }); break; }
                if (room.players.length < 2) { sendRaw(ws, { type: 'error', message: '至少需要2名玩家' }); break; }
                if (room.state !== 'waiting') break;

                room.deck = shuffle(createDeck());
                room.discardPile = [];
                room.currentTurn = Math.floor(Math.random() * room.players.length);
                room.direction = 1;
                room.state = 'playing';

                for (const p of room.players) {
                    p.cards = [];
                    p.calledUno = false;
                }

                for (let i = 0; i < 7; i++) {
                    for (const p of room.players) {
                        p.cards.push(room.deck.pop());
                    }
                }

                while (room.deck[room.deck.length - 1]?.color === 'wild') {
                    room.deck = shuffle(room.deck);
                }
                room.discardPile.push(room.deck.pop());

                broadcast(room, { type: 'game_started' });
                broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: '游戏开始! 每人7张牌' });
                for (const p of room.players) {
                    sendTo(p.id, getGameState(room, p.id));
                }
                startTurnTimer(room);
                break;
            }

            case 'play_card': {
                const room = getRoomByPlayer(playerId);
                if (!room || room.state !== 'playing') break;
                const player = room.players.find(p => p.id === playerId);
                if (!player) break;
                handlePlayCard(room, player, msg.cardIndex, msg.chosenColor || null);
                break;
            }

            case 'choose_color': {
                const room = getRoomByPlayer(playerId);
                if (!room) break;
                const player = room.players.find(p => p.id === playerId);
                if (!player || !msg.pendingCardIndex === undefined) break;
                handlePlayCard(room, player, msg.cardIndex, msg.color);
                break;
            }

            case 'draw_card': {
                const room = getRoomByPlayer(playerId);
                if (!room || room.state !== 'playing') break;
                if (room.players[room.currentTurn].id !== playerId) {
                    sendRaw(ws, { type: 'error', message: '还没轮到你' });
                    break;
                }
                const player = room.players[room.currentTurn];
                const drawn = drawCards(room, 1);
                if (drawn.length > 0) {
                    player.cards.push(...drawn);
                    broadcast(room, { type: 'card_drawn', playerId: player.id, count: 1 });

                    const drawnCard = drawn[0];
                    const topCard = room.discardPile[room.discardPile.length - 1];
                    if (canPlayCard(drawnCard, topCard, null)) {
                        sendTo(playerId, { type: 'can_play_drawn', card: drawnCard, cardIndex: player.cards.length - 1 });
                    }
                }
                broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${player.name} 抽了一张牌` });
                for (const p of room.players) sendTo(p.id, getGameState(room, p.id));
                nextTurn(room);
                break;
            }

            case 'call_uno': {
                const room = getRoomByPlayer(playerId);
                if (!room || room.state !== 'playing') break;
                const player = room.players.find(p => p.id === playerId);
                if (!player) break;
                player.calledUno = true;
                broadcast(room, { type: 'player_uno', playerId: player.id, playerName: player.name });
                broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${player.name} 喊了 UNO!` });
                break;
            }

            case 'chat': {
                const room = getRoomByPlayer(playerId);
                if (!room) break;
                const player = room.players.find(p => p.id === playerId);
                if (!player) break;
                const chatMsg = {
                    type: 'chat',
                    playerId: player.id,
                    name: player.name,
                    message: msg.message?.slice(0, 200) || '',
                };
                broadcast(room, chatMsg);
                break;
            }

            case 'play_again': {
                const room = getRoomByPlayer(playerId);
                if (!room || room.state !== 'finished') break;
                room.state = 'waiting';
                room.deck = [];
                room.discardPile = [];
                room.currentTurn = 0;
                room.direction = 1;
                room.timeLeft = 30;
                for (const p of room.players) {
                    p.cards = [];
                    p.calledUno = false;
                }
                broadcast(room, { type: 'game_restart' });
                broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: '再来一局! 请房主开始游戏' });
                for (const p of room.players) sendTo(p.id, getGameState(room, p.id));
                break;
            }
        }
    });

    ws.on('close', () => {
        if (!playerId) return;
        const room = getRoomByPlayer(playerId);
        if (!room) return;

        const player = room.players.find(p => p.id === playerId);
        const playerName = player?.name || '玩家';

        room.players = room.players.filter(p => p.id !== playerId);
        players.delete(playerId);

        broadcast(room, { type: 'player_left', playerId, playerName });
        broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${playerName} 离开了房间` });

        if (room.players.length === 0) {
            clearInterval(room.turnTimer);
            rooms.delete(room.code);
            return;
        }

        if (room.hostId === playerId) {
            room.hostId = room.players[0].id;
            broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: `${room.players[0].name} 成为新房主` });
        }

        if (room.state === 'playing') {
            if (room.players.length < 2) {
                room.state = 'finished';
                clearInterval(room.turnTimer);
                broadcast(room, { type: 'chat', playerId: 'system', name: '系统', message: '玩家人数不足，游戏结束' });
            } else {
                if (room.currentTurn >= room.players.length) {
                    room.currentTurn = 0;
                }
                for (const p of room.players) sendTo(p.id, getGameState(room, p.id));
            }
        }
    });
});

function sendRaw(ws, data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

server.listen(PORT, () => {
    console.log(`UNO Server running at http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});