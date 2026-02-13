const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// heartbeat: detect and terminate dead/ghost connections
const HEARTBEAT_INTERVAL = 30000;
setInterval(() => {
    wss.clients.forEach((c) => {
        if (c.isAlive === false) return c.terminate();
        c.isAlive = false;
        try { c.ping(); } catch (e) { /* ignore */ }
    });
}, HEARTBEAT_INTERVAL);

app.use(express.static(path.join(__dirname)));

let gameRooms = {};
let enemyIdCounter = 0;

const PLAYER_COLORS = {
    0: '#00ff00',
    1: '#ff0000',
    2: '#00ccff',
    3: '#ffff00'
};

const MAP_LIMIT = 64;

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = {};
        this.enemies = [];
        this.gameState = 'waiting';
        this.currentWave = 1;
        this.friendlyFireEnabled = false;
        this.maxPlayers = 4;
        this.killCount = 0;
        this.targetKills = 5;
        this.loopInterval = null; // game loop interval handle
    }

    addPlayer(playerId, playerData) {
        if (Object.keys(this.players).length >= this.maxPlayers) return false;
        this.players[playerId] = playerData;
        return true;
    }

    removePlayer(playerId) {
        delete this.players[playerId];
        return Object.keys(this.players).length === 0;
    }

    getPlayerCount() {
        return Object.keys(this.players).length;
    }

    broadcast(data, excludeId = null) {
        const msg = JSON.stringify(data);
        Object.values(this.players).forEach(p => {
            if (p.ws && p.ws.readyState === WebSocket.OPEN && p.id !== excludeId) {
                try { p.ws.send(msg); } catch (e) { /* ignore send errors */ }
            }
        });
    }

    broadcastAll(data) {
        const msg = JSON.stringify(data);
        Object.values(this.players).forEach(p => {
            if (p.ws && p.ws.readyState === WebSocket.OPEN) {
                try { p.ws.send(msg); } catch (e) { /* ignore send errors */ }
            }
        });
    }

    stopLoop() {
        if (this.loopInterval) {
            clearInterval(this.loopInterval);
            this.loopInterval = null;
        }
    }
}

class Enemy {
    constructor(id, x, y, type) {
        this.id = id;
        this.worldX = x;
        this.worldY = y;
        this.type = type;
        
        const typeData = {
            'normal': { hp: 2, speed: 0.03, power: 3, scoreVal: 100 },
            'speed': { hp: 0.5, speed: 0.13, power: 3, scoreVal: 150 },
            'heavy': { hp: 4, speed: 0.01, power: 8, scoreVal: 500 },
            'scout': { hp: 2, speed: 0.03, power: 5, scoreVal: 250 }
        };

        const data = typeData[type] || typeData['normal'];
        this.hp = data.hp;
        this.speed = data.speed;
        this.power = data.power;
        this.scoreVal = data.scoreVal;
    }

    takeDamage(damage) {
        this.hp -= damage;
        return this.hp <= 0;
    }
}

