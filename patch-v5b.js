// Patch v5: Formation overhaul - correct exact strings
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
      const first = oldLF.substring(0, 120);
      console.error(`Looking for: ${first}`);
      // Try to find partial
      const words = first.split(/\s+/).filter(w=>w.length>5);
      if (words.length>0) {
        const wi = code.indexOf(words[0]);
        if (wi >= 0) console.error(`Found '${words[0]}' at char ${wi}, context: ${code.substring(wi-30,wi+80)}`);
      }
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

// ===================================================================
// SERVER.JS
// ===================================================================
const SP = [];

// S1: Replace entire getSquadFormationPositions (up to the next function)
SP.push({
  label: 'S1: rewrite formation function',
  oldStr: fs.readFileSync('server.js','utf8').replace(/\r\n/g,'\n').match(
    /function getSquadFormationPositions\(units, targetX, targetY, moveAngle\) \{[\s\S]*?\n\}\n\nfunction getSquadPathfindType/
  )[0].replace(/\nfunction getSquadPathfindType$/, ''),
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
  const NON_COMBAT_TYPES = new Set(['assaultship', 'submarine']);

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
      positions.push({ unit: u, x: targetX + sideX * lat + forwardX * fwdOff, y: targetY + sideY * lat + forwardY * fwdOff });
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
    for (const g of groups) { for (let i = 0; i < g.length; i += maxPerRow) result.push(g.slice(i, i + maxPerRow)); }
    return result;
  }

  if (formationType === 'diamond') {
    // DIAMOND: long range center, short range outer, non-combat behind
    const combatUnits = [], nonCombatUnits = [];
    for (const u of sorted) { if (NON_COMBAT_TYPES.has(u.type)) nonCombatUnits.push(u); else combatUnits.push(u); }
    const byRangeDesc = [...combatUnits].sort((a, b) => (b.attackRange || 0) - (a.attackRange || 0));
    const rings = [];
    let placed = 0, ri = 0;
    while (placed < byRangeDesc.length) {
      const cap = ri === 0 ? 1 : 4 * ri;
      rings.push(byRangeDesc.slice(placed, placed + cap));
      placed += rings[rings.length - 1].length;
      ri++;
    }
    const avgSize = combatUnits.length > 0 ? combatUnits.reduce((s, u) => s + getUnitFormationSize(u).shortAxis * 2, 0) / combatUnits.length : 40;
    const ringSpacing = avgSize + FORMATION_GAP;
    for (let r = 0; r < rings.length; r++) {
      const ru = rings[r];
      if (r === 0) {
        positions.push({ unit: ru[0], x: targetX, y: targetY });
      } else {
        const dist = r * ringSpacing;
        const n = ru.length;
        for (let i = 0; i < n; i++) {
          const t = i / n;
          let px, py;
          if (t < 0.25) { const s2 = t / 0.25; px = dist * s2; py = dist * (1 - s2); }
          else if (t < 0.5) { const s2 = (t - 0.25) / 0.25; px = dist * (1 - s2); py = -dist * s2; }
          else if (t < 0.75) { const s2 = (t - 0.5) / 0.25; px = -dist * s2; py = -dist * (1 - s2); }
          else { const s2 = (t - 0.75) / 0.25; px = -dist * (1 - s2); py = dist * s2; }
          positions.push({ unit: ru[i], x: targetX + sideX * px + forwardX * py, y: targetY + sideY * px + forwardY * py });
        }
      }
    }
    if (nonCombatUnits.length > 0) {
      const rearDist = rings.length * ringSpacing + FORMATION_GAP;
      const ncW = nonCombatUnits.reduce((s, u) => s + getUnitFormationSize(u).shortAxis * 2, 0) + FORMATION_GAP * Math.max(0, nonCombatUnits.length - 1);
      let cur = -ncW / 2;
      for (const u of nonCombatUnits) {
        const w = getUnitFormationSize(u).shortAxis * 2;
        positions.push({ unit: u, x: targetX + sideX * (cur + w / 2) - forwardX * rearDist, y: targetY + sideY * (cur + w / 2) - forwardY * rearDist });
        cur += w + FORMATION_GAP;
      }
    }
    return positions;
  }

  // ===== TRAPEZOID =====
  const combatUnits = [], forcedRearUnits = [];
  for (const u of sorted) { if (NON_COMBAT_TYPES.has(u.type)) forcedRearUnits.push(u); else combatUnits.push(u); }
  const rangeGroups = [];
  for (const u of combatUnits) {
    const r = u.attackRange || 0;
    if (rangeGroups.length === 0) { rangeGroups.push([u]); }
    else { const lg = rangeGroups[rangeGroups.length - 1]; if (Math.abs(r - (lg[lg.length - 1].attackRange || 0)) > 200) rangeGroups.push([u]); else lg.push(u); }
  }
  let frontUnits = [], flankUnits = [], rearUnits = [];
  const N = rangeGroups.length;
  if (N <= 1) { frontUnits = combatUnits.slice(); }
  else if (N === 2) { frontUnits = rangeGroups[0].slice(); rearUnits = rangeGroups[1].slice(); }
  else {
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
  rearUnits.push(...forcedRearUnits);

  const frontRows = makeRows(frontUnits, MAX_PER_ROW);
  const rearRows = makeRows(rearUnits, MAX_PER_ROW);
  const frontDepths = frontRows.map(r => getRowDepth(r));
  const rearDepths = rearRows.map(r => getRowDepth(r));
  let centerMaxWidth = 0;
  frontRows.forEach(r => { centerMaxWidth = Math.max(centerMaxWidth, getRowWidth(r)); });
  rearRows.forEach(r => { centerMaxWidth = Math.max(centerMaxWidth, getRowWidth(r)); });

  let fOff = FORMATION_GAP / 2;
  for (let i = frontRows.length - 1; i >= 0; i--) {
    fOff += frontDepths[i] / 2; placeRow(frontRows[i], fOff, 0); fOff += frontDepths[i] / 2 + FORMATION_GAP;
  }
  let rOff = -FORMATION_GAP / 2;
  for (let i = 0; i < rearRows.length; i++) {
    rOff -= rearDepths[i] / 2; placeRow(rearRows[i], rOff, 0); rOff -= rearDepths[i] / 2 + FORMATION_GAP;
  }

  if (flankUnits.length > 0) {
    const half = Math.ceil(flankUnits.length / 2);
    const leftFlank = flankUnits.slice(0, half);
    const rightFlank = flankUnits.slice(half);
    function placeFlankSide(sideUnits, sign) {
      if (sideUnits.length === 0) return;
      const rows = [];
      for (let i = 0; i < sideUnits.length; i += FLANK_MAX_PER_ROW) rows.push(sideUnits.slice(i, i + FLANK_MAX_PER_ROW));
      let maxW = 0;
      rows.forEach(r => { maxW = Math.max(maxW, getRowWidth(r)); });
      const latCenter = sign * (centerMaxWidth / 2 + FORMATION_GAP + maxW / 2);
      const depths = rows.map(r => getRowDepth(r));
      const totalD = depths.reduce((s, d) => s + d, 0) + FORMATION_GAP * Math.max(0, rows.length - 1);
      let vOff = totalD / 2;
      for (let i = 0; i < rows.length; i++) { vOff -= depths[i] / 2; placeRow(rows[i], vOff, latCenter); vOff -= depths[i] / 2 + FORMATION_GAP; }
    }
    placeFlankSide(leftFlank, -1);
    placeFlankSide(rightFlank, 1);
  }
  return positions;
}
`
});

// S2: Pass formationType in issueSquadMoveOrder
SP.push({
  label: 'S2: formationType in issueSquadMoveOrder',
  oldStr: `function issueSquadMoveOrder(squad, targetX, targetY) {\n  const units = getSquadAliveUnits(squad);`,
  newStr: `function issueSquadMoveOrder(squad, targetX, targetY) {\n  const formationType = squad.formationType || 'trapezoid';\n  const units = getSquadAliveUnits(squad);`
});

SP.push({
  label: 'S3: use formationType in moveOrder formation call',
  oldStr: `  const positions = getSquadFormationPositions(units, targetX, targetY, moveAngle);\n\n  positions.forEach(({ unit, x, y }) => {\n    unit.squadOffsetX = x - targetX;\n    unit.squadOffsetY = y - targetY;\n    unit.speed = slowestSpeed;\n    unit.holdPosition = false;\n    unit.attackMove = false;`,
  newStr: `  const positions = getSquadFormationPositions(units, targetX, targetY, moveAngle, formationType);\n\n  positions.forEach(({ unit, x, y }) => {\n    unit.squadOffsetX = x - targetX;\n    unit.squadOffsetY = y - targetY;\n    unit.speed = slowestSpeed;\n    unit.holdPosition = false;\n    unit.attackMove = false;`
});

// S4: Pass formationType in issueSquadAttackMove
SP.push({
  label: 'S4: formationType in issueSquadAttackMove',
  oldStr: `function issueSquadAttackMove(squad, targetX, targetY) {\n  const units = getSquadAliveUnits(squad);`,
  newStr: `function issueSquadAttackMove(squad, targetX, targetY) {\n  const formationType = squad.formationType || 'trapezoid';\n  const units = getSquadAliveUnits(squad);`
});

SP.push({
  label: 'S5: use formationType in attackMove formation call',
  oldStr: `  const positions = getSquadFormationPositions(units, targetX, targetY, moveAngle);\n\n  positions.forEach(({ unit, x, y }) => {\n    unit.squadOffsetX = x - targetX;\n    unit.squadOffsetY = y - targetY;\n    unit.speed = slowestSpeed;\n    unit.holdPosition = false;\n    unit.attackMove = true;`,
  newStr: `  const positions = getSquadFormationPositions(units, targetX, targetY, moveAngle, formationType);\n\n  positions.forEach(({ unit, x, y }) => {\n    unit.squadOffsetX = x - targetX;\n    unit.squadOffsetY = y - targetY;\n    unit.speed = slowestSpeed;\n    unit.holdPosition = false;\n    unit.attackMove = true;`
});

// S6: Set formationType on squad creation
SP.push({
  label: 'S6: formationType on squad creation',
  oldStr: `    const squad = { unitIds: validUnits, ownerId: socket.userId };`,
  newStr: `    const squad = { unitIds: validUnits, ownerId: socket.userId, formationType: 'trapezoid' };`
});

// S7: Pass formationType in createSquad getSquadFormationPositions call
SP.push({
  label: 'S7: formationType in createSquad formation call',
  oldStr: `      const fPositions = getSquadFormationPositions(aliveUnits, cx, cy, avgAngle);`,
  newStr: `      const fPositions = getSquadFormationPositions(aliveUnits, cx, cy, avgAngle, squad.formationType);`
});

// S8: Include formationType in squadCreated emit
SP.push({
  label: 'S8: formationType in squadCreated emit',
  oldStr: `    socket.emit('squadCreated', { squadId, unitIds: validUnits });`,
  newStr: `    socket.emit('squadCreated', { squadId, unitIds: validUnits, formationType: squad.formationType });`
});

// S9: Add setFormationType handler before disbandSquad
SP.push({
  label: 'S9: add setFormationType socket handler',
  oldStr: `  socket.on('disbandSquad', (data) => {\n    switchRoom(socket.roomId);\n    const squadId = data?.squadId;`,
  newStr: `  socket.on('setFormationType', (data) => {
    switchRoom(socket.roomId);
    const sqId = data?.squadId;
    const fType = data?.formationType;
    if (!sqId || !fType || !['trapezoid', 'diamond'].includes(fType)) return;
    const sq = gameState.squads.get(sqId);
    if (!sq || sq.ownerId !== socket.userId) return;
    sq.formationType = fType;
    const sUnits = getSquadAliveUnits(sq);
    if (sUnits.length > 0) {
      const cx2 = sUnits.reduce((s, u) => s + u.x, 0) / sUnits.length;
      const cy2 = sUnits.reduce((s, u) => s + u.y, 0) / sUnits.length;
      const pos = getSquadFormationPositions(sUnits, sq.targetX || cx2, sq.targetY || cy2, sq.moveAngle || 0, fType);
      const spd = getSquadSlowestSpeed(sq);
      const fUntil = Date.now() + 3000;
      pos.forEach(({ unit, x, y }) => {
        unit.squadOffsetX = x - (sq.centerX || cx2);
        unit.squadOffsetY = y - (sq.centerY || cy2);
        unit.speed = spd;
        unit.formingUp = true;
        unit.formingUpUntil = fUntil;
        assignMoveTarget(unit, x, y);
      });
    }
    socket.emit('formationTypeChanged', { squadId: sqId, formationType: fType });
  });

  socket.on('disbandSquad', (data) => {
    switchRoom(socket.roomId);
    const squadId = data?.squadId;`
});

// S10: Include formationType in unit payload
SP.push({
  label: 'S10: formationType in unit payload',
  oldStr: `      squadId: unit.squadId ?? null\n    });`,
  newStr: `      squadId: unit.squadId ?? null,\n      formationType: unit.squadId ? (gameState.squads.get(unit.squadId)?.formationType || 'trapezoid') : null\n    });`
});

patchFile(path.join(__dirname, 'server.js'), SP);

// ===================================================================
// GAME.JS
// ===================================================================
const GP = [];

// G1: Store formationType in squadCreated handler
GP.push({
  label: 'G1: store formationType on squadCreated',
  oldStr: `            gameState.squads.set(data.squadId, { unitIds: data.unitIds });`,
  newStr: `            gameState.squads.set(data.squadId, { unitIds: data.unitIds, formationType: data.formationType || 'trapezoid' });`
});

// G2: Add formationTypeChanged handler after squadCreated
GP.push({
  label: 'G2: add formationTypeChanged handler',
  oldStr: `    socket.on('squadDisbanded', (data) => {`,
  newStr: `    socket.on('formationTypeChanged', (data) => {
        if (data && data.squadId && data.formationType) {
            const sq = gameState.squads.get(data.squadId);
            if (sq) sq.formationType = data.formationType;
            updateSelectionInfo();
        }
    });

    socket.on('squadDisbanded', (data) => {`
});

// G3: Add formation selector after squad disband button
GP.push({
  label: 'G3: add formation type selector UI',
  oldStr: `            html += \`</div>\`;
        }

        selectionInfo.innerHTML = html;`,
  newStr: `            html += \`</div>\`;
            if (allInSameSquad) {
                const _sqId = [...squadIdsSet][0];
                const _sqData = gameState.squads.get(_sqId);
                const _curFT = _sqData?.formationType || (ownUnits[0]?.formationType) || 'trapezoid';
                html += \`<div style="margin-top:6px;display:flex;gap:8px;align-items:center;">
                  <span style="color:#8f99a3;font-size:11px;">대열:</span>
                  <button type="button" class="formation-type-btn\${_curFT === 'trapezoid' ? ' active' : ''}" data-formation="trapezoid" data-squad-id="\${_sqId}" title="사다리꼴 대열">
                    <svg width="28" height="22" viewBox="0 0 28 22"><polygon points="6,2 22,2 26,20 2,20" fill="none" stroke="\${_curFT === 'trapezoid' ? '#00ffcc' : '#8f99a3'}" stroke-width="1.5"/><circle cx="14" cy="5" r="1.5" fill="\${_curFT === 'trapezoid' ? '#ff6666' : '#666'}"/><circle cx="8" cy="17" r="1.5" fill="\${_curFT === 'trapezoid' ? '#66ff66' : '#666'}"/><circle cx="20" cy="17" r="1.5" fill="\${_curFT === 'trapezoid' ? '#66ff66' : '#666'}"/><circle cx="14" cy="17" r="1.5" fill="\${_curFT === 'trapezoid' ? '#6666ff' : '#666'}"/></svg>
                  </button>
                  <button type="button" class="formation-type-btn\${_curFT === 'diamond' ? ' active' : ''}" data-formation="diamond" data-squad-id="\${_sqId}" title="마름모 대열">
                    <svg width="28" height="22" viewBox="0 0 28 22"><polygon points="14,1 27,11 14,21 1,11" fill="none" stroke="\${_curFT === 'diamond' ? '#00ffcc' : '#8f99a3'}" stroke-width="1.5"/><circle cx="14" cy="11" r="1.5" fill="\${_curFT === 'diamond' ? '#ff6666' : '#666'}"/><circle cx="14" cy="4" r="1.5" fill="\${_curFT === 'diamond' ? '#66ff66' : '#666'}"/><circle cx="7" cy="11" r="1.5" fill="\${_curFT === 'diamond' ? '#66ff66' : '#666'}"/><circle cx="21" cy="11" r="1.5" fill="\${_curFT === 'diamond' ? '#66ff66' : '#666'}"/></svg>
                  </button>
                </div>\`;
            }
        }

        selectionInfo.innerHTML = html;`
});

// G4: Add formation type button click handling after existing squad click handling
GP.push({
  label: 'G4: formation type click handlers',
  oldStr: `        selectionInfo.querySelectorAll('[data-squad]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.getAttribute('data-squad');
                const own = Array.from(gameState.selection)
                    .map(id => gameState.units.get(id))
                    .filter(u => u && u.userId === gameState.userId);
                if (action === 'create' && own.length >= 2 && socket) {
                    socket.emit('createSquad', { unitIds: own.map(u => u.id) });
                } else if (action === 'disband') {
                    const sids = new Set(own.map(u => u.squadId).filter(Boolean));
                    sids.forEach(sid => { if (socket) socket.emit('disbandSquad', { squadId: sid }); });
                }
            });
        });
        selectionInfo.classList.add('active');`,
  newStr: `        selectionInfo.querySelectorAll('[data-squad]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.getAttribute('data-squad');
                const own = Array.from(gameState.selection)
                    .map(id => gameState.units.get(id))
                    .filter(u => u && u.userId === gameState.userId);
                if (action === 'create' && own.length >= 2 && socket) {
                    socket.emit('createSquad', { unitIds: own.map(u => u.id) });
                } else if (action === 'disband') {
                    const sids = new Set(own.map(u => u.squadId).filter(Boolean));
                    sids.forEach(sid => { if (socket) socket.emit('disbandSquad', { squadId: sid }); });
                }
            });
        });
        selectionInfo.querySelectorAll('.formation-type-btn').forEach(fBtn => {
            fBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const ft = fBtn.getAttribute('data-formation');
                const sid = parseInt(fBtn.getAttribute('data-squad-id'));
                if (ft && !isNaN(sid) && socket) {
                    socket.emit('setFormationType', { squadId: sid, formationType: ft });
                    const sq = gameState.squads.get(sid);
                    if (sq) sq.formationType = ft;
                    setTimeout(() => updateSelectionInfo(), 50);
                }
            });
        });
        selectionInfo.classList.add('active');`
});

patchFile(path.join(__dirname, 'public', 'game.js'), GP);

// ===================================================================
// CSS: formation button styles
// ===================================================================
const cssPath = path.join(__dirname, 'public', 'style.css');
let cssRaw = fs.readFileSync(cssPath, 'utf8');
const cssCRLF = cssRaw.includes('\r\n');
let css = cssRaw.replace(/\r\n/g, '\n');
if (!css.includes('.formation-type-btn')) {
  css += `
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
  if (cssCRLF) css = css.replace(/\n/g, '\r\n');
  fs.writeFileSync(cssPath, css, 'utf8');
  console.log('[OK] style.css: formation styles added');
}

// ===================================================================
// CACHE BUST
// ===================================================================
const indexPath = path.join(__dirname, 'public', 'index.html');
let indexCode = fs.readFileSync(indexPath, 'utf8');
const newVer = 'src="game.js?v=' + Date.now() + '"';
if (indexCode.includes('src="game.js?v=')) {
  indexCode = indexCode.replace(/src="game\.js\?v=[^"]*"/, newVer);
  fs.writeFileSync(indexPath, indexCode, 'utf8');
  console.log('[OK] index.html: cache-bust updated');
}

console.log('\n=== v5 patches applied! ===');
