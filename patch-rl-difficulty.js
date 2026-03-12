/**
 * patch-rl-difficulty.js
 *
 * Integrates ai-training.js RL module into the game:
 * 1. Import ai-training module in server.js
 * 2. Add room-level difficulty setting (aiDifficulty field)
 * 3. Add /api/rooms response to include aiDifficulty
 * 4. Add socket handler for setAIDifficulty
 * 5. Add training API endpoints (start/stop/status)
 * 6. Integrate RL decisions into updateAI
 * 7. Add difficulty selector UI in login screen (index.html)
 * 8. Add training panel UI (admin only) in index.html
 * 9. Add client-side difficulty + training code in game.js
 * 10. Add CSS for difficulty selector and training panel
 */

const fs = require('fs');
const path = require('path');

function readFile(name) { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }
function writeFile(name, data) { fs.writeFileSync(path.join(__dirname, name), data, 'utf8'); }

let server = readFile('server.js');
let html = readFile('public/index.html');
let gameJs = readFile('public/game.js');
let css = readFile('public/style.css');

let patchCount = 0;
function apply(desc, file, search, replace) {
  if (!file.includes(search)) {
    console.error(`FAIL [${desc}]`);
    return file;
  }
  file = file.replace(search, replace);
  console.log(`OK   [${desc}]`);
  patchCount++;
  return file;
}

// ==============================================================
// 1. Import ai-training module at top of server.js
// ==============================================================
server = apply('Import ai-training module', server,
  `const APP_NAME = 'MW Craft';`,
  `const aiTraining = require('./ai-training');
const trainingSession = new aiTraining.TrainingSession();
const DIFFICULTY_PRESETS = aiTraining.DIFFICULTY_PRESETS;
const APP_NAME = 'MW Craft';`
);

// ==============================================================
// 2. Add aiDifficulty to createRoomState
// ==============================================================
server = apply('Add aiDifficulty to room state', server,
  `    nextRedZoneRollAt: Date.now() + RED_ZONE_SELECTION_INTERVAL_MS,
    lastRedZoneCountdownSecond: null
  };
}`,
  `    nextRedZoneRollAt: Date.now() + RED_ZONE_SELECTION_INTERVAL_MS,
    lastRedZoneCountdownSecond: null,
    aiDifficulty: 'normal'
  };
}`
);

// ==============================================================
// 3. Include aiDifficulty in /api/rooms response
// ==============================================================
server = apply('Add aiDifficulty to /api/rooms', server,
  `    return { id: rc.id, name: rc.name, maxPlayers: rc.maxPlayers, playerCount, aiCount };`,
  `    const aiDifficulty = room ? (room.aiDifficulty || 'normal') : 'normal';
    return { id: rc.id, name: rc.name, maxPlayers: rc.maxPlayers, playerCount, aiCount, aiDifficulty };`
);

// ==============================================================
// 4. Add training API endpoints after /api/login
// ==============================================================
server = apply('Add training API endpoints', server,
  `// Reset player game data (keeps account, resets progress) - respawn at random location`,
  `// AI Training API endpoints
app.get('/api/ai-training/status', (req, res) => {
  res.json(trainingSession.getStatus());
});

app.post('/api/ai-training/start', (req, res) => {
  const episodes = Math.min(Math.max(parseInt(req.body.episodes) || 500, 10), 50000);
  const ok = trainingSession.startTraining(episodes, (result) => {
    console.log('[AI-RL] Training callback:', result);
  });
  res.json({ started: ok, episodes });
});

app.post('/api/ai-training/stop', (req, res) => {
  trainingSession.stopTraining();
  res.json({ stopped: true });
});

app.get('/api/ai-training/weights', (req, res) => {
  const stats = trainingSession.qTable.getStats();
  res.json(stats);
});

// Reset player game data (keeps account, resets progress) - respawn at random location`
);

// ==============================================================
// 5. Add setAIDifficulty socket handler + include difficulty in init
// ==============================================================
server = apply('Add setAIDifficulty socket handler', server,
  `  socket.on('addAI', () => {`,
  `  // AI Difficulty setting: first human player in room sets it
  socket.on('setAIDifficulty', (data) => {
    switchRoom(socket.roomId);
    if (!gameState) return;
    const difficulty = data && data.difficulty;
    if (!DIFFICULTY_PRESETS[difficulty]) return;
    gameState.aiDifficulty = difficulty;
    io.to(socket.roomId).emit('aiDifficultyChanged', { difficulty, label: DIFFICULTY_PRESETS[difficulty].label });
    console.log(\`[AI] Room \${socket.roomId} difficulty set to \${difficulty} by \${socket.username}\`);
  });

  socket.on('addAI', () => {`
);