wss.on('connection', (ws) => {
    let playerId = null;
    let roomId = null;
    let room = null;

    // simple heartbeat for detecting dead clients
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message || '{}');
            if (!data.type) return; // ignore malformed

            switch (data.type) {
                case 'join_game':
                    playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).slice(2, 11);
                    roomId = (typeof data.roomId === 'string' && data.roomId.trim()) ? data.roomId : 'room_default';

                    if (!gameRooms[roomId]) {
                        gameRooms[roomId] = new GameRoom(roomId);
                    }

                    room = gameRooms[roomId];
                    const colorIndex = Object.keys(room.players).length % 4;

                    const playerData = {
                        id: playerId,
                        ws: ws,
                        nickname: String(data.nickname || '名無し'),
                        color: PLAYER_COLORS[colorIndex],
                        worldX: 0,
                        worldY: 0,
                        hp: 100,
                        maxHp: 100,
                        score: 0,
                        money: 0,
                        abilityType: data.abilityType || null,
                        moveSpeed: 0.08,
                        weaponRange: 1.2,
                        angle: 0,
                        skillCool: 0,
                        isAlive: true,
                        kills: 0
                    };

                    if (!room.addPlayer(playerId, playerData)) {
                        try { ws.send(JSON.stringify({ type: 'error', message: 'ルームが満員です' })); } catch (e) {}
                        return;
                    }

                    // send existing players to the new client
                    Object.values(room.players).forEach(p => {
                        if (p.id !== playerId) {
                            try {
                                ws.send(JSON.stringify({
                                    type: 'existing_player',
                                    playerId: p.id,
                                    nickname: p.nickname,
                                    color: p.color,
                                    worldX: p.worldX,
                                    worldY: p.worldY,
                                    hp: p.hp,
                                    score: p.score,
                                    abilityType: p.abilityType,
                                    isAlive: p.isAlive
                                }));
                            } catch (e) {}
                        }
                    });

                    room.broadcast({
                        type: 'player_joined',
                        playerId: playerId,
                        nickname: playerData.nickname,
                        color: playerData.color,
                        abilityType: playerData.abilityType,
                        playerCount: room.getPlayerCount()
                    }, playerId);

                    try {
                        ws.send(JSON.stringify({
                            type: 'self_info',
                            playerId: playerId,
                            color: playerData.color,
                            roomId: roomId,
                            playerCount: room.getPlayerCount(),
                            friendlyFireEnabled: room.friendlyFireEnabled
                        }));
                    } catch (e) {}

                    if (room.getPlayerCount() >= 1 && room.gameState === 'waiting') {
                        room.gameState = 'playing';
                        room.broadcastAll({
                            type: 'game_start',
                            gameState: 'playing',
                            wave: room.currentWave
                        });
                        startGameLoop(roomId);
                    }
                    break;

                case 'player_update':
                    if (room && room.players[playerId]) {
                        const p = room.players[playerId];
                        // sanitize numeric inputs
                        p.worldX = Number(data.worldX) || p.worldX;
                        p.worldY = Number(data.worldY) || p.worldY;
                        p.hp = Number.isFinite(Number(data.hp)) ? Number(data.hp) : p.hp;
                        p.score = Number.isFinite(Number(data.score)) ? Number(data.score) : p.score;
                        p.money = Number.isFinite(Number(data.money)) ? Number(data.money) : p.money;
                        p.angle = Number.isFinite(Number(data.angle)) ? Number(data.angle) : p.angle;
                        p.skillCool = Number.isFinite(Number(data.skillCool)) ? Number(data.skillCool) : p.skillCool;

                        room.broadcast({
                            type: 'player_update',
                            playerId: playerId,
                            worldX: p.worldX,
                            worldY: p.worldY,
                            hp: p.hp,
                            score: p.score,
                            angle: p.angle
                        }, playerId);

                        if (p.hp <= 0 && p.isAlive) {
                            p.isAlive = false;
                            room.broadcastAll({
                                type: 'player_died',
                                playerId: playerId,
                                nickname: p.nickname
                            });
                        }
                    }
                    break;

                case 'attack_enemy':
                    if (room) {
                        const enemy = room.enemies.find(e => e.id === data.enemyId);
                        const p = room.players[playerId];
                        
                        if (p && enemy) {
                            if (enemy.takeDamage(data.damage || 0.5)) {
                                p.score += Math.floor(enemy.scoreVal);
                                p.skillCool = Math.min(1000, p.skillCool + 100);
                                p.kills = (p.kills || 0) + 1;
                                room.killCount++;

                                room.broadcastAll({
                                    type: 'enemy_killed',
                                    enemyId: data.enemyId,
                                    killedBy: playerId,
                                    playerName: p.nickname,
                                    scoreGain: enemy.scoreVal
                                });

                                room.enemies = room.enemies.filter(e => e.id !== data.enemyId);

                                if (room.gameState === 'playing' && room.killCount >= room.targetKills) {
                                    room.gameState = 'resting';
                                    room.stopLoop();
                                    room.currentWave++;
                                    room.killCount = 0;
                                    room.targetKills += 2;

                                    room.broadcastAll({
                                        type: 'wave_clear',
                                        nextWave: room.currentWave
                                    });

                                    setTimeout(() => {
                                        if (gameRooms[roomId] && gameRooms[roomId].gameState === 'resting') {
                                            const r = gameRooms[roomId];
                                            r.gameState = 'playing';
                                            r.broadcastAll({
                                                type: 'wave_start',
                                                wave: r.currentWave
                                            });
                                            startGameLoop(roomId);
                                        }
                                    }, 30000);
                                }
                            } else {
                                room.broadcastAll({
                                    type: 'enemy_damaged',
                                    enemyId: data.enemyId,
                                    hp: enemy.hp
                                });
                            }
                        }
                    }
                    break;

                case 'use_skill':
                    if (room && room.players[playerId]) {
                        const p = room.players[playerId];
                        room.broadcastAll({
                            type: 'skill_used',
                            playerId: playerId,
                            nickname: p.nickname,
                            abilityType: p.abilityType
                        });
                    }
                    break;

                case 'game_over':
                    if (room && room.players[playerId]) {
                        room.players[playerId].isAlive = false;
                    }
                    break;

                case 'toggle_friendly_fire':
                    if (room) {
                        room.friendlyFireEnabled = !!data.enabled;
                        room.broadcastAll({
                            type: 'friendly_fire_toggled',
                            enabled: room.friendlyFireEnabled,
                            changedBy: room.players[playerId] ? room.players[playerId].nickname : 'unknown'
                        });
                    }
                    break;

                case 'chat':
                    if (room && room.players[playerId]) {
                        const p = room.players[playerId];
                        room.broadcastAll({
                            type: 'chat',
                            playerId: playerId,
                            nickname: p.nickname,
                            color: p.color,
                            message: data.message
                        });
                    }
                    break;

                case 'wave_clear_request':
                    if (room && room.gameState === 'playing') {
                        room.gameState = 'resting';
                        room.stopLoop();
                        room.currentWave++;
                        room.killCount = 0;
                        room.targetKills += 2;
                        room.enemies = [];

                        room.broadcastAll({
                            type: 'wave_clear',
                            nextWave: room.currentWave
                        });

                        setTimeout(() => {
                            if (gameRooms[roomId] && gameRooms[roomId].gameState === 'resting') {
                                const r = gameRooms[roomId];
                                r.gameState = 'playing';
                                r.broadcastAll({
                                    type: 'wave_start',
                                    wave: r.currentWave
                                });
                                startGameLoop(roomId); // restart loop
                            }
                        }, 30000);
                    }
                    break;
            }
        } catch (error) {
            console.error('Error:', error);
        }
    });

    ws.on('close', () => {
        if (playerId && roomId && gameRooms[roomId]) {
            const r = gameRooms[roomId];
            if (r.removePlayer(playerId)) {
                r.stopLoop();
                delete gameRooms[roomId];
            } else {
                r.broadcastAll({
                    type: 'player_left',
                    playerId: playerId
                });
            }
        }
    });
});

