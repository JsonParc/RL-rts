const fs = require('fs');

// =====================================================================
// PATCH: server.js
// =====================================================================
let server = fs.readFileSync('server.js', 'utf8');

// --- FIX 1: Add unit.angle to client state payload ---
const anglePayloadOld = `      squadId: unit.squadId ?? null,
      formationType: unit.squadId ? (gameState.squads.get(unit.squadId)?.formationType || 'trapezoid') : null
    });`;
const anglePayloadNew = `      squadId: unit.squadId ?? null,
      formationType: unit.squadId ? (gameState.squads.get(unit.squadId)?.formationType || 'trapezoid') : null,
      angle: unit.angle ?? 0
    });`;
if (!server.includes(anglePayloadOld)) { console.error('PATCH1 not found'); process.exit(1); }
server = server.replace(anglePayloadOld, anglePayloadNew);
console.log('PATCH1: unit.angle added to payload');

// --- FIX 2: Upgrade AI_CONFIG ---
const aiConfigOld = `const AI_CONFIG = {
  count: 2, // Number of AI players
  updateInterval: 3000, // AI decision interval (ms)
  respawnDelayMs: 10000, // How long defeated AI stays out of the room
  scoutInterval: 10000, // How often to send scouts
  buildingPriority: ['power_plant', 'shipyard', 'naval_academy', 'missile_silo', 'defense_tower'],
  unitPriority: ['worker', 'destroyer', 'cruiser', 'frigate', 'submarine', 'battleship', 'carrier'],
  attackerTrackingDuration: 5000, // How long to remember attackers (5 seconds)
  counterattackThreshold: 3, // Minimum attackers to trigger counterattack response
  priorityTargetDuration: 60000, // Drop stale raid targets after 1 minute
  maxPriorityTargets: 12,
  // Combat power scoring per unit type
  combatPower: {
    frigate: 30,
    destroyer: 150,
    cruiser: 100,
    battleship: 200,
    carrier: 180,
    submarine: 200,
    assaultship: 100,
    missile_launcher: 100
  },
  // Island expansion threshold
  expansionBuildingThreshold: 10
};`;
const aiConfigNew = `const AI_CONFIG = {
  count: 2, // Number of AI players
  updateInterval: 2000, // AI decision interval (ms) - faster decisions
  respawnDelayMs: 10000,
  scoutInterval: 8000,
  buildingPriority: ['power_plant', 'shipyard', 'naval_academy', 'missile_silo', 'defense_tower'],
  unitPriority: ['worker', 'destroyer', 'cruiser', 'frigate', 'submarine', 'battleship', 'carrier'],
  attackerTrackingDuration: 8000,
  counterattackThreshold: 1, // React immediately to any attacker
  priorityTargetDuration: 90000,
  maxPriorityTargets: 20,
  combatPower: {
    frigate: 30,
    destroyer: 150,
    cruiser: 100,
    battleship: 200,
    carrier: 180,
    submarine: 200,
    assaultship: 100,
    missile_launcher: 100
  },
  expansionBuildingThreshold: 8
};`;
if (!server.includes(aiConfigOld)) { console.error('PATCH2 not found'); process.exit(1); }
server = server.replace(aiConfigOld, aiConfigNew);
console.log('PATCH2: AI_CONFIG upgraded');