// ==============================================================
// 6. Include aiDifficulty in the 'init' event
// ==============================================================
server = apply('Include aiDifficulty in init event', server,
  `    socket.emit('init', {`,
  `    socket.emit('init', {
      aiDifficulty: gameState.aiDifficulty || 'normal',`
);

// ==============================================================
// 7. Integrate RL into updateAI — after combat power calculation
// ==============================================================
// We need to add the RL action selection near the top of the per-player loop,
// then use it to override/supplement decisions.
server = apply('Add RL state + action to updateAI per-player', server,
  `    // Set target combat power if not set
    if (!player.targetCombatPower) {
      player.targetCombatPower = 300 + Math.floor(Math.random() * 401); // 300-700
    }`,
  `    // Set target combat power if not set
    if (!player.targetCombatPower) {
      player.targetCombatPower = 300 + Math.floor(Math.random() * 401); // 300-700
    }

    // --- RL Integration ---
    const roomDifficulty = gameState.aiDifficulty || 'normal';
    const diffPreset = DIFFICULTY_PRESETS[roomDifficulty] || DIFFICULTY_PRESETS.normal;
    const rlActionIdx = trainingSession.getAction(gameState, playerId, roomDifficulty);
    const rlAction = rlActionIdx !== null ? aiTraining.ACTIONS[rlActionIdx] : null;

    // Resource bonus for expert difficulty
    if (diffPreset.resourceBonus && Math.random() < 0.5) {
      player.resources += 10 * (diffPreset.resourceBonus - 1);
    }

    // Online learning: record state/reward transitions
    const currentState = aiTraining.encodeState(gameState, playerId);
    if (player._prevRLState && player._prevRLAction !== undefined) {
      const snapshot = aiTraining.takeSnapshot(gameState, playerId);
      const prevSnapshot = player._prevRLSnapshot || snapshot;
      const reward = aiTraining.calculateReward(prevSnapshot, snapshot);
      trainingSession.recordTransition(player._prevRLState, player._prevRLAction, reward, currentState);
    }
    if (rlActionIdx !== null) {
      player._prevRLState = currentState;
      player._prevRLAction = rlActionIdx;
      player._prevRLSnapshot = aiTraining.takeSnapshot(gameState, playerId);
    }`
);

// ==============================================================
// 8. Apply difficulty-based building caps (replace hard-coded ones)
// ==============================================================
server = apply('Difficulty-based powerPlant cap', server,
  `} else if (powerPlantCount < 20 && player.resources >= 150 && Math.random() < 0.7) {`,
  `} else if (powerPlantCount < (diffPreset.maxPowerPlants || 20) && player.resources >= 150 && Math.random() < 0.7) {`
);

server = apply('Difficulty-based silo cap', server,
  `} else if (missileSiloCount < 5 && player.resources >= MISSILE_SILO_COST) {`,
  `} else if (missileSiloCount < (diffPreset.maxSilos || 5) && player.resources >= MISSILE_SILO_COST) {`
);

server = apply('Difficulty-based tower cap', server,
  `} else if (defenseCount < 10 && player.resources >= 250) {`,
  `} else if (defenseCount < (diffPreset.maxTowers || 10) && player.resources >= 250) {`
);

server = apply('Difficulty-based worker limit', server,
  `    if (aiWorkers.length < 1 && headquartersId && player.resources >= 50 && player.population < player.maxPopulation) {`,
  `    if (aiWorkers.length < (diffPreset.maxWorkers || 1) && headquartersId && player.resources >= 50 && player.population < player.maxPopulation) {`
);

// ==============================================================
// 9. HTML: Add difficulty selector to login form
// ==============================================================
html = apply('Add AI difficulty selector to login', html,
  `                <button id="loginBtn">접속</button>`,
  `                <div style="margin: 8px 0;">
                    <label style="color: #aaa; font-size: 13px; display: block; margin-bottom: 4px;">AI 난이도</label>
                    <select id="aiDifficultySelect" style="width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #8f99a3; background: #20252b; color: #fff; font-size: 14px; cursor: pointer;">
                        <option value="easy">쉬움 - 초보자용</option>
                        <option value="normal" selected>보통 - 기본 AI</option>
                        <option value="hard">어려움 - 강화학습 AI</option>
                        <option value="expert">전문가 - 최강 AI</option>
                    </select>
                    <div id="difficultyDesc" style="color: #888; font-size: 11px; margin-top: 4px;">규칙 기반 AI, 기본 난이도</div>
                </div>
                <button id="loginBtn">접속</button>`
);