function startGameLoop(roomId) {
    const room = gameRooms[roomId];
    if (!room) return;
    if (room.loopInterval) return; // already running

    room.loopInterval = setInterval(() => {
        const currentRoom = gameRooms[roomId];
        if (!currentRoom || currentRoom.gameState !== 'playing' || currentRoom.getPlayerCount() === 0) {
            // stop loop if room removed, not playing, or empty
            if (currentRoom) currentRoom.stopLoop();
            else clearInterval(room.loopInterval);
            return;
        }

        const spawnRate = 0.03;
        const maxEnemies = 20 + room.currentWave * 2;
        
        if (Math.random() < spawnRate && room.enemies.length < maxEnemies) {
            const types = ['normal', 'speed', 'heavy', 'scout'];
            const typeIndex = Math.floor(Math.random() * Math.min(Math.max(room.currentWave, 1), types.length));
            const type = types[typeIndex];

            const playerList = Object.values(room.players).filter(p => p.isAlive);
            if (playerList.length > 0) {
                const centerPlayer = playerList[Math.floor(Math.random() * playerList.length)];
                const angle = Math.random() * Math.PI * 2;

                const enemy = new Enemy(
                    'enemy_' + (enemyIdCounter++),
                    Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, centerPlayer.worldX + Math.cos(angle) * 7)),
                    Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, centerPlayer.worldY + Math.sin(angle) * 7)),
                    type
                );

                room.enemies.push(enemy);
            }
        }

        room.enemies.forEach(enemy => {
            let closestPlayer = null;
            let closestDist = Infinity;

            Object.values(room.players).forEach(p => {
                if (p.isAlive) {
                    const dx = p.worldX - enemy.worldX;
                    const dy = p.worldY - enemy.worldY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    
                    if (dist < closestDist) {
                        closestDist = dist;
                        closestPlayer = p;
                    }
                }
            });

            if (closestPlayer && closestDist > 0.1) {
                const dx = closestPlayer.worldX - enemy.worldX;
                const dy = closestPlayer.worldY - enemy.worldY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                enemy.worldX += (dx / dist) * enemy.speed;
                enemy.worldY += (dy / dist) * enemy.speed;
            }

            enemy.worldX = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, enemy.worldX));
            enemy.worldY = Math.max(-MAP_LIMIT, Math.min(MAP_LIMIT, enemy.worldY));
        });

        room.broadcastAll({
            type: 'game_state',
            enemies: room.enemies.map(e => ({
                id: e.id,
                worldX: e.worldX,
                worldY: e.worldY,
                type: e.type,
                hp: e.hp
            })),
            gameState: room.gameState,
            wave: room.currentWave,
            enemyCount: room.enemies.length,
            killCount: room.killCount,
            targetKills: room.targetKills
        });
    }, 50);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎮 ひじきサバイバー マルチプレイサーバー起動`);
    console.log(`📍 ポート: ${PORT}`);
});
