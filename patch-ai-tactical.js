/**
 * patch-ai-tactical.js
 *
 * Applies:
 * 1. Red zone blast damage 999 → 999999 (instant kill)
 * 2. Red zone: dynamic interval (more entities = faster), guaranteed player island
 * 3. AI building caps: power plants ≤20, silos ≤5, towers ≤10, workers 1
 * 4. AI carbase bypass prerequisite check for AI players
 * 5. Carbase building + missile_launcher production by AI
 * 6. AI missile_launcher auto-deploy behavior
 * 7. AI lure tactic (frigate bait toward deployed launchers)
 * 8. AI mine-laying near enemy approach paths
 * 9. AI SLBM targeting: prefer strongest known enemy positions
 */

const fs = require('fs');
const path = require('path');
const serverPath = path.join(__dirname, 'server.js');

let code = fs.readFileSync(serverPath, 'utf8');

let patchCount = 0;
function apply(description, searchStr, replaceStr) {
  if (!code.includes(searchStr)) {
    console.error(`FAILED [${description}] - search string not found`);
    return;
  }
  code = code.replace(searchStr, replaceStr);
  console.log(`OK [${description}]`);
  patchCount++;
}

// ============================================================
// 1. Red zone blast damage: 999 → 999999
// ============================================================
apply(
  'RED_ZONE_BLAST_DAMAGE instant kill',
  'const RED_ZONE_BLAST_DAMAGE = 999;',
  'const RED_ZONE_BLAST_DAMAGE = 999999;'
);

// ============================================================
// 2. Allow AI to bypass carbase prerequisite (AI userId <= -1000)
// ============================================================
apply(
  'AI carbase prereq bypass',
  `function canBuildCarbaseForUser(userId) {
  return CARBASE_PREREQ_BUILDINGS.every(type => getCompletedOwnedBuildingCount(userId, type) >= 2);
}`,
  `function canBuildCarbaseForUser(userId) {
  // AI players bypass strict carbase prerequisites
  if (userId <= -1000) return true;
  return CARBASE_PREREQ_BUILDINGS.every(type => getCompletedOwnedBuildingCount(userId, type) >= 2);
}`
);

// ============================================================
// 3. Add missileSiloCount to building tracker declarations
// ============================================================
apply(
  'Add missileSiloCount variable',
  `    let powerPlantCount = 0;
    let shipyardCount = 0;
    let defenseCount = 0;`,
  `    let powerPlantCount = 0;
    let shipyardCount = 0;
    let defenseCount = 0;
    let missileSiloCount = 0;`
);

// ============================================================
// 4. Increment missileSiloCount in building loop
// ============================================================
apply(
  'Increment missileSiloCount in loop',
  `        if (building.type === 'missile_silo') {
          hasMissileSilo = true;
          missileSiloId = building.id;
        }`,
  `        if (building.type === 'missile_silo') {
          hasMissileSilo = true;
          missileSiloId = building.id;
          missileSiloCount++;
        }`
);

// ============================================================
// 5. Power plant cap: 6 → 20
// ============================================================
apply(
  'Power plant cap 6→20',
  `} else if (powerPlantCount < 6 && player.resources >= 150 && Math.random() < 0.7) {`,
  `} else if (powerPlantCount < 20 && player.resources >= 150 && Math.random() < 0.7) {`
);

// ============================================================
// 6. Missile silo: !hasMissileSilo → missileSiloCount < 5
// ============================================================
apply(
  'Missile silo cap 1→5',
  `} else if (!hasMissileSilo && player.resources >= MISSILE_SILO_COST) {`,
  `} else if (missileSiloCount < 5 && player.resources >= MISSILE_SILO_COST) {`
);

// ============================================================
// 7. Defense tower cap: 8 → 10
// ============================================================
apply(
  'Defense tower cap 8→10',
  `} else if (defenseCount < 8 && player.resources >= 250) {`,
  `} else if (defenseCount < 10 && player.resources >= 250) {`
);

// ============================================================
// 8. Add carbase to AI build list (after silo, before extras)
// ============================================================
apply(
  'Add carbase to AI build list',
  `        } else if (player.resources >= 200) {
          const extras = ['power_plant', 'defense_tower', 'shipyard', 'naval_academy'];`,
  `        } else if (carbaseCount < 1 && missileSiloCount >= 2 && player.resources >= CARBASE_BUILD_COST) {
          buildType = 'carbase'; buildCost = CARBASE_BUILD_COST;
        } else if (player.resources >= 200) {
          const extras = ['power_plant', 'defense_tower', 'shipyard', 'naval_academy'];`
);

// ============================================================
// 9. Worker limit: 15 → 1
// ============================================================
apply(
  'Worker limit 15→1',
  `    if (aiWorkers.length < 15 && headquartersId && player.resources >= 50 && player.population < player.maxPopulation) {`,
  `    if (aiWorkers.length < 1 && headquartersId && player.resources >= 50 && player.population < player.maxPopulation) {`
);

