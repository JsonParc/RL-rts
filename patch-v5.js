// Patch v5: Formation overhaul
// 1. Assaultship/submarine always rear
// 2. Flank max 3 per row per side
// 3. Diamond formation
// 4. UI formation selector
// 5. formationType on squad object + socket
const fs = require('fs');
const path = require('path');

function patchFile(filePath, patches) {
  let raw = fs.readFileSync(filePath, 'utf8');
  const useCRLF = raw.includes('\r\n');
  let code = raw.replace(/\r\n/g, '\n');
  for (const { label, oldStr, newStr } of patches) {
    const oldLF = oldStr.replace(/\r\n/g, '\n');
    const newLF = newStr.replace(/\r\n/g, '\n');
    const idx = code.indexOf(oldLF);
    if (idx === -1) {
      console.error(`[FAIL] ${path.basename(filePath)}: ${label}`);
      console.error(`Looking for (first 150): ${oldLF.substring(0, 150)}`);
      process.exit(1);
    }
    const idx2 = code.indexOf(oldLF, idx + 1);
    if (idx2 !== -1) {
      console.error(`[FAIL] Multiple matches: ${label}`);
      process.exit(1);
    }
    code = code.substring(0, idx) + newLF + code.substring(idx + oldLF.length);
    console.log(`[OK] ${path.basename(filePath)}: ${label}`);
  }
  if (useCRLF) code = code.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, code, 'utf8');
}

// ============================================================
// SERVER.JS PATCHES
// ============================================================
const serverPatches = [];