// --- FIX 3: Overhaul updateAI - building section (worker limit, more buildings) ---
const aiBuildOld = `    // --- DEVELOPMENT: Build structures ---
    if (aiWorkers.length > 0) {
      const idleWorker = aiWorkers.find(w => !w.buildingType && !w.gatheringResourceId && !w.targetX);
      
      if (idleWorker && player.resources > 150) {
        let buildType = null;
        let buildCost = 0;
        
        if (!hasPowerPlant && player.resources >= 150) {
          buildType = 'power_plant';
          buildCost = 150;
        } else if (!hasShipyard && player.resources >= 200) {
          buildType = 'shipyard';
          buildCost = 200;
        } else if (!hasNavalAcademy && player.resources >= 300) {
          buildType = 'naval_academy';
          buildCost = 300;
        } else if (powerPlantCount < 3 && player.resources >= 150) {
          buildType = 'power_plant';
          buildCost = 150;
        } else if (!hasMissileSilo && player.resources >= MISSILE_SILO_COST) {
          buildType = 'missile_silo';
          buildCost = MISSILE_SILO_COST;
        } else if (defenseCount < 3 && player.resources >= 250) {
          buildType = 'defense_tower';
          buildCost = 250;
        } else if (player.resources >= 300 && Math.random() < 0.2) {
          // Random extra building
          const extras = ['power_plant', 'defense_tower', 'naval_academy'];
          buildType = extras[Math.floor(Math.random() * extras.length)];
          buildCost = buildType === 'power_plant' ? 150 : buildType === 'defense_tower' ? 250 : 300;
        }
        
        if (buildType && player.resources >= buildCost) {
          const angle = Math.random() * Math.PI * 2;
          const distance = 300 + Math.random() * 200;
          const buildX = player.baseX + Math.cos(angle) * distance;
          const buildY = player.baseY + Math.sin(angle) * distance;
          
          if (isOnLand(buildX, buildY)) {
            idleWorker.buildingType = buildType;
            idleWorker.buildTargetX = buildX;
            idleWorker.buildTargetY = buildY;
            idleWorker.targetX = buildX;
            idleWorker.targetY = buildY;
            idleWorker.gatheringResourceId = null;
          }
        }
      }`;
const aiBuildNew = `    // --- DEVELOPMENT: Build structures ---
    // Count shipyard/naval_academy multiples
    let navalAcademyCount = 0;
    let carbaseCount = 0;
    gameState.buildings.forEach(b => {
      if (b.userId === playerId && b.buildProgress >= 100) {
        if (b.type === 'naval_academy') navalAcademyCount++;
        if (b.type === 'carbase') carbaseCount++;
      }
    });

    if (aiWorkers.length > 0) {
      // Try multiple idle workers each tick for faster building
      const idleWorkers = aiWorkers.filter(w => !w.buildingType && !w.gatheringResourceId && !w.targetX);
      
      idleWorkers.slice(0, 2).forEach(idleWorker => {
        if (player.resources <= 150) return;
        let buildType = null;
        let buildCost = 0;
        
        if (!hasPowerPlant && player.resources >= 150) {
          buildType = 'power_plant'; buildCost = 150;
        } else if (!hasShipyard && player.resources >= 200) {
          buildType = 'shipyard'; buildCost = 200;
        } else if (!hasNavalAcademy && player.resources >= 300) {
          buildType = 'naval_academy'; buildCost = 300;
        } else if (powerPlantCount < 6 && player.resources >= 150 && Math.random() < 0.7) {
          buildType = 'power_plant'; buildCost = 150;
        } else if (shipyardCount < 4 && hasShipyard && player.resources >= 200) {
          buildType = 'shipyard'; buildCost = 200;
        } else if (navalAcademyCount < 3 && hasNavalAcademy && player.resources >= 300) {
          buildType = 'naval_academy'; buildCost = 300;
        } else if (!hasMissileSilo && player.resources >= MISSILE_SILO_COST) {
          buildType = 'missile_silo'; buildCost = MISSILE_SILO_COST;
        } else if (defenseCount < 8 && player.resources >= 250) {
          buildType = 'defense_tower'; buildCost = 250;
        } else if (player.resources >= 200) {
          const extras = ['power_plant', 'defense_tower', 'shipyard', 'naval_academy'];
          buildType = extras[Math.floor(Math.random() * extras.length)];
          buildCost = buildType === 'power_plant' ? 150 : buildType === 'defense_tower' ? 250 : buildType === 'shipyard' ? 200 : 300;
        }
        
        if (buildType && player.resources >= buildCost) {
          const angle = Math.random() * Math.PI * 2;
          const distance = 200 + Math.random() * 300;
          const buildX = player.baseX + Math.cos(angle) * distance;
          const buildY = player.baseY + Math.sin(angle) * distance;
          
          if (isOnLand(buildX, buildY)) {
            player.resources -= buildCost; // Reserve cost immediately to avoid double-spending
            idleWorker.buildingType = buildType;
            idleWorker.buildTargetX = buildX;
            idleWorker.buildTargetY = buildY;
            idleWorker.targetX = buildX;
            idleWorker.targetY = buildY;
            idleWorker.gatheringResourceId = null;
          }
        }
      });`;
