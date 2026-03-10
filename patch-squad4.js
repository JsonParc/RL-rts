// Patch v4: Fix formation (flank layout) + verify selection + cache busting
const fs = require('fs');
const path = require('path');

function patchFile(filePath, patches) {
  let raw = fs.readFileSync(filePath, 'utf8');
  const useCRLF = raw.includes('\r\n');
  let code = raw.replace(/\r\n/g, '\n'); // normalize to LF
  for (const { label, oldStr, newStr } of patches) {
    const oldLF = oldStr.replace(/\r\n/g, '\n');
    const newLF = newStr.replace(/\r\n/g, '\n');
    const idx = code.indexOf(oldLF);
    if (idx === -1) {
      console.error(`[FAIL] ${path.basename(filePath)}: ${label}`);
      console.error(`Looking for (first 120): ${oldLF.substring(0, 120)}`);
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

// ========== SERVER.JS: Rewrite formation with front/flank/rear tiers ==========
const serverPatches = [];

serverPatches.push({
  label: 'formation: front/flank/rear tier layout',
  oldStr: `function getSquadFormationPositions(units, targetX, targetY, moveAngle) {
  // Sort by attackRange ascending: shortest in front, longest in back
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

  // Group units with similar attack range (within 200) into rows
  const rows = [];
  for (const u of sorted) {
    const r = u.attackRange || 0;
    if (rows.length === 0 || Math.abs(r - (rows[rows.length - 1][0].attackRange || 0)) > 200) {
      rows.push([u]);
    } else {
      rows[rows.length - 1].push(u);
    }
  }

  // Split large rows into sub-rows of max MAX_PER_ROW
  const finalRows = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i += MAX_PER_ROW) {
      finalRows.push(row.slice(i, i + MAX_PER_ROW));
    }
  }

  // Place a centered horizontal row perpendicular to movement direction
  function placeRow(rowUnits, fwdOff) {
    const widths = rowUnits.map(u => getUnitFormationSize(u).shortAxis * 2);
    const total = widths.reduce((s, w) => s + w, 0) + FORMATION_GAP * Math.max(0, rowUnits.length - 1);
    let cursor = -total / 2;
    rowUnits.forEach((u, i) => {
      const hW = widths[i] / 2;
      positions.push({
        unit: u,
        x: targetX + sideX * (cursor + hW) + forwardX * fwdOff,
        y: targetY + sideY * (cursor + hW) + forwardY * fwdOff
      });
      cursor += widths[i] + FORMATION_GAP;
    });
  }

  function rowDepth(rowUnits) {
    return rowUnits.reduce((m, u) => Math.max(m, getUnitFormationSize(u).longAxis * 2), 40);
  }

  // Compute total formation depth to center it
  const depths = finalRows.map(r => rowDepth(r));
  let totalDepth = 0;
  for (let i = 0; i < depths.length; i++) {
    totalDepth += depths[i] + (i > 0 ? FORMATION_GAP : 0);
  }

  // Place rows from front (shortest range, positive fwd) to back (longest range, negative fwd)
  let fwd = totalDepth / 2;
  for (let i = 0; i < finalRows.length; i++) {
    fwd -= depths[i] / 2;
    placeRow(finalRows[i], fwd);
    fwd -= depths[i] / 2 + FORMATION_GAP;
  }

  return positions;
}`,
  newStr: `function getSquadFormationPositions(units, targetX, targetY, moveAngle) {
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
}`
});

patchFile(path.join(__dirname, 'server.js'), serverPatches);

// ========== CLIENT: Add squad selection expansion in selectUnits() ==========
const gamePatches = [];

gamePatches.push({
  label: 'squad selection: expand to all squad members',
  oldStr: `    // Select units
    gameState.units.forEach((unit, unitId) => {
        if (unit.userId === gameState.userId) {
            if (isClick) {
                if (isPointInsideUnitHitbox(unit, clickX, clickY)) {
                    gameState.selection.add(unitId);
                }
            } else {
                if (unit.x >= minX && unit.x <= maxX &&
                    unit.y >= minY && unit.y <= maxY) {
                    gameState.selection.add(unitId);
                }
            }
        }
    });
    
    // Select buildings (if no units selected)`,
  newStr: `    // Select units
    gameState.units.forEach((unit, unitId) => {
        if (unit.userId === gameState.userId) {
            if (isClick) {
                if (isPointInsideUnitHitbox(unit, clickX, clickY)) {
                    gameState.selection.add(unitId);
                }
            } else {
                if (unit.x >= minX && unit.x <= maxX &&
                    unit.y >= minY && unit.y <= maxY) {
                    gameState.selection.add(unitId);
                }
            }
        }
    });

    // If any selected unit belongs to a squad, select ALL squad members
    const squadIdsToExpand = new Set();
    gameState.selection.forEach(uid => {
        const u = gameState.units.get(uid);
        if (u && u.squadId) squadIdsToExpand.add(u.squadId);
    });
    if (squadIdsToExpand.size > 0) {
        gameState.units.forEach((u, uid) => {
            if (u && u.squadId && squadIdsToExpand.has(u.squadId) && u.userId === gameState.userId) {
                gameState.selection.add(uid);
            }
        });
    }

    // Select buildings (if no units selected)`
});

patchFile(path.join(__dirname, 'public', 'game.js'), gamePatches);

// ========== Update cache-bust version in index.html ==========
const indexPath = path.join(__dirname, 'public', 'index.html');
let indexCode = fs.readFileSync(indexPath, 'utf8');
const newVer = 'src="game.js?v=' + Date.now() + '"';
if (indexCode.includes('src="game.js?v=')) {
  indexCode = indexCode.replace(/src="game\.js\?v=[^"]*"/, newVer);
  fs.writeFileSync(indexPath, indexCode, 'utf8');
  console.log('[OK] index.html: updated cache-bust version');
} else {
  console.log('[SKIP] index.html: game.js script tag not found');
}

console.log('\n=== All patches applied! ===');