// PATCH 1: Replace getSquadFormationPositions with new version supporting:
//   - formationType param ('trapezoid' or 'diamond')
//   - assaultship/submarine forced to rear
//   - flank max 3 per row per side
serverPatches.push({
  label: 'replace getSquadFormationPositions with dual-mode formation',
  oldStr: `function getSquadFormationPositions(units, targetX, targetY, moveAngle) {
  const sorted = [...units].sort((a, b) => (a.attackRange || 0) - (b.attackRange || 0));
  const count = sorted.length;
  if (count === 0) return [];

  const forwardX = Math.cos(moveAngle);
  const forwardY = Math.sin(moveAngle);
  const sideX = -forwardY;
  const sideY = forwardX;
  const FORMATION_GAP = 30;
  const MAX_PER_ROW = 7;
  const positions = [];

  // Group consecutive units with similar range (within 200) into range tiers
  const rangeGroups = [];
  for (const u of sorted) {
    const r = u.attackRange || 0;
    if (rangeGroups.length === 0) {
      rangeGroups.push([u]);
    } else {
      const lastG = rangeGroups[rangeGroups.length - 1];
      const lastR = lastG[lastG.length - 1].attackRange || 0;
      if (Math.abs(r - lastR) > 200) rangeGroups.push([u]);
      else lastG.push(u);
    }
  }

  // Classify range groups into front / flank / rear tiers
  let frontUnits = [], flankUnits = [], rearUnits = [];
  const N = rangeGroups.length;
  if (N <= 1) {
    frontUnits = sorted.slice();
  } else if (N === 2) {
    frontUnits = rangeGroups[0].slice();
    rearUnits = rangeGroups[1].slice();
  } else {
    // 3+ range tiers: use index-based split
    // ~43% front, ~35% rear, rest flank (ensures short=front, long=rear, mid=flanks)
    let fc = Math.max(1, Math.round(N * 0.43));
    let rc = Math.max(1, Math.round(N * 0.35));
    if (fc + rc >= N) { fc = Math.floor(N / 3); rc = Math.floor(N / 3); }
    if (fc + rc >= N) { fc = 1; rc = 1; }
    for (let i = 0; i < N; i++) {
      if (i < fc) frontUnits.push(...rangeGroups[i]);
      else if (i >= N - rc) rearUnits.push(...rangeGroups[i]);
      else flankUnits.push(...rangeGroups[i]);
    }
  }

  // Split array into sub-rows of max MAX_PER_ROW, preserving range grouping
  function makeRows(arr) {
    if (arr.length === 0) return [];
    const s = [...arr].sort((a, b) => (a.attackRange || 0) - (b.attackRange || 0));
    const groups = [];
    for (const u of s) {
      const r = u.attackRange || 0;
      if (groups.length === 0) { groups.push([u]); continue; }
      const lg = groups[groups.length - 1];
      if (Math.abs(r - (lg[lg.length - 1].attackRange || 0)) > 200) groups.push([u]);
      else lg.push(u);
    }
    const result = [];
    for (const g of groups) {
      for (let i = 0; i < g.length; i += MAX_PER_ROW) result.push(g.slice(i, i + MAX_PER_ROW));
    }
    return result;
  }

  function getRowWidth(row) {
    const widths = row.map(u => getUnitFormationSize(u).shortAxis * 2);
    return widths.reduce((s, w) => s + w, 0) + FORMATION_GAP * Math.max(0, row.length - 1);
  }
  function getRowDepth(row) {
    return row.reduce((m, u) => Math.max(m, getUnitFormationSize(u).longAxis * 2), 40);
  }

  // Place a horizontal row centered at (lateralOffset, forwardOffset)
  function placeRow(rowUnits, fwdOff, latOff) {
    const widths = rowUnits.map(u => getUnitFormationSize(u).shortAxis * 2);
    const total = widths.reduce((s, w) => s + w, 0) + FORMATION_GAP * Math.max(0, rowUnits.length - 1);
    let cursor = latOff - total / 2;
    rowUnits.forEach((u, i) => {
      const hW = widths[i] / 2;
      const lat = cursor + hW;
      positions.push({
        unit: u,
        x: targetX + sideX * lat + forwardX * fwdOff,
        y: targetY + sideY * lat + forwardY * fwdOff
      });
      cursor += widths[i] + FORMATION_GAP;
    });
  }

  // Build rows for front and rear
  const frontRows = makeRows(frontUnits);
  const rearRows = makeRows(rearUnits);
  const frontDepths = frontRows.map(r => getRowDepth(r));
  const rearDepths = rearRows.map(r => getRowDepth(r));

  // Max center column width (for flank offset)
  let centerMaxWidth = 0;
  frontRows.forEach(r => { centerMaxWidth = Math.max(centerMaxWidth, getRowWidth(r)); });
  rearRows.forEach(r => { centerMaxWidth = Math.max(centerMaxWidth, getRowWidth(r)); });

  // Place front rows: shortest range at most-positive fwd (furthest forward)
  // frontRows sorted ascending, so iterate in REVERSE to put shortest first
  let fOff = FORMATION_GAP / 2;
  for (let i = frontRows.length - 1; i >= 0; i--) {
    fOff += frontDepths[i] / 2;
    placeRow(frontRows[i], fOff, 0);
    fOff += frontDepths[i] / 2 + FORMATION_GAP;
  }

  // Place rear rows: longest range at most-negative fwd (furthest back)
  // rearRows sorted ascending, so iterate forward (index 0 = shortest in rear, closest to center)
  let rOff = -FORMATION_GAP / 2;
  for (let i = 0; i < rearRows.length; i++) {
    rOff -= rearDepths[i] / 2;
    placeRow(rearRows[i], rOff, 0);
    rOff -= rearDepths[i] / 2 + FORMATION_GAP;
  }

  // Place flank units: split left/right as horizontal rows on each side
  if (flankUnits.length > 0) {
    const leftFlank = [];
    const rightFlank = [];
    for (let i = 0; i < flankUnits.length; i++) {
      if (i % 2 === 0) leftFlank.push(flankUnits[i]);
      else rightFlank.push(flankUnits[i]);
    }

    function placeFlankSide(sideUnits, sign) {
      if (sideUnits.length === 0) return;
      const rows = [];
      for (let i = 0; i < sideUnits.length; i += MAX_PER_ROW) {
        rows.push(sideUnits.slice(i, i + MAX_PER_ROW));
      }
      let maxW = 0;
      rows.forEach(r => { maxW = Math.max(maxW, getRowWidth(r)); });
      const latCenter = sign * (centerMaxWidth / 2 + FORMATION_GAP + maxW / 2);
      const depths = rows.map(r => getRowDepth(r));
      const totalD = depths.reduce((s, d) => s + d, 0) + FORMATION_GAP * Math.max(0, rows.length - 1);
      let vOff = totalD / 2;
      for (let i = 0; i < rows.length; i++) {
        vOff -= depths[i] / 2;
        placeRow(rows[i], vOff, latCenter);
        vOff -= depths[i] / 2 + FORMATION_GAP;
      }
    }

    placeFlankSide(leftFlank, -1);
    placeFlankSide(rightFlank, 1);
  }

  return positions;
}`,
  newStr: `function getSquadFormationPositions(units, targetX, targetY, moveAngle, formationType) {
  if (!formationType) formationType = 'trapezoid';
  const sorted = [...units].sort((a, b) => (a.attackRange || 0) - (b.attackRange || 0));
  const count = sorted.length;
  if (count === 0) return [];

  const forwardX = Math.cos(moveAngle);
  const forwardY = Math.sin(moveAngle);
  const sideX = -forwardY;
  const sideY = forwardX;
  const FORMATION_GAP = 30;
  const MAX_PER_ROW = 7;
  const FLANK_MAX_PER_ROW = 3;
  const positions = [];

  // Non-combat types always go to rear regardless of range
  const NON_COMBAT_TYPES = new Set(['assaultship', 'submarine']);

  // Helpers
  function getRowWidth(row) {
    const widths = row.map(u => getUnitFormationSize(u).shortAxis * 2);
    return widths.reduce((s, w) => s + w, 0) + FORMATION_GAP * Math.max(0, row.length - 1);
  }
  function getRowDepth(row) {
    return row.reduce((m, u) => Math.max(m, getUnitFormationSize(u).longAxis * 2), 40);
  }
  function placeRow(rowUnits, fwdOff, latOff) {
    const widths = rowUnits.map(u => getUnitFormationSize(u).shortAxis * 2);
    const total = widths.reduce((s, w) => s + w, 0) + FORMATION_GAP * Math.max(0, rowUnits.length - 1);
    let cursor = latOff - total / 2;
    rowUnits.forEach((u, i) => {
      const hW = widths[i] / 2;
      const lat = cursor + hW;
      positions.push({
        unit: u,
        x: targetX + sideX * lat + forwardX * fwdOff,
        y: targetY + sideY * lat + forwardY * fwdOff
      });
      cursor += widths[i] + FORMATION_GAP;
    });
  }
  function makeRows(arr, maxPerRow) {
    if (arr.length === 0) return [];
    const s = [...arr].sort((a, b) => (a.attackRange || 0) - (b.attackRange || 0));
    const groups = [];
    for (const u of s) {
      const r = u.attackRange || 0;
      if (groups.length === 0) { groups.push([u]); continue; }
      const lg = groups[groups.length - 1];
      if (Math.abs(r - (lg[lg.length - 1].attackRange || 0)) > 200) groups.push([u]);
      else lg.push(u);
    }
    const result = [];
    for (const g of groups) {
      for (let i = 0; i < g.length; i += maxPerRow) result.push(g.slice(i, i + maxPerRow));
    }
    return result;
  }

  if (formationType === 'diamond') {
    return buildDiamondFormation(sorted, targetX, targetY, forwardX, forwardY, sideX, sideY, FORMATION_GAP, positions, NON_COMBAT_TYPES);
  }

  // ===== TRAPEZOID FORMATION =====
  // Separate non-combat units to forced rear
  const combatUnits = [];
  const forcedRearUnits = [];
  for (const u of sorted) {
    if (NON_COMBAT_TYPES.has(u.type)) forcedRearUnits.push(u);
    else combatUnits.push(u);
  }

  // Group combat units by range
  const rangeGroups = [];
  for (const u of combatUnits) {
    const r = u.attackRange || 0;
    if (rangeGroups.length === 0) {
      rangeGroups.push([u]);
    } else {
      const lastG = rangeGroups[rangeGroups.length - 1];
      const lastR = lastG[lastG.length - 1].attackRange || 0;
      if (Math.abs(r - lastR) > 200) rangeGroups.push([u]);
      else lastG.push(u);
    }
  }

  // Classify into front / flank / rear tiers
  let frontUnits = [], flankUnits = [], rearUnits = [];
  const N = rangeGroups.length;
  if (N <= 1) {
    frontUnits = combatUnits.slice();
  } else if (N === 2) {
    frontUnits = rangeGroups[0].slice();
    rearUnits = rangeGroups[1].slice();
  } else {
    let fc = Math.max(1, Math.round(N * 0.43));
    let rc = Math.max(1, Math.round(N * 0.35));
    if (fc + rc >= N) { fc = Math.floor(N / 3); rc = Math.floor(N / 3); }
    if (fc + rc >= N) { fc = 1; rc = 1; }
    for (let i = 0; i < N; i++) {
      if (i < fc) frontUnits.push(...rangeGroups[i]);
      else if (i >= N - rc) rearUnits.push(...rangeGroups[i]);
      else flankUnits.push(...rangeGroups[i]);
    }
  }
  // Forced rear units go behind combat rear
  rearUnits.push(...forcedRearUnits);

  const frontRows = makeRows(frontUnits, MAX_PER_ROW);
  const rearRows = makeRows(rearUnits, MAX_PER_ROW);
  const frontDepths = frontRows.map(r => getRowDepth(r));
  const rearDepths = rearRows.map(r => getRowDepth(r));

  let centerMaxWidth = 0;
  frontRows.forEach(r => { centerMaxWidth = Math.max(centerMaxWidth, getRowWidth(r)); });
  rearRows.forEach(r => { centerMaxWidth = Math.max(centerMaxWidth, getRowWidth(r)); });

  // Place front rows (shortest range most forward)
  let fOff = FORMATION_GAP / 2;
  for (let i = frontRows.length - 1; i >= 0; i--) {
    fOff += frontDepths[i] / 2;
    placeRow(frontRows[i], fOff, 0);
    fOff += frontDepths[i] / 2 + FORMATION_GAP;
  }

  // Place rear rows (longest range most backward)
  let rOff = -FORMATION_GAP / 2;
  for (let i = 0; i < rearRows.length; i++) {
    rOff -= rearDepths[i] / 2;
    placeRow(rearRows[i], rOff, 0);
    rOff -= rearDepths[i] / 2 + FORMATION_GAP;
  }

  // Flank units: max FLANK_MAX_PER_ROW per row per side
  if (flankUnits.length > 0) {
    const half = Math.ceil(flankUnits.length / 2);
    const leftFlank = flankUnits.slice(0, half);
    const rightFlank = flankUnits.slice(half);

    function placeFlankSide(sideUnits, sign) {
      if (sideUnits.length === 0) return;
      const rows = [];
      for (let i = 0; i < sideUnits.length; i += FLANK_MAX_PER_ROW) {
        rows.push(sideUnits.slice(i, i + FLANK_MAX_PER_ROW));
      }
      let maxW = 0;
      rows.forEach(r => { maxW = Math.max(maxW, getRowWidth(r)); });
      const latCenter = sign * (centerMaxWidth / 2 + FORMATION_GAP + maxW / 2);
      const depths = rows.map(r => getRowDepth(r));
      const totalD = depths.reduce((s, d) => s + d, 0) + FORMATION_GAP * Math.max(0, rows.length - 1);
      let vOff = totalD / 2;
      for (let i = 0; i < rows.length; i++) {
        vOff -= depths[i] / 2;
        placeRow(rows[i], vOff, latCenter);
        vOff -= depths[i] / 2 + FORMATION_GAP;
      }
    }
    placeFlankSide(leftFlank, -1);
    placeFlankSide(rightFlank, 1);
  }

  return positions;
}

// ===== DIAMOND (마름모) FORMATION =====
// Short range on outer edges, long range in center. Non-combat forced to rear center.
function buildDiamondFormation(sorted, targetX, targetY, forwardX, forwardY, sideX, sideY, GAP, positions, NON_COMBAT_TYPES) {
  // Separate non-combat
  const combatUnits = [];
  const nonCombatUnits = [];
  for (const u of sorted) {
    if (NON_COMBAT_TYPES.has(u.type)) nonCombatUnits.push(u);
    else combatUnits.push(u);
  }

  // Sort combat by range descending (longest range = center, shortest = outer)
  const byRangeDesc = [...combatUnits].sort((a, b) => (b.attackRange || 0) - (a.attackRange || 0));

  // Build diamond rings: ring 0 = center (longest range), ring 1,2,... = outward (shorter)
  // Ring 0: 1 unit, Ring 1: up to 4, Ring 2: up to 8, Ring k: up to 4k
  const rings = [];
  let placed = 0;
  let ringIdx = 0;
  while (placed < byRangeDesc.length) {
    const capacity = ringIdx === 0 ? 1 : 4 * ringIdx;
    const ringUnits = byRangeDesc.slice(placed, placed + capacity);
    rings.push(ringUnits);
    placed += ringUnits.length;
    ringIdx++;
  }

  // Place each ring in diamond pattern
  const avgSize = combatUnits.length > 0 ?
    combatUnits.reduce((s, u) => s + getUnitFormationSize(u).shortAxis * 2, 0) / combatUnits.length : 40;
  const ringSpacing = avgSize + GAP;

  for (let r = 0; r < rings.length; r++) {
    const ringUnits = rings[r];
    if (r === 0) {
      // Center unit
      positions.push({
        unit: ringUnits[0],
        x: targetX,
        y: targetY
      });
    } else {
      // Distribute units around diamond perimeter at distance r * ringSpacing
      const dist = r * ringSpacing;
      const n = ringUnits.length;
      // Diamond vertices: front, right, back, left
      // Distribute evenly around diamond perimeter
      for (let i = 0; i < n; i++) {
        const t = i / n; // 0 to 1 around diamond
        let px, py;
        // Diamond parameterization: 4 edges
        if (t < 0.25) {
          // front to right
          const s = t / 0.25;
          px = dist * s;       // lateral
          py = dist * (1 - s); // forward
        } else if (t < 0.5) {
          // right to back
          const s = (t - 0.25) / 0.25;
          px = dist * (1 - s);
          py = -dist * s;
        } else if (t < 0.75) {
          // back to left
          const s = (t - 0.5) / 0.25;
          px = -dist * s;
          py = -dist * (1 - s);
        } else {
          // left to front
          const s = (t - 0.75) / 0.25;
          px = -dist * (1 - s);
          py = dist * s;
        }
        positions.push({
          unit: ringUnits[i],
          x: targetX + sideX * px + forwardX * py,
          y: targetY + sideY * px + forwardY * py
        });
      }
    }
  }

  // Place non-combat units behind diamond center
  if (nonCombatUnits.length > 0) {
    const maxRing = rings.length;
    const rearDist = maxRing * ringSpacing + GAP;
    const ncWidth = nonCombatUnits.reduce((s, u) => s + getUnitFormationSize(u).shortAxis * 2, 0) +
                    GAP * Math.max(0, nonCombatUnits.length - 1);
    let cursor = -ncWidth / 2;
    for (const u of nonCombatUnits) {
      const w = getUnitFormationSize(u).shortAxis * 2;
      const lat = cursor + w / 2;
      positions.push({
        unit: u,
        x: targetX + sideX * lat - forwardX * rearDist,
        y: targetY + sideY * lat - forwardY * rearDist
      });
      cursor += w + GAP;
    }
  }

  return positions;
}`
});

