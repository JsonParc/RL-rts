const fs = require('fs');
const js = fs.readFileSync('public/game.js', 'utf8');
const sv = fs.readFileSync('server.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');

console.log('=== game.js ===');
console.log('Squad uniform facing:', js.includes('unit.squadId && unit.angle !== undefined') ? 'OK' : 'FAIL');
console.log('addAI clicks 29:', js.includes('addClicks >= 29') ? 'OK' : 'FAIL');
console.log('removeAI clicks 22:', js.includes('removeClicks >= 22') ? 'OK' : 'FAIL');
console.log('systemMessage handler:', js.includes("socket.on('systemMessage'") ? 'OK' : 'FAIL');

console.log('=== server.js ===');
console.log('unit.angle in payload:', sv.includes('angle: unit.angle ?? 0') ? 'OK' : 'FAIL');
console.log('AI updateInterval 2000:', sv.includes('updateInterval: 2000') ? 'OK' : 'FAIL');
console.log('counterattackThreshold 1:', sv.includes('counterattackThreshold: 1') ? 'OK' : 'FAIL');
console.log('AI combat stance:', sv.includes('combatStanceActive = true') ? 'OK' : 'FAIL');
console.log('addAI handler:', sv.includes("socket.on('addAI'") ? 'OK' : 'FAIL');
console.log('removeAI handler:', sv.includes("socket.on('removeAI'") ? 'OK' : 'FAIL');
console.log('attack cooldown 8000:', sv.includes('> 8000') ? 'OK' : 'FAIL');
console.log('min 1 unit attack:', sv.includes('aiCombatUnits.length >= 1') ? 'OK' : 'FAIL');

console.log('=== index.html ===');
console.log('aiAddZone:', html.includes('aiAddZone') ? 'OK' : 'FAIL');
console.log('aiRemoveZone:', html.includes('aiRemoveZone') ? 'OK' : 'FAIL');