// ==============================================================
// 10. HTML: Add training panel (hidden, admin-accessible)
// ==============================================================
html = apply('Add training panel HTML', html,
  `        <!-- Rankings Panel -->`,
  `        <!-- AI Training Panel (admin only) -->
        <div id="trainingPanel" style="display:none;">
            <div class="training-header">
                <h3>🧠 AI 강화학습</h3>
                <button id="trainingCloseBtn" class="training-close">&times;</button>
            </div>
            <div class="training-body">
                <div class="training-status">
                    <div>상태: <span id="trainStatus">대기중</span></div>
                    <div>에피소드: <span id="trainEpisode">0</span> / <span id="trainMaxEpisode">0</span></div>
                    <div>탐색 상태: <span id="trainStates">0</span></div>
                    <div>평균 보상: <span id="trainAvgReward">0</span></div>
                    <div>탐험률(ε): <span id="trainEpsilon">0.3</span></div>
                </div>
                <div class="training-controls">
                    <label style="color:#aaa;font-size:12px;">에피소드 수:</label>
                    <input type="number" id="trainEpisodeInput" value="500" min="10" max="50000" style="width:80px;padding:4px;background:#1a1f25;color:#fff;border:1px solid #555;border-radius:4px;">
                    <button id="trainStartBtn" class="train-btn train-start">학습 시작</button>
                    <button id="trainStopBtn" class="train-btn train-stop" disabled>중단</button>
                </div>
                <div id="trainingLog" class="training-log"></div>
            </div>
        </div>

        <!-- Rankings Panel -->`
);

// ==============================================================
// 11. game.js: Add difficulty selector logic + training panel
// ==============================================================
gameJs = apply('Add difficulty description updater', gameJs,
  `document.getElementById('loginBtn').addEventListener('click', login);`,
  `// AI Difficulty description
const diffDescs = {
    easy: '약화된 규칙 기반 AI. 느린 판단, 적은 건물/유닛',
    normal: '규칙 기반 AI, 기본 난이도',
    hard: '강화학습으로 훈련된 AI. 전략적 판단 + 스킬 활용',
    expert: '최강 강화학습 AI. 자원 보너스 + 빠른 판단 + 완벽한 전략'
};
const diffSelect = document.getElementById('aiDifficultySelect');
const diffDesc = document.getElementById('difficultyDesc');
if (diffSelect && diffDesc) {
    diffSelect.addEventListener('change', () => {
        diffDesc.textContent = diffDescs[diffSelect.value] || '';
    });
}

document.getElementById('loginBtn').addEventListener('click', login);`
);

// Add setAIDifficulty emit after socket connect + init handler
gameJs = apply('Emit setAIDifficulty on connect', gameJs,
  `    socket.on('init', (data) => {`,
  `    socket.on('aiDifficultyChanged', (data) => {
        if (data && data.label) {
            addSystemLog('AI 난이도 변경: ' + data.label);
        }
    });

    socket.on('init', (data) => {`
);

// After receiving init, emit setAIDifficulty
gameJs = apply('Send difficulty after init', gameJs,
  `        // Receive full game state`,
  `        // Set AI difficulty (first human player sets it)
        const selectedDiff = document.getElementById('aiDifficultySelect');
        if (selectedDiff && selectedDiff.value) {
            socket.emit('setAIDifficulty', { difficulty: selectedDiff.value });
        }

        // Receive full game state`
);