// PATCH 2: Pass formationType to getSquadFormationPositions in issueSquadMoveOrder
serverPatches.push({
  label: 'pass formationType in issueSquadMoveOrder',
  oldStr: `function issueSquadMoveOrder(squad, targetX, targetY) {
  const units = getSquadAliveUnits(squad);`,
  newStr: `function issueSquadMoveOrder(squad, targetX, targetY) {
  const formationType = squad.formationType || 'trapezoid';
  const units = getSquadAliveUnits(squad);`
});

// PATCH 3: Use formationType in issueSquadMoveOrder's call to getSquadFormationPositions
serverPatches.push({
  label: 'use formationType in issueSquadMoveOrder getSquadFormationPositions call',
  oldStr: `  const positions = getSquadFormationPositions(units, targetX, targetY, moveAngle);

  positions.forEach(({ unit, x, y }) => {
    unit.squadOffsetX = x - targetX;
    unit.squadOffsetY = y - targetY;
    unit.speed = slowestSpeed;
    unit.holdPosition = false;`,
  newStr: `  const positions = getSquadFormationPositions(units, targetX, targetY, moveAngle, formationType);

  positions.forEach(({ unit, x, y }) => {
    unit.squadOffsetX = x - targetX;
    unit.squadOffsetY = y - targetY;
    unit.speed = slowestSpeed;
    unit.holdPosition = false;`
});