if (!server.includes(aiBuildOld)) { console.error('PATCH3 not found'); process.exit(1); }
server = server.replace(aiBuildOld, aiBuildNew);
console.log('PATCH3: AI building section upgraded');

// --- FIX 4: Upgrade worker limit and unit production ---
const aiWorkerOld = `    // --- DEVELOPMENT: Build units ---
    // Build workers if needed (more workers for economy)
    if (aiWorkers.length < 8 && headquartersId && player.resources >= 50 && player.population < player.maxPopulation) {
      buildUnitForAI(playerId, headquartersId, 'worker');
    }
    
    // --- ARMY COMPOSITION: Build towards target combat power ---
    if (currentCombatPower < player.targetCombatPower) {
      // Decide what to build based on what we can afford and need
      if (hasShipyard && player.population + 1 <= player.maxPopulation) {
        // Weighted random unit choice from shipyard
        const roll = Math.random();
        if (roll < 0.30 && player.resources >= 120) {
          buildUnitForAI(playerId, shipyardId, 'frigate');
        } else if (roll < 0.65 && player.resources >= 150) {
          buildUnitForAI(playerId, shipyardId, 'destroyer');
        } else if (player.resources >= 300) {
          buildUnitForAI(playerId, shipyardId, 'cruiser');
        }
      }
      
      if (hasNavalAcademy && player.population + getUnitDefinition('submarine').pop <= player.maxPopulation) {
        const roll = Math.random();
        if (roll < 0.35 && player.resources >= 600) {
          buildUnitForAI(playerId, navalAcademyId, 'battleship');
        } else if (roll < 0.55 && player.resources >= 800) {
          buildUnitForAI(playerId, navalAcademyId, 'carrier');
        } else if (roll < 0.70 && player.resources >= 900) {
          buildUnitForAI(playerId, navalAcademyId, 'submarine');
        }
      }
    }
    
    // When target reached, set a new higher target
    if (currentCombatPower >= player.targetCombatPower) {
      player.targetCombatPower = currentCombatPower + 100 + Math.floor(Math.random() * 200);
    }`;
const aiWorkerNew = `    // --- DEVELOPMENT: Build units ---
    // Aggressively build workers
    if (aiWorkers.length < 15 && headquartersId && player.resources >= 50 && player.population < player.maxPopulation) {
      buildUnitForAI(playerId, headquartersId, 'worker');
    }
    
    // --- ARMY COMPOSITION: Always build combat units ---
    // Build from all available shipyards
    if (hasShipyard) {
      gameState.buildings.forEach(b => {
        if (b.userId !== playerId || b.type !== 'shipyard' || b.buildProgress < 100) return;
        if (player.population + 1 > player.maxPopulation) return;
        const roll = Math.random();
        if (roll < 0.25 && player.resources >= 120) {
          buildUnitForAI(playerId, b.id, 'frigate');
        } else if (roll < 0.55 && player.resources >= 150) {
          buildUnitForAI(playerId, b.id, 'destroyer');
        } else if (player.resources >= 300) {
          buildUnitForAI(playerId, b.id, 'cruiser');
        }
      });
    }
    
    // Build from all available naval academies
    if (hasNavalAcademy) {
      gameState.buildings.forEach(b => {
        if (b.userId !== playerId || b.type !== 'naval_academy' || b.buildProgress < 100) return;
        if (player.population + getUnitDefinition('submarine').pop > player.maxPopulation) return;
        const roll = Math.random();
        if (roll < 0.40 && player.resources >= 600) {
          buildUnitForAI(playerId, b.id, 'battleship');
        } else if (roll < 0.60 && player.resources >= 800) {
          buildUnitForAI(playerId, b.id, 'carrier');
        } else if (roll < 0.80 && player.resources >= 900) {
          buildUnitForAI(playerId, b.id, 'submarine');
        } else if (player.resources >= 500) {
          buildUnitForAI(playerId, b.id, 'assaultship');
        }
      });
    }
    
    // Always update targetCombatPower dynamically
    if (!player.targetCombatPower || currentCombatPower >= player.targetCombatPower) {
      player.targetCombatPower = Math.max(80, currentCombatPower + 50 + Math.floor(Math.random() * 100));
    }`;
if (!server.includes(aiWorkerOld)) { console.error('PATCH4 not found'); process.exit(1); }
server = server.replace(aiWorkerOld, aiWorkerNew);
console.log('PATCH4: AI unit production upgraded');

