const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 静的ファイルを提供
app.use(express.static(path.join(__dirname)));

// ゲーム状態管理
let gameRooms = {};
let enemyIdCounter = 0;

const PLAYER_COLORS = {
    0: '#00ff00',  // 緑
    1: '#ff0000',  // 赤
    2: '#00ccff',  // シアン
    3: '#ffff00'   // 黄色
};

const MAP_LIMIT = 64;

// ===== ゲームルーム管理 =====
class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = {};
        this.enemies = [];
        this.gameState = 'waiting'; // waiting, playing, resting, over
        this.currentWave = 1;
        this.friendlyFireEnabled = false;
        this.maxPlayers = 4;
        this.createdAt = Date.now();
        this.killCount = 0;
        this.targetKills = 5;
    }

    addPlayer(playerId, playerData) {
        if (Object.keys(this.players).length >= this.maxPlayers) {
            return false;
        }
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

    broadcastToRoom(data, excludePlayerId = null) {
        const message = JSON.stringify(data);
        Object.values(this.players).forEach(player => {
            if (player.ws && player.ws.readyState === WebSocket.OPEN) {
                if (excludePlayerId === null || player.id !== excludePlayerId) {
                    player.ws.send(message);
                }
            }
        });
    }

    broadcastToRoomIncludeSender(data) {
        const message = JSON.stringify(data);
        Object.values(this.players).forEach(player => {
            if (player.ws && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(message);
            }
        });
    }
}