// PATCH 4: Use formationType in issueSquadAttackMove
serverPatches.push({
  label: 'pass formationType in issueSquadAttackMove',
  oldStr: `function issueSquadAttackMove(squad, targetX, targetY) {
  const units = getSquadAliveUnits(squad);`,
  newStr: `function issueSquadAttackMove(squad, targetX, targetY) {
  const formationType = squad.formationType || 'trapezoid';
  const units = getSquadAliveUnits(squad);`
});

// Find and patch the getSquadFormationPositions call inside issueSquadAttackMove
serverPatches.push({
  label: 'use formationType in issueSquadAttackMove getSquadFormationPositions call',
  oldStr: `  squad.centerWaypoints = null;
  }

  const positions = getSquadFormationPositions(units, targetX, targetY, moveAngle);

  positions.forEach(({ unit, x, y }) => {
    unit.squadOffsetX = x - targetX;
    unit.squadOffsetY = y - targetY;
    unit.speed = slowestSpeed;
    unit.holdPosition = false;
    unit.attackMove = true;`,
  newStr: `  squad.centerWaypoints = null;
  }

  const positions = getSquadFormationPositions(units, targetX, targetY, moveAngle, formationType);

  positions.forEach(({ unit, x, y }) => {
    unit.squadOffsetX = x - targetX;
    unit.squadOffsetY = y - targetY;
    unit.speed = slowestSpeed;
    unit.holdPosition = false;
    unit.attackMove = true;`
});