// ============================================================
// 10. AI tactical additions (carbase production, deploy, lure, mines)
//     Insert just before "// Always update targetCombatPower dynamically"
// ============================================================
const aiTacticsCode = `
    // --- AI CARBASE: Produce missile launchers ---
    if (carbaseCount > 0) {
      gameState.buildings.forEach(b => {
        if (b.userId !== playerId || b.type !== 'carbase' || b.buildProgress < 100) return;
        if (player.population + 1 > player.maxPopulation) return;
        if (player.resources >= MISSILE_LAUNCHER_COST) {
          buildUnitForAI(playerId, b.id, 'missile_launcher');
        }
      });
    }

    // --- AI MISSILE LAUNCHER: Move mobile launchers to defensive positions, then deploy ---
    const aiMobileLaunchers = aiCombatUnits.filter(u => u.type === 'missile_launcher' && (!u.deployState || u.deployState === 'mobile'));
    aiMobileLaunchers.forEach(launcher => {
      if (!launcher.deployState) launcher.deployState = 'mobile';
      if (!launcher.targetX) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 350 + Math.random() * 400;
        const deployX = player.baseX + Math.cos(angle) * dist;
        const deployY = player.baseY + Math.sin(angle) * dist;
        if (isOnLand(deployX, deployY)) {
          launcher.targetX = deployX;
          launcher.targetY = deployY;
        }
      }
    });
    // Deploy launchers that have arrived (no targetX = at position)
    aiCombatUnits.filter(u =>
      u.type === 'missile_launcher' && u.deployState === 'mobile' && !u.targetX
    ).forEach(launcher => {
      launcher.deployState = 'deploying_stage1';
      launcher.deployStateEndsAt = now + MISSILE_LAUNCHER_DEPLOY_STAGE_MS;
    });

    // --- AI LURE TACTIC: Send a frigate toward enemy, draw them into launcher/aegis kill zone ---
    if (!player.lureCooldownUntil) player.lureCooldownUntil = 0;
    const deployedLaunchers = aiCombatUnits.filter(u => u.type === 'missile_launcher' && u.deployState === 'deployed');
    const hasAegisBs = aiBattleships.some(bs => bs.battleshipAegisMode);
    if (
      now > player.lureCooldownUntil &&
      deployedLaunchers.length >= 2 &&
      hasAegisBs &&
      player.knownEnemyPositions &&
      player.knownEnemyPositions.length > 0
    ) {
      const lureUnit = aiCombatUnits.find(u => u.type === 'frigate' && !u.attackTargetId && !u.isLuring);
      if (lureUnit) {
        const enemyPos = player.knownEnemyPositions[Math.floor(Math.random() * player.knownEnemyPositions.length)];
        const dx = enemyPos.x - player.baseX;
        const dy = enemyPos.y - player.baseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const midX = player.baseX + (dx / dist) * Math.min(dist * 0.4, 1500);
        const midY = player.baseY + (dy / dist) * Math.min(dist * 0.4, 1500);
        assignMoveTarget(lureUnit, midX, midY);
        lureUnit.isLuring = true;
        lureUnit.lureReturnAt = now + 15000;
        player.lureCooldownUntil = now + 45000;
      }
    }
    // Recall luring frigates after lure window
    aiCombatUnits.filter(u => u.isLuring && now >= (u.lureReturnAt || 0)).forEach(u => {
      assignMoveTarget(u, player.baseX, player.baseY);
      u.isLuring = false;
    });

    // --- AI MINE LAYING: Lay mines on enemy approach path to AI base ---
    if (!player.mineLayCooldownUntil) player.mineLayCooldownUntil = 0;
    if (now > player.mineLayCooldownUntil && player.knownEnemyPositions && player.knownEnemyPositions.length > 0) {
      const mineDestroyers = aiCombatUnits.filter(u => u.type === 'destroyer');
      if (mineDestroyers.length > 0) {
        const destroyer = mineDestroyers[0];
        let activeMines = 0;
        gameState.units.forEach(u => {
          if (u.type === 'mine' && u.userId === playerId && u.hp > 0) activeMines++;
        });
        if (activeMines < DESTROYER_MAX_MINES) {
          const enemyPos = player.knownEnemyPositions[0];
          const dx = enemyPos.x - player.baseX;
          const dy = enemyPos.y - player.baseY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 0) {
            const approachX = player.baseX + (dx / dist) * Math.min(dist * 0.3, 1000);
            const approachY = player.baseY + (dy / dist) * Math.min(dist * 0.3, 1000);
            if (!isOnLand(approachX, approachY)) {
              const mineId = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 700;
              const mineDef = getUnitDefinition('mine');
              const mine = {
                id: mineId,
                userId: playerId,
                type: 'mine',
                x: approachX + (Math.random() - 0.5) * 200,
                y: approachY + (Math.random() - 0.5) * 200,
                hp: mineDef.hp,
                maxHp: mineDef.hp,
                damage: mineDef.damage,
                speed: 0,
                size: mineDef.size,
                attackRange: mineDef.attackRange,
                attackCooldownMs: mineDef.attackCooldownMs,
                visionRadius: 0,
                targetX: null,
                targetY: null,
                isDetected: false,
                sourceDestroyerId: destroyer.id,
                kills: 0
              };
              gameState.units.set(mine.id, mine);
              emitUnitCreatedEvent(mine);
              player.mineLayCooldownUntil = now + 30000;
            }
          }
        }
      }
    }

`;