// ===== 敵クラス =====
class Enemy {
    constructor(id, x, y, type, wave) {
        this.id = id;
        this.worldX = x;
        this.worldY = y;
        this.type = type;
        this.wave = wave;
        
        const typeData = {
            'normal': { color: 'blue', hp: 2, speed: 0.03, power: 3, scoreVal: 100 },
            'speed': { color: 'green', hp: 0.5, speed: 0.13, power: 3, scoreVal: 150 },
            'heavy': { color: '#9370DB', hp: 4, speed: 0.01, power: 8, scoreVal: 500 },
            'scout': { color: 'lightblue', hp: 2, speed: 0.03, power: 5, scoreVal: 250 }
        };

        const data = typeData[type] || typeData['normal'];
        this.color = data.color;
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

// ===== WebSocket接続処理 =====
wss.on('connection', (ws) => {
    let playerId = null;
    let roomId = null;
    let room = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join_game':
                    handleJoinGame(ws, data, (pId, rId, r) => {
                        playerId = pId;
                        roomId = rId;
                        room = r;
                    });
                    break;

                case 'player_update':
                    if (room && room.players[playerId]) {
                        const player = room.players[playerId];
                        player.worldX = data.worldX;
                        player.worldY = data.worldY;
                        player.hp = data.hp;
                        player.score = data.score;
                        player.money = data.money;
                        player.angle = data.angle;
                        player.moveSpeed = data.moveSpeed;
                        player.weaponRange = data.weaponRange;
                        player.skillCool = data.skillCool;
                        player.isAttacking = data.isAttacking;

                        // 他プレイヤーに更新を通知
                        room.broadcastToRoom({
                            type: 'player_update',
                            playerId: playerId,
                            worldX: data.worldX,
                            worldY: data.worldY,
                            hp: data.hp,
                            score: data.score,
                            angle: data.angle,
                            isAttacking: data.isAttacking
                        }, playerId);

                        if (data.hp <= 0) {
                            player.isAlive = false;
                            room.broadcastToRoomIncludeSender({
                                type: 'player_died',
                                playerId: playerId,
                                nickname: player.nickname
                            });
                        }
                    }
                    break;

                case 'attack_enemy':
                    if (room) {
                        const enemy = room.enemies.find(e => e.id === data.enemyId);
                        const player = room.players[playerId];
                        
                        if (player && enemy) {
                            if (enemy.takeDamage(data.damage || 0.5)) {
                                player.score += Math.floor(enemy.scoreVal);
                                player.skillCool = Math.min(1000, player.skillCool + 100);
                                player.kills = (player.kills || 0) + 1;
                                room.killCount++;

                                room.broadcastToRoomIncludeSender({
                                    type: 'enemy_killed',
                                    enemyId: data.enemyId,
                                    killedBy: playerId,
                                    playerName: player.nickname,
                                    scoreGain: enemy.scoreVal
                                });

                                room.enemies = room.enemies.filter(e => e.id !== data.enemyId);

                                // ウェーブクリア判定
                                if (room.gameState === 'playing' && room.killCount >= room.targetKills) {
                                    room.gameState = 'resting';
                                    room.broadcastToRoomIncludeSender({
                                        type: 'wave_clear',
                                        nextWave: room.currentWave + 1,
                                        allPlayerScores: Object.entries(room.players).map(([id, p]) => ({
                                            playerId: id,
                                            nickname: p.nickname,
                                            score: p.score
                                        }))
                                    });
                                }
                            } else {
                                room.broadcastToRoomIncludeSender({
                                    type: 'enemy_damaged',
                                    enemyId: data.enemyId,
                                    hp: enemy.hp,
                                    damageBy: playerId
                                });
                            }
                        }
                    }
                    break;

                case 'use_skill':
                    if (room && room.players[playerId]) {
                        const player = room.players[playerId];
                        player.skillCool = 0;
                        player.score += 250;

                        room.broadcastToRoomIncludeSender({
                            type: 'skill_used',
                            playerId: playerId,
                            nickname: player.nickname,
                            abilityType: player.abilityType,
                            worldX: player.worldX,
                            worldY: player.worldY,
                            angle: player.angle
                        });
                    }
                    break;

                case 'wave_clear_request':
                    if (room && room.gameState === 'playing') {
                        room.gameState = 'resting';
                        room.currentWave++;
                        room.killCount = 0;
                        room.targetKills += 2;
                        room.enemies = [];

                        room.broadcastToRoomIncludeSender({
                            type: 'wave_clear',
                            nextWave: room.currentWave,
                            allPlayerScores: Object.entries(room.players).map(([id, p]) => ({
                                playerId: id,
                                nickname: p.nickname,
                                score: p.score
                            }))
                        });

                        setTimeout(() => {
                            if (gameRooms[roomId] && gameRooms[roomId].gameState === 'resting') {
                                gameRooms[roomId].gameState = 'playing';
                                gameRooms[roomId].broadcastToRoomIncludeSender({
                                    type: 'wave_start',
                                    wave: gameRooms[roomId].currentWave
                                });
                            }
                        }, 30000);
                    }
                    break;

                case 'game_over':
                    if (room && room.players[playerId]) {
                        const player = room.players[playerId];
                        player.isAlive = false;

                        room.broadcastToRoomIncludeSender({
                            type: 'game_over',
                            playerId: playerId,
                            nickname: player.nickname,
                            finalScore: player.score
                        });
                    }
                    break;

                case 'toggle_friendly_fire':
                    if (room) {
                        room.friendlyFireEnabled = data.enabled;
                        room.broadcastToRoomIncludeSender({
                            type: 'friendly_fire_toggled',
                            enabled: data.enabled,
                            changedBy: room.players[playerId].nickname
                        });
                    }
                    break;

                case 'chat':
                    if (room && room.players[playerId]) {
                        const player = room.players[playerId];
                        room.broadcastToRoomIncludeSender({
                            type: 'chat',
                            playerId: playerId,
                            nickname: player.nickname,
                            color: player.color,
                            message: data.message,
                            timestamp: Date.now()
                        });
                    }
                    break;

                case 'spectate_request':
                    if (room && room.players[playerId]) {
                        const targetPlayer = room.players[data.targetPlayerId];
                        if (targetPlayer) {
                            ws.send(JSON.stringify({
                                type: 'spectate_start',
                                targetPlayerId: data.targetPlayerId,
                                targetNickname: targetPlayer.nickname
                            }));
                        }
                    }
                    break;
            }
        } catch (error) {
            console.error('メッセージ処理エラー:', error);
        }
    });

    ws.on('close', () => {
        if (playerId && roomId && gameRooms[roomId]) {
            const r = gameRooms[roomId];
            if (r.removePlayer(playerId)) {
                delete gameRooms[roomId];
            } else {
                r.broadcastToRoom({
                    type: 'player_left',
                    playerId: playerId,
                    timestamp: Date.now()
                });
            }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket エラー:', error);
    });
});