// PATCH 5: In createSquad handler, pass formationType to getSquadFormationPositions
// Also set squad.formationType = 'trapezoid' (default)
serverPatches.push({
  label: 'set formationType on squad creation',
  oldStr: `    const squad = { unitIds: validUnits, ownerId: socket.userId };
    gameState.squads.set(squadId, squad);`,
  newStr: `    const squad = { unitIds: validUnits, ownerId: socket.userId, formationType: 'trapezoid' };
    gameState.squads.set(squadId, squad);`
});

serverPatches.push({
  label: 'pass formationType in createSquad getSquadFormationPositions call',
  oldStr: `      const fPositions = getSquadFormationPositions(aliveUnits, cx, cy, avgAngle);`,
  newStr: `      const fPositions = getSquadFormationPositions(aliveUnits, cx, cy, avgAngle, squad.formationType);`
});

// PATCH 6: Include formationType in squadCreated event so client knows
serverPatches.push({
  label: 'emit formationType in squadCreated',
  oldStr: `    socket.emit('squadCreated', { squadId, unitIds: validUnits });`,
  newStr: `    socket.emit('squadCreated', { squadId, unitIds: validUnits, formationType: squad.formationType });`
});

// PATCH 7: Add socket handler for 'setFormationType'
serverPatches.push({
  label: 'add setFormationType socket handler',
  oldStr: `  socket.on('disbandSquad', (data) => {`,
  newStr: `  socket.on('setFormationType', (data) => {
    switchRoom(socket.roomId);
    const squadId = data?.squadId;
    const type = data?.formationType;
    if (!squadId || !type || !['trapezoid', 'diamond'].includes(type)) return;
    const squad = gameState.squads.get(squadId);
    if (!squad || squad.ownerId !== socket.userId) return;
    squad.formationType = type;
    // Re-form: recalculate positions
    const units = getSquadAliveUnits(squad);
    if (units.length > 0) {
      const cx = units.reduce((s, u) => s + u.x, 0) / units.length;
      const cy = units.reduce((s, u) => s + u.y, 0) / units.length;
      const positions = getSquadFormationPositions(units, squad.targetX || cx, squad.targetY || cy, squad.moveAngle || 0, type);
      const slowestSpeed = getSquadSlowestSpeed(squad);
      const formingUpUntil = Date.now() + 3000;
      positions.forEach(({ unit, x, y }) => {
        unit.squadOffsetX = x - (squad.centerX || cx);
        unit.squadOffsetY = y - (squad.centerY || cy);
        unit.speed = slowestSpeed;
        unit.formingUp = true;
        unit.formingUpUntil = formingUpUntil;
        assignMoveTarget(unit, x, y);
      });
    }
    socket.emit('formationTypeChanged', { squadId, formationType: type });
  });

  socket.on('disbandSquad', (data) => {`
});

