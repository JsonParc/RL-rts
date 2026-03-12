const fs = require('fs');
let js = fs.readFileSync('public/game.js', 'utf8');

// FIX 1: Enemy building click - add to selection
const fix1Old = `    if (gameState.selection.size === 0 && isClick) {
        const enemyUnitId = findInspectableEnemyUnitAt(clickX, clickY);
        if (enemyUnitId !== null) {
            gameState.inspectedUnitId = enemyUnitId;
        }
    }`;
const fix1New = `    if (gameState.selection.size === 0 && isClick) {
        const enemyUnitId = findInspectableEnemyUnitAt(clickX, clickY);
        if (enemyUnitId !== null) {
            gameState.inspectedUnitId = enemyUnitId;
        } else {
            gameState.buildings.forEach((building, buildingId) => {
                if (building.userId !== gameState.userId && gameState.selection.size === 0) {
                    const buildingHalfSize = getBuildingHitboxHalfSize(building);
                    if (clickX >= building.x - buildingHalfSize && clickX <= building.x + buildingHalfSize &&
                        clickY >= building.y - buildingHalfSize && clickY <= building.y + buildingHalfSize) {
                        gameState.selection.add(buildingId);
                    }
                }
            });
        }
    }`;

if (!js.includes(fix1Old)) { console.error('FIX1 not found!'); process.exit(1); }
js = js.replace(fix1Old, fix1New);
console.log('FIX1 applied: enemy building click');

// FIX 2: Remove aegisMode exclusion from combat stance eligibility
const fix2Old = `    const stanceEligibleBattleships = battleships.filter(unit => !unit.battleshipAegisMode);`;
const fix2New = `    const stanceEligibleBattleships = battleships;`;
if (!js.includes(fix2Old)) { console.error('FIX2 not found!'); process.exit(1); }
js = js.replace(fix2Old, fix2New);
console.log('FIX2 applied: aegis+stance combo unlocked');

// FIX 2b: Remove the "aegis blocks stance" error message block
const fix2bOld = `    if (!hasEligibleBattleships) {
        document.getElementById('skillDesc2').textContent = '이지스 모드 중인 전함은 전투태세를 사용할 수 없음';
        return;
    }`;
if (!js.includes(fix2bOld)) { console.error('FIX2b not found!'); process.exit(1); }
js = js.replace(fix2bOld, '');
console.log('FIX2b applied: removed aegis-blocks-stance message');

// FIX 3: Aegis display damage 10 -> 7
const fix3Old = `    if (unit.type === 'battleship' && unit.battleshipAegisMode) return 10;`;
const fix3New = `    if (unit.type === 'battleship' && unit.battleshipAegisMode) return 7;`;
if (!js.includes(fix3Old)) { console.error('FIX3 not found!'); process.exit(1); }
js = js.replace(fix3Old, fix3New);
console.log('FIX3 applied: aegis damage display 10->7');

// FIX 3b: Update all "발당 10" text in skill descriptions to "발당 7"
const beforeCount = (js.match(/발당 10/g) || []).length;
js = js.replace(/발당 10/g, '발당 7');
console.log(`FIX3b applied: replaced ${beforeCount} instances of "발당 10" -> "발당 7"`);

fs.writeFileSync('public/game.js', js);
console.log('game.js saved OK');
