// Patch for game.js only: add squad selection expansion + cache bust
const fs = require('fs');
const path = require('path');

// === game.js: add squad expansion in selectUnits ===
const gamePath = path.join(__dirname, 'public', 'game.js');
let raw = fs.readFileSync(gamePath, 'utf8');
const useCRLF = raw.includes('\r\n');
let code = raw.replace(/\r\n/g, '\n');

const oldStr = `    // Select units
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
    
    // Select buildings (if no units selected)`;

const newStr = `    // Select units
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

    // Select buildings (if no units selected)`;

const idx = code.indexOf(oldStr);
if (idx === -1) {
  console.error('[FAIL] Could not find selectUnits target in game.js');
  process.exit(1);
}
if (code.indexOf(oldStr, idx + 1) !== -1) {
  console.error('[FAIL] Multiple matches in game.js');
  process.exit(1);
}
code = code.substring(0, idx) + newStr + code.substring(idx + oldStr.length);
console.log('[OK] game.js: squad selection expansion added');

if (useCRLF) code = code.replace(/\n/g, '\r\n');
fs.writeFileSync(gamePath, code, 'utf8');

// === index.html: update cache-bust version ===
const indexPath = path.join(__dirname, 'public', 'index.html');
let indexCode = fs.readFileSync(indexPath, 'utf8');
const newVer = 'src="game.js?v=' + Date.now() + '"';
if (indexCode.includes('src="game.js?v=')) {
  indexCode = indexCode.replace(/src="game\.js\?v=[^"]*"/, newVer);
  fs.writeFileSync(indexPath, indexCode, 'utf8');
  console.log('[OK] index.html: updated cache-bust version');
} else {
  console.log('[SKIP] index.html: game.js version tag not found');
}

console.log('\n=== Done! ===');