// PATCH 8: Include formationType in squad data sent to client during per-tick update
// Find buildClientUnitsPayload to also include formationType from squad
// Actually the squad info is separate - let's check if formationType is sent in tick
// We need to include it in the unit payload so client knows
serverPatches.push({
  label: 'include formationType in unit payload',
  oldStr: `      squadId: unit.squadId ?? null
    });`,
  newStr: `      squadId: unit.squadId ?? null,
      formationType: unit.squadId ? (gameState.squads.get(unit.squadId)?.formationType || 'trapezoid') : null
    });`
});

patchFile(path.join(__dirname, 'server.js'), serverPatches);

// ============================================================
// GAME.JS PATCHES (CLIENT)
// ============================================================
const gamePatches = [];

// PATCH 1: In squadCreated handler, store formationType
gamePatches.push({
  label: 'store formationType on squadCreated',
  oldStr: `        socket.on('squadCreated', (data) => {
        console.log('[Squad] squadCreated received:', data);
        if (data && data.squadId && Array.isArray(data.unitIds)) {
            gameState.squads.set(data.squadId, { unitIds: data.unitIds });`,
  newStr: `        socket.on('squadCreated', (data) => {
        console.log('[Squad] squadCreated received:', data);
        if (data && data.squadId && Array.isArray(data.unitIds)) {
            gameState.squads.set(data.squadId, { unitIds: data.unitIds, formationType: data.formationType || 'trapezoid' });`
});

