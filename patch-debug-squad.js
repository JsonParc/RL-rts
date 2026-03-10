// Add debug logging to squad selection in game.js
const fs = require('fs');
const path = require('path');

const gamePath = path.join(__dirname, 'public', 'game.js');
let raw = fs.readFileSync(gamePath, 'utf8');
const useCRLF = raw.includes('\r\n');
let code = raw.replace(/\r\n/g, '\n');

// Add debug logging before squad expansion
const oldStr = `    // If any selected unit belongs to a squad, select ALL squad members
    const squadIdsToExpand = new Set();
    gameState.selection.forEach(uid => {
        const u = gameState.units.get(uid);
        if (u && u.squadId) squadIdsToExpand.add(u.squadId);
    });
    if (squadIdsToExpand.size > 0) {
        // Find all units with matching squadId (works even without squads Map)
        gameState.units.forEach((u, uid) => {
            if (u && u.squadId && squadIdsToExpand.has(u.squadId) && u.userId === gameState.userId) {
                gameState.selection.add(uid);
            }
        });
    }`;

const newStr = `    // If any selected unit belongs to a squad, select ALL squad members
    const squadIdsToExpand = new Set();
    const _selBefore = gameState.selection.size;
    gameState.selection.forEach(uid => {
        const u = gameState.units.get(uid);
        console.log('[SquadDbg] selected uid=', uid, 'squadId=', u ? u.squadId : 'NO_UNIT');
        if (u && u.squadId) squadIdsToExpand.add(u.squadId);
    });
    console.log('[SquadDbg] squadIdsToExpand:', [...squadIdsToExpand], 'selectedBefore:', _selBefore);
    if (squadIdsToExpand.size > 0) {
        let _addCount = 0;
        gameState.units.forEach((u, uid) => {
            if (u && u.squadId && squadIdsToExpand.has(u.squadId) && u.userId === gameState.userId) {
                if (!gameState.selection.has(uid)) _addCount++;
                gameState.selection.add(uid);
            }
        });
        console.log('[SquadDbg] expanded selection by', _addCount, 'units. Total:', gameState.selection.size);
    }`;

const idx = code.indexOf(oldStr);
if (idx === -1) {
  console.error('[FAIL] Could not find squad expansion code in game.js');
  // Try to show what's actually around that area
  const i2 = code.indexOf('squadIdsToExpand');
  if (i2 >= 0) {
    console.log('Found squadIdsToExpand at char', i2);
    console.log('Context:', JSON.stringify(code.substring(i2-100, i2+500)));
  }
  process.exit(1);
}
code = code.substring(0, idx) + newStr + code.substring(idx + oldStr.length);
console.log('[OK] game.js: added squad selection debug logging');

if (useCRLF) code = code.replace(/\n/g, '\r\n');
fs.writeFileSync(gamePath, code, 'utf8');

// Update cache-bust
const indexPath = path.join(__dirname, 'public', 'index.html');
let indexCode = fs.readFileSync(indexPath, 'utf8');
const newVer = 'src="game.js?v=' + Date.now() + '"';
if (indexCode.includes('src="game.js?v=')) {
  indexCode = indexCode.replace(/src="game\.js\?v=[^"]*"/, newVer);
  fs.writeFileSync(indexPath, indexCode, 'utf8');
  console.log('[OK] index.html: cache-bust updated');
}

console.log('\n=== Debug logging added! ===');
console.log('After clicking a squad unit, check browser console for [SquadDbg] lines.');