// --- FIX 5: AI uses skills (aegis, aimed shot, combat stance) ---
const aiAimedOld = `    // --- AI AIMED SHOT: Battleships use aimed shot when off cooldown ---
    const aiBattleships = aiCombatUnits.filter(u => u.type === 'battleship');
    aiBattleships.forEach(bs => {
      if (!bs.aimedShot && (!bs.aimedShotCooldownUntil || now >= bs.aimedShotCooldownUntil)) {
        if (bs.attackTargetId) {
          bs.aimedShot = true;
        }
      }
    });`;
const aiAimedNew = `    // --- AI SKILLS: Use all available skills ---
    const aiBattleships = aiCombatUnits.filter(u => u.type === 'battleship');
    aiBattleships.forEach((bs, idx) => {
      initializeUnitRuntimeState(bs);
      // Aimed shot when off cooldown and has a target
      if (!bs.aimedShot && (!bs.aimedShotCooldownUntil || now >= bs.aimedShotCooldownUntil)) {
        if (bs.attackTargetId && !bs.battleshipAegisMode) {
          bs.aimedShot = true;
        }
      }
      // Combat stance: activate on battleships that are actively attacking
      if (!bs.combatStanceActive && bs.attackTargetId && bs.hp > bs.maxHp * 0.4) {
        bs.combatStanceActive = true;
        refreshBattleshipModeState(bs);
      }
      // Aegis mode: put some battleships in aegis mode for area-denial defense
      // First battleship used as defender (aegis), rest as attackers (combat stance)
      if (idx === 0 && !bs.battleshipAegisMode && aiCombatUnits.length >= 4) {
        bs.battleshipAegisMode = true;
        bs.aimedShot = false;
        bs.combatStanceActive = false;
        bs.battleshipAegisTurretTargetLocks = Array.from({ length: BATTLESHIP_AEGIS_TURRET_COUNT }, () => null);
        refreshBattleshipModeState(bs);
      }
    });
    
    // AI Cruisers: use aegis mode for defense
    const aiCruisers = aiCombatUnits.filter(u => u.type === 'cruiser');
    aiCruisers.forEach((cr, idx) => {
      if (idx === 0 && !cr.aegisMode && aiCombatUnits.length >= 5) {
        cr.aegisMode = true;
      }
    });`;
if (!server.includes(aiAimedOld)) { console.error('PATCH5 not found'); process.exit(1); }
server = server.replace(aiAimedOld, aiAimedNew);
console.log('PATCH5: AI skills (aegis, combat stance) added');

// --- FIX 6: Reduce attack threshold and cooldown ---
const aiAttackOld = `    const canAttack = currentCombatPower >= Math.min(player.targetCombatPower * 0.6, 150);
    const hasPriorityTargets = player.priorityTargets && player.priorityTargets.length > 0;
    const hasTargets = (player.knownEnemyPositions && player.knownEnemyPositions.length > 0) || hasPriorityTargets;
    const attackCooldown = now - player.lastAttackTime > 20000; // 20 second cooldown between attacks
    // Shorter cooldown for counterattacks (immediate response)
    const counterattackCooldown = now - player.lastAttackTime > 5000;`;
const aiAttackNew = `    const canAttack = currentCombatPower >= Math.min(player.targetCombatPower * 0.4, 60);
    const hasPriorityTargets = player.priorityTargets && player.priorityTargets.length > 0;
    const hasTargets = (player.knownEnemyPositions && player.knownEnemyPositions.length > 0) || hasPriorityTargets;
    const attackCooldown = now - player.lastAttackTime > 8000; // 8s cooldown (was 20s)
    const counterattackCooldown = now - player.lastAttackTime > 2000; // near-instant counterattack`;
if (!server.includes(aiAttackOld)) { console.error('PATCH6 not found'); process.exit(1); }
server = server.replace(aiAttackOld, aiAttackNew);
console.log('PATCH6: AI attack threshold reduced');

// --- FIX 7: Remove min 3 units requirement ---
const aiAttackMinOld = `    } else if (canAttack && hasTargets && attackCooldown && aiCombatUnits.length >= 3 && !player.isCounterattacking) {`;
const aiAttackMinNew = `    } else if (canAttack && hasTargets && attackCooldown && aiCombatUnits.length >= 1 && !player.isCounterattacking) {`;
if (!server.includes(aiAttackMinOld)) { console.error('PATCH7 not found'); process.exit(1); }
server = server.replace(aiAttackMinOld, aiAttackMinNew);
console.log('PATCH7: AI minimum attack threshold reduced to 1');