// PATCH 2: Add formationTypeChanged handler
gamePatches.push({
  label: 'add formationTypeChanged handler',
  oldStr: `    socket.on('squadDisbanded', (data) => {`,
  newStr: `    socket.on('formationTypeChanged', (data) => {
        if (data && data.squadId && data.formationType) {
            const squad = gameState.squads.get(data.squadId);
            if (squad) squad.formationType = data.formationType;
            updateSelectionInfo();
        }
    });

    socket.on('squadDisbanded', (data) => {`
});

// PATCH 3: Add formation selector UI in updateSelectionInfo
// Find the squad button area and add formation type selector after it
gamePatches.push({
  label: 'add formation selector UI in squad button area',
  oldStr: `    if (allInSameSquad) {
        html += \`<button type="button" class="squad-btn squad-disband" data-squad="disband">부대지정 해제</button>\`;
    } else {
        html += \`<button type="button" class="squad-btn" data-squad="create">부대지정</button>\`;
        if (ownUnits.some(u => u.squadId)) {
            html += \`<button type="button" class="squad-btn squad-disband" data-squad="disband">부대지정 해제</button>\`;
        }
    }
    html += \`</div>\`;`,
  newStr: `    if (allInSameSquad) {
        html += \`<button type="button" class="squad-btn squad-disband" data-squad="disband">부대지정 해제</button>\`;
    } else {
        html += \`<button type="button" class="squad-btn" data-squad="create">부대지정</button>\`;
        if (ownUnits.some(u => u.squadId)) {
            html += \`<button type="button" class="squad-btn squad-disband" data-squad="disband">부대지정 해제</button>\`;
        }
    }
    html += \`</div>\`;
    // Formation type selector (only when all in same squad)
    if (allInSameSquad) {
        const theSquadId = [...squadIdsSet][0];
        const squadData = gameState.squads.get(theSquadId);
        const curType = squadData?.formationType || (ownUnits[0]?.formationType) || 'trapezoid';
        html += \`<div style="margin-top:6px;display:flex;gap:6px;align-items:center;">
          <span style="color:#8f99a3;font-size:11px;">대열:</span>
          <button type="button" class="formation-type-btn\${curType === 'trapezoid' ? ' active' : ''}" data-formation="trapezoid" data-squad-id="\${theSquadId}" title="사다리꼴 대열">
            <svg width="28" height="22" viewBox="0 0 28 22"><polygon points="6,2 22,2 26,20 2,20" fill="none" stroke="\${curType === 'trapezoid' ? '#00ffcc' : '#8f99a3'}" stroke-width="1.5"/><circle cx="14" cy="5" r="1.5" fill="\${curType === 'trapezoid' ? '#ff6666' : '#666'}"/><circle cx="8" cy="17" r="1.5" fill="\${curType === 'trapezoid' ? '#66ff66' : '#666'}"/><circle cx="20" cy="17" r="1.5" fill="\${curType === 'trapezoid' ? '#66ff66' : '#666'}"/><circle cx="14" cy="17" r="1.5" fill="\${curType === 'trapezoid' ? '#6666ff' : '#666'}"/></svg>
          </button>
          <button type="button" class="formation-type-btn\${curType === 'diamond' ? ' active' : ''}" data-formation="diamond" data-squad-id="\${theSquadId}" title="마름모 대열">
            <svg width="28" height="22" viewBox="0 0 28 22"><polygon points="14,1 27,11 14,21 1,11" fill="none" stroke="\${curType === 'diamond' ? '#00ffcc' : '#8f99a3'}" stroke-width="1.5"/><circle cx="14" cy="11" r="1.5" fill="\${curType === 'diamond' ? '#ff6666' : '#666'}"/><circle cx="14" cy="4" r="1.5" fill="\${curType === 'diamond' ? '#66ff66' : '#666'}"/><circle cx="7" cy="11" r="1.5" fill="\${curType === 'diamond' ? '#66ff66' : '#666'}"/><circle cx="21" cy="11" r="1.5" fill="\${curType === 'diamond' ? '#66ff66' : '#666'}"/></svg>
          </button>
        </div>\`;
    }`
});