// Add training panel logic at the end
gameJs = apply('Add training panel logic before fetchRoomInfo', gameJs,
  `// Fetch server room info for login screen`,
  `// --- AI Training Panel ---
(function() {
    const panel = document.getElementById('trainingPanel');
    const closeBtn = document.getElementById('trainingCloseBtn');
    const startBtn = document.getElementById('trainStartBtn');
    const stopBtn = document.getElementById('trainStopBtn');
    const episodeInput = document.getElementById('trainEpisodeInput');
    const logDiv = document.getElementById('trainingLog');
    let trainPollTimer = null;

    // Show training panel via key combo: Ctrl+Shift+T
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'T') {
            if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        }
    });

    if (closeBtn) closeBtn.addEventListener('click', () => { panel.style.display = 'none'; stopPolling(); });

    if (startBtn) startBtn.addEventListener('click', async () => {
        const episodes = parseInt(episodeInput.value) || 500;
        try {
            const res = await fetch('/api/ai-training/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ episodes })
            });
            const data = await res.json();
            if (data.started) {
                startBtn.disabled = true;
                stopBtn.disabled = false;
                startPolling();
            }
        } catch(e) { console.error('Training start error:', e); }
    });

    if (stopBtn) stopBtn.addEventListener('click', async () => {
        try {
            await fetch('/api/ai-training/stop', { method: 'POST' });
            stopBtn.disabled = true;
            startBtn.disabled = false;
            stopPolling();
        } catch(e) { console.error('Training stop error:', e); }
    });

    function startPolling() {
        stopPolling();
        trainPollTimer = setInterval(pollStatus, 2000);
    }
    function stopPolling() {
        if (trainPollTimer) { clearInterval(trainPollTimer); trainPollTimer = null; }
    }

    async function pollStatus() {
        try {
            const res = await fetch('/api/ai-training/status');
            const data = await res.json();
            const s = document.getElementById('trainStatus');
            if (s) s.textContent = data.isTraining ? '학습 중...' : '대기중';
            const ep = document.getElementById('trainEpisode');
            if (ep) ep.textContent = data.currentEpisode || 0;
            const mx = document.getElementById('trainMaxEpisode');
            if (mx) mx.textContent = data.maxEpisodes || 0;
            if (data.stats) {
                const st = document.getElementById('trainStates');
                if (st) st.textContent = data.stats.states || 0;
                const ar = document.getElementById('trainAvgReward');
                if (ar) ar.textContent = data.stats.avgReward || 0;
                const eps = document.getElementById('trainEpsilon');
                if (eps) eps.textContent = data.stats.epsilon || 0;
            }
            if (logDiv && data.log) {
                logDiv.innerHTML = data.log.map(l => '<div>' + l + '</div>').join('');
                logDiv.scrollTop = logDiv.scrollHeight;
            }
            if (!data.isTraining) {
                startBtn.disabled = false;
                stopBtn.disabled = true;
                stopPolling();
            }
        } catch(e) {}
    }
})();

// Fetch server room info for login screen`
);

// Add addSystemLog function if not present
if (!gameJs.includes('function addSystemLog')) {
  gameJs = apply('Add addSystemLog helper', gameJs,
    `// --- AI Training Panel ---`,
    `function addSystemLog(msg) {
    const logEl = document.getElementById('gameLog');
    if (logEl) {
        const row = document.createElement('div');
        row.textContent = '[시스템] ' + msg;
        row.style.color = '#ffcc00';
        logEl.appendChild(row);
        if (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
        logEl.scrollTop = logEl.scrollHeight;
    }
}

// --- AI Training Panel ---`
  );
}

// ==============================================================
// 12. CSS: Training panel + difficulty selector styles
// ==============================================================
css += `
/* AI Training Panel */
#trainingPanel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 480px;
    max-height: 600px;
    background: #1a1f25;
    border: 2px solid #4a9eff;
    border-radius: 12px;
    z-index: 10000;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    overflow: hidden;
}
.training-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    background: #252b33;
    border-bottom: 1px solid #333;
}
.training-header h3 {
    margin: 0;
    color: #4a9eff;
    font-size: 16px;
}
.training-close {
    background: none;
    border: none;
    color: #aaa;
    font-size: 22px;
    cursor: pointer;
    padding: 0 4px;
}
.training-close:hover { color: #ff4444; }
.training-body {
    padding: 16px;
}
.training-status {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-bottom: 12px;
    font-size: 13px;
    color: #ccc;
}
.training-status span {
    color: #4a9eff;
    font-weight: bold;
}
.training-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    flex-wrap: wrap;
}
.train-btn {
    padding: 6px 14px;
    border: none;
    border-radius: 6px;
    font-size: 13px;
    font-weight: bold;
    cursor: pointer;
    transition: background 0.2s;
}
.train-start { background: #2d7d46; color: #fff; }
.train-start:hover { background: #3a9957; }
.train-start:disabled { background: #555; cursor: not-allowed; }
.train-stop { background: #c23030; color: #fff; }
.train-stop:hover { background: #e04040; }
.train-stop:disabled { background: #555; cursor: not-allowed; }
.training-log {
    max-height: 200px;
    overflow-y: auto;
    background: #0d1117;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 8px;
    font-size: 11px;
    font-family: monospace;
    color: #8b949e;
}
.training-log div {
    padding: 2px 0;
    border-bottom: 1px solid #1a1f25;
}
`;
patchCount++;
console.log('OK   [Add training panel CSS]');

// ==============================================================
// Also update /api/rooms to include difficulty info per room
// ==============================================================

// ==============================================================
// Write all files
// ==============================================================
writeFile('server.js', server);
writeFile('public/index.html', html);
writeFile('public/game.js', gameJs);
writeFile('public/style.css', css);

console.log(`\nPatch complete: ${patchCount} patches applied.`);