apply(
  'Insert AI tactical code block',
  '    // Always update targetCombatPower dynamically',
  aiTacticsCode + '    // Always update targetCombatPower dynamically'
);

// ============================================================
// 11. AI SLBM: record enemy strength when discovering, target strongest
// ============================================================
// Tag discovered enemy building positions with local strength
apply(
  'SLBM: tag discovered positions with local strength',
  `if (!existing) {
                  player.knownEnemyPositions.push({ x: building.x, y: building.y, playerId: otherId, discoveredAt: now });`,
  `if (!existing) {
                  let localStrength = 0;
                  gameState.units.forEach(eu => {
                    if (eu.userId === otherId) {
                      const ddx = eu.x - building.x; const ddy = eu.y - building.y;
                      if (ddx * ddx + ddy * ddy < 800 * 800) localStrength++;
                    }
                  });
                  player.knownEnemyPositions.push({ x: building.x, y: building.y, playerId: otherId, discoveredAt: now, lastSeenStrength: localStrength });`
);

// When firing SLBM, pick strongest known position instead of random
apply(
  'SLBM: target strongest enemy position',
  `        const target = player.knownEnemyPositions[Math.floor(Math.random() * player.knownEnemyPositions.length)];`,
  `        // Target the strongest known enemy position (most units seen nearby)
        const sortedTargets = player.knownEnemyPositions.slice().sort((a, b) => (b.lastSeenStrength || 0) - (a.lastSeenStrength || 0));
        const target = sortedTargets[0] || player.knownEnemyPositions[0];`
);

// ============================================================
// 12. rollNewRedZones: dynamic interval + guarantee player island
// ============================================================
apply(
  'Red zone: dynamic interval in rollNewRedZones',
  `function rollNewRedZones(now) {
  const islands = getIslandCenters();
  gameState.nextRedZoneRollAt = now + RED_ZONE_SELECTION_INTERVAL_MS;`,
  `function rollNewRedZones(now) {
  const islands = getIslandCenters();
  // Dynamic interval: more entities alive → faster red zone cycles (min 60s, default 600s)
  const totalEntities = gameState.buildings.size + gameState.units.size;
  const dynamicInterval = Math.max(60000, RED_ZONE_SELECTION_INTERVAL_MS - Math.floor(totalEntities / 10) * 30000);
  gameState.nextRedZoneRollAt = now + dynamicInterval;`
);

// Guarantee at least 1 human player island in the red zone selection
apply(
  'Red zone: guarantee player island',
  `  const shuffled = islands.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[swapIndex];
    shuffled[swapIndex] = temp;
  }

  const selected = shuffled.slice(0, Math.min(RED_ZONE_ISLAND_COUNT, shuffled.length));`,
  `  const shuffled = islands.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[swapIndex];
    shuffled[swapIndex] = temp;
  }

  // Find islands occupied by human (non-AI) players
  const humanIslandIds = new Set();
  gameState.buildings.forEach(b => {
    const p = gameState.players.get(b.userId);
    if (!p || p.isAI) return;
    let bestDist = Infinity;
    let bestIsland = null;
    islands.forEach(isl => {
      const dx = b.x - isl.x; const dy = b.y - isl.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; bestIsland = isl; }
    });
    if (bestIsland && bestDist < 2500 * 2500) humanIslandIds.add(bestIsland.id);
  });

  let selected;
  const humanIslands = shuffled.filter(i => humanIslandIds.has(i.id));
  const otherIslands = shuffled.filter(i => !humanIslandIds.has(i.id));
  if (humanIslands.length > 0) {
    // Force at least 1 random human island, fill remaining slots from the rest
    const forced = humanIslands[Math.floor(Math.random() * humanIslands.length)];
    const rest = [...humanIslands.filter(x => x !== forced), ...otherIslands];
    selected = [forced, ...rest].slice(0, Math.min(RED_ZONE_ISLAND_COUNT, islands.length));
  } else {
    selected = shuffled.slice(0, Math.min(RED_ZONE_ISLAND_COUNT, shuffled.length));
  }`
);

// ============================================================
// Write patched file
// ============================================================
fs.writeFileSync(serverPath, code, 'utf8');
console.log(`\nPatch complete: ${patchCount} of 14 patches applied.`);