// PATCH 4: Add click handler for formation type buttons (right after squad button handlers)
gamePatches.push({
  label: 'add formation type button click handler',
  oldStr: `    selectionInfo.querySelectorAll('[data-squad]').forEach(btn => {`,
  newStr: `    selectionInfo.querySelectorAll('.formation-type-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const formationType = btn.getAttribute('data-formation');
            const squadId = parseInt(btn.getAttribute('data-squad-id'));
            if (formationType && !isNaN(squadId)) {
                socket.emit('setFormationType', { squadId, formationType });
                const squad = gameState.squads.get(squadId);
                if (squad) squad.formationType = formationType;
                updateSelectionInfo();
            }
        });
    });
    selectionInfo.querySelectorAll('[data-squad]').forEach(btn => {`
});

patchFile(path.join(__dirname, 'public', 'game.js'), gamePatches);

// ============================================================
// CSS PATCH: Add formation button styles
// ============================================================
const cssPath = path.join(__dirname, 'public', 'style.css');
let cssRaw = fs.readFileSync(cssPath, 'utf8');
const cssCRLF = cssRaw.includes('\r\n');
let css = cssRaw.replace(/\r\n/g, '\n');

const formationCSS = `
/* Formation type selector buttons */
.formation-type-btn {
    background: rgba(40,44,52,0.9);
    border: 1.5px solid #555;
    border-radius: 4px;
    padding: 3px 5px;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
}
.formation-type-btn:hover {
    border-color: #00ffcc;
    background: rgba(0,255,204,0.1);
}
.formation-type-btn.active {
    border-color: #00ffcc;
    background: rgba(0,255,204,0.15);
    box-shadow: 0 0 6px rgba(0,255,204,0.3);
}
`;

if (!css.includes('.formation-type-btn')) {
  css += formationCSS;
  if (cssCRLF) css = css.replace(/\n/g, '\r\n');
  fs.writeFileSync(cssPath, css, 'utf8');
  console.log('[OK] style.css: formation button styles added');
} else {
  console.log('[SKIP] style.css: formation button styles already exist');
}

// ============================================================
// UPDATE CACHE-BUST
// ============================================================
const indexPath = path.join(__dirname, 'public', 'index.html');
let indexCode = fs.readFileSync(indexPath, 'utf8');
const newVer = 'src="game.js?v=' + Date.now() + '"';
if (indexCode.includes('src="game.js?v=')) {
  indexCode = indexCode.replace(/src="game\.js\?v=[^"]*"/, newVer);
  fs.writeFileSync(indexPath, indexCode, 'utf8');
  console.log('[OK] index.html: cache-bust updated');
}

console.log('\n=== All v5 patches applied! ===');