// ===== ハンドラー関数 =====
function handleJoinGame(ws, data, callback) {
    const playerId = 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    const roomId = data.roomId || 'room_default';

    if (!gameRooms[roomId]) {
        gameRooms[roomId] = new GameRoom(roomId);
    }

    const room = gameRooms[roomId];

    const colorIndex = Object.keys(room.players).length % 4;
    const playerData = {
        id: playerId,
        ws: ws,
        nickname: data.nickname || `プレイヤー${colorIndex + 1}`,
        color: PLAYER_COLORS[colorIndex],
        colorIndex: colorIndex,
        worldX: 0,
        worldY: 0,
        hp: 100,
        maxHp: 100,
        score: 0,
        money: 0,
        abilityType: data.abilityType,
        moveSpeed: 0.08,
        weaponRange: 1.2,
        angle: 0,
        isAttacking: false,
        attackFrame: 0,
        skillCool: 0,
        invincibleTimer: 0,
        isInvincible: false,
        isAlive: true,
        kills: 0,
        joinedAt: Date.now()
    };

    if (!room.addPlayer(playerId, playerData)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'ルームが満員です'
        }));
        return;
    }

    // 既存プレイヤーの情報を新規プレイヤーに送信
    Object.values(room.players).forEach(existingPlayer => {
        if (existingPlayer.id !== playerId) {
            ws.send(JSON.stringify({
                type: 'existing_player',
                playerId: existingPlayer.id,
                nickname: existingPlayer.nickname,
                color: existingPlayer.color,
                colorIndex: existingPlayer.colorIndex,
                worldX: existingPlayer.worldX,
                worldY: existingPlayer.worldY,
                hp: existingPlayer.hp,
                score: existingPlayer.score,
                abilityType: existingPlayer.abilityType,
                isAlive: existingPlayer.isAlive
            }));
        }
    });

    // 他プレイヤーに新規参加を通知
    room.broadcastToRoom({
        type: 'player_joined',
        playerId: playerId,
        nickname: playerData.nickname,
        color: playerData.color,
        colorIndex: colorIndex,
        abilityType: data.abilityType,
        playerCount: room.getPlayerCount()
    }, playerId);

    // 新規参加プレイヤーに自身の情報を返信
    ws.send(JSON.stringify({
        type: 'self_info',
        playerId: playerId,
        color: playerData.color,
        colorIndex: colorIndex,
        roomId: roomId,
        playerCount: room.getPlayerCount(),
        friendlyFireEnabled: room.friendlyFireEnabled
    }));

    callback(playerId, roomId, room);

    // ゲーム開始
    if (room.getPlayerCount() >= 1 && room.gameState === 'waiting') {
        room.gameState = 'playing';
        room.broadcastToRoomIncludeSender({
            type: 'game_start',
            gameState: 'playing',
            wave: room.currentWave
        });
        
        startGameLoop(roomId);
    }
}

// ===== ゲームループ =====
function startGameLoop(roomId) {
    const room = gameRooms[roomId];
    if (!room) return;

    const gameLoopInterval = setInterval(() => {
        if (!gameRooms[roomId]) {
            clearInterval(gameLoopInterval);
            return;
        }

        if (room.gameState === 'playing') {
            spawnEnemies(room);
            updateEnemies(room);

            room.broadcastToRoomIncludeSender({
                type: 'game_state',
                enemies: room.enemies.map(e => ({
                    id: e.id,
                    worldX: e.worldX,
                    worldY: e.worldY,
                    type: e.type,
                    hp: e.hp,
                    color: e.color
                })),
                gameState: room.gameState,
                wave: room.currentWave,
                enemyCount: room.enemies.length,
                killCount: room.killCount,
                targetKills: room.targetKills
            });
        }
    }, 50);
}

function spawnEnemies(room) {
    const spawnRate = room.gameState === 'playing' ? 0.03 : 0.005;
    const maxEnemies = 20 + room.currentWave * 2;
    
    if (Math.random() < spawnRate && room.enemies.length < maxEnemies) {
        const types = ['normal', 'speed', 'heavy', 'scout'];
        const type = types[Math.floor(Math.random() * Math.min(room.currentWave, 4))];

        const playerEntries = Object.values(room.players).filter(p => p.isAlive);
        if (playerEntries.length > 0) {
            const centerPlayer = playerEntries[Math.floor(Math.random() * playerEntries.length)];
            const angle = Math.random() * Math.PI * 2;

            const enemy = new Enemy(
                'enemy_' + (enemyIdCounter++),
                centerPlayer.worldX + Math.cos(angle) * 7,
                centerPlayer.worldY + Math.sin(angle) * 7,
                type,
                room.currentWave
            );

            room.enemies.push(enemy);
        }
    }
}

function updateEnemies(room) {
    room.enemies.forEach(enemy => {
        let closestPlayer = null;
        let closestDist = Infinity;

        Object.values(room.players).forEach(player => {
            if (player.isAlive) {
                const dx = player.worldX - enemy.worldX;
                const dy = player.worldY - enemy.worldY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                if (dist < closestDist) {
                    closestDist = dist;
                    closestPlayer = player;
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
}

// ===== サーバー起動 =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 ひじきサバイバー マルチプレイサーバー起動`);
    console.log(`📍 http://localhost:${PORT}`);
    console.log(`🔗 WebSocket接続: ws://localhost:${PORT}`);
});