// --- FIX 8: Add addAI and removeAI socket handlers ---
const addAIHandlerMarker = `  socket.on('unlockBattleshipModeCombo', () => {`;
const addAIHandlerNew = `  // Secret admin: dynamically add/remove AI players
  socket.on('addAI', () => {
    switchRoom(socket.roomId);
    if (!gameState) return;
    let newIndex = 0;
    while (gameState.players.has(getAIUserId(newIndex))) newIndex++;
    const aiPlayer = spawnAIPlayer(newIndex);
    if (aiPlayer) {
      io.to(socket.roomId).emit('playerJoined', aiPlayer);
      socket.emit('systemMessage', { text: 'AI 플레이어 추가됨: ' + aiPlayer.username });
    }
  });

  socket.on('removeAI', () => {
    switchRoom(socket.roomId);
    if (!gameState) return;
    // Remove the AI with the highest index
    let lastAiId = null;
    gameState.players.forEach((player, userId) => {
      if (player.isAI) {
        if (lastAiId === null || userId > lastAiId) lastAiId = userId;
      }
    });
    if (lastAiId !== null) {
      const removedName = gameState.players.get(lastAiId)?.username || 'AI';
      clearActiveWeaponsForUser(lastAiId);
      removePlayerFromCurrentRoom(lastAiId, { emitPlayerLeft: true });
      socket.emit('systemMessage', { text: 'AI 플레이어 제거됨: ' + removedName });
    } else {
      socket.emit('systemMessage', { text: '제거할 AI 플레이어 없음' });
    }
  });

  socket.on('unlockBattleshipModeCombo', () => {`;
if (!server.includes(addAIHandlerMarker)) { console.error('PATCH8 marker not found'); process.exit(1); }
server = server.replace(addAIHandlerMarker, addAIHandlerNew);
console.log('PATCH8: addAI/removeAI socket handlers added');

fs.writeFileSync('server.js', server);
console.log('server.js saved OK');

// =====================================================================
// PATCH: public/game.js
// =====================================================================
let game = fs.readFileSync('public/game.js', 'utf8');

// --- GAME PATCH 1: Squad uniform facing in updateUnitInterpolation ---
const interpOld = `            if (moveDist > 0.5) {
                // Moving: use actual movement vector as facing
                unit.displayAngle = Math.atan2(moveDy, moveDx);
                // Also keep commandAngle in sync so it holds this angle when stopped
                unit.commandAngle = unit.displayAngle;
            } else {
                // Stopped: hold commandAngle set by the last player command (or last movement)
                unit.displayAngle = unit.commandAngle !== undefined ? unit.commandAngle : 0;
            }`;
const interpNew = `            if (moveDist > 0.5) {
                // Squad units: lock all to squad's uniform facing angle from server
                if (unit.squadId && unit.angle !== undefined && unit.angle !== null) {
                    unit.displayAngle = unit.angle;
                } else {
                    unit.displayAngle = Math.atan2(moveDy, moveDx);
                }
                unit.commandAngle = unit.displayAngle;
            } else {
                // Stopped: for squad use server angle, otherwise commandAngle
                if (unit.squadId && unit.angle !== undefined && unit.angle !== null) {
                    unit.displayAngle = unit.angle;
                } else {
                    unit.displayAngle = unit.commandAngle !== undefined ? unit.commandAngle : 0;
                }
            }`;
if (!game.includes(interpOld)) { console.error('GAME PATCH1 not found'); process.exit(1); }
game = game.replace(interpOld, interpNew);
console.log('GAME PATCH1: Squad uniform facing applied');

// --- GAME PATCH 2: Listen for systemMessage from server ---
const systemMsgMarker = `socket.on('gameUpdate', (data) => {`;
if (!game.includes(systemMsgMarker)) { console.error('GAME PATCH2 marker not found'); process.exit(1); }
// We won't add it here - add it in the socket event section later separately

fs.writeFileSync('public/game.js', game);
console.log('public/game.js saved OK');

console.log('\nAll patches applied successfully!');
