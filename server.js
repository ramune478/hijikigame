const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);

// 静的ファイルの提供（index.htmlなどが同じフォルダにある前提）
app.use(express.static(__dirname));

let players = {};
let enemies = [];
let drops = [];
let gameInfo = {
    wave: 1,
    killCount: 0,
    targetKills: 8,
    phase: 'battle', // 'battle' か 'rest'
    restTimer: 0
};

const ENEMY_TYPES = [
    { type: 'normal', hp: 2, speed: 0.15, power: 3, score: 100, color: 'blue', size: 14 },
    { type: 'speed', hp: 0.5, speed: 0.35, power: 2, score: 150, color: 'green', size: 12 },
    { type: 'heavy', hp: 8, speed: 0.08, power: 8, score: 500, color: '#9370DB', size: 18 },
    { type: 'scout', hp: 5, speed: 0.15, power: 5, score: 200, color: 'lightblue', size: 10 }
];

setInterval(() => {
    if (gameInfo.phase === 'rest') {
        gameInfo.restTimer--;
        if (gameInfo.restTimer <= 0) {
            gameInfo.phase = 'battle';
            gameInfo.wave++;
            gameInfo.killCount = 0;
            gameInfo.targetKills += 5;
        }
    }

    if (gameInfo.phase === 'battle') {
        enemies.forEach((en) => {
            let targetId = null;
            let minDis = 999;
            for (let id in players) {
                let p = players[id];
                if (p.hp > 0) {
                    let d = Math.sqrt((en.x - p.x)**2 + (en.y - p.y)**2);
                    if (d < minDis) { minDis = d; targetId = id; }
                }
            }
            if (targetId) {
                let p = players[targetId];
                let dx = p.x - en.x, dy = p.y - en.y, dist = Math.sqrt(dx*dx + dy*dy);
                if (dist > 0.1) {
                    en.x += (dx / dist) * en.speed;
                    en.y += (dy / dist) * en.speed;
                }
                if (dist < 0.6) p.hp -= en.power * 0.15;
            }
        });

        if (enemies.length < 5 + gameInfo.wave * 2 && Math.random() < 0.05) {
            let typeData = ENEMY_TYPES[Math.floor(Math.random() * Math.min(gameInfo.wave, ENEMY_TYPES.length))];
            let angle = Math.random() * Math.PI * 2;
            let anyP = Object.values(players)[0];
            if (anyP) {
                enemies.push({
                    id: Math.random().toString(36).substr(2, 9),
                    x: anyP.x + Math.cos(angle) * 10, y: anyP.y + Math.sin(angle) * 10,
                    ...typeData, hp: typeData.hp
                });
            }
        }
    } else {
        enemies = [];
    }

    io.emit('update', { players, enemies, drops, info: gameInfo });
}, 1000 / 30);

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        players[socket.id] = { 
            id: socket.id, name: data.name, x: 0, y: 0, 
            hp: 100, maxHp: 100, score: 0, money: 0, 
            angle: 0, isAttacking: false,
            weaponRange: 1.2
        };
    });

    socket.on('input', (data) => {
        let p = players[socket.id];
        if (p) { 
            p.x = data.x; p.y = data.y; p.angle = data.angle; p.isAttacking = data.isAttacking;
        }
    });

    socket.on('hit_enemy', (enemyId) => {
        let p = players[socket.id];
        let enIdx = enemies.findIndex(e => e.id === enemyId);
        if (p && enIdx !== -1) {
            let en = enemies[enIdx];
            let dist = Math.sqrt((p.x - en.x)**2 + (p.y - en.y)**2);
            if (dist < p.weaponRange + 0.3) {
                en.hp -= 1;
                if (en.hp <= 0) {
                    p.score += en.score;
                    drops.push({ id: Math.random(), x: en.x, y: en.y, val: 25 });
                    enemies.splice(enIdx, 1);
                    gameInfo.killCount++;
                    if (gameInfo.killCount >= gameInfo.targetKills) {
                        gameInfo.phase = 'rest';
                        gameInfo.restTimer = 30 * 30;
                    }
                }
            }
        }
    });

    socket.on('collect_drop', (id) => {
        let idx = drops.findIndex(d => d.id === id);
        if (idx !== -1 && players[socket.id]) {
            players[socket.id].money += drops[idx].val;
            drops.splice(idx, 1);
        }
    });

    socket.on('buy', (type) => {
        let p = players[socket.id];
        if (!p || gameInfo.phase !== 'rest') return;
        
        if (type === 'heal' && p.money >= 50) {
            p.hp = p.maxHp; p.money -= 50;
        } else if (type === 'range' && p.money >= 150) {
            p.weaponRange += 0.3; p.money -= 150;
        } else if (type === 'maxhp' && p.money >= 200) {
            p.maxHp += 20; p.hp += 20; p.money -= 200;
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

// Renderなどの環境変数のポートを使うように修正
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log('Server running on port ' + PORT));