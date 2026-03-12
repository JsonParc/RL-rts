const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// 1. Update getUnitFormationMetrics to use visual-size-aware spacing
const oldMetrics = `function getUnitFormationMetrics(unit) {
  if (!unit) {
    return { lateralSpacing: 90, forwardSpacing: 140, keepOutRadius: 38 };
  }
  if (!usesNavalContactCollision(unit)) {
    return { lateralSpacing: 100, forwardSpacing: 110, keepOutRadius: 0 };
  }
  const { longAxis, shortAxis } = getUnitFormationSize(unit);
  return {
    lateralSpacing: Math.round((shortAxis * 2) + 16),
    forwardSpacing: Math.round((longAxis * 2) + 20),
    keepOutRadius: Math.round(shortAxis + 12)
  };
}`;

const newMetrics = `function getUnitFormationMetrics(unit) {
  if (!unit) {
    return { lateralSpacing: 160, forwardSpacing: 500, keepOutRadius: 60 };
  }
  if (!usesNavalContactCollision(unit)) {
    return { lateralSpacing: 120, forwardSpacing: 140, keepOutRadius: 0 };
  }
  const { longAxis, shortAxis } = getUnitFormationSize(unit);
  // Use visual-size-aware spacing: sprites render at size*heightMult (~6.6x)
  // so formation spacing must account for actual rendered dimensions
  return {
    lateralSpacing: Math.round(shortAxis * 5 + 30),
    forwardSpacing: Math.round(longAxis * 6 + 50),
    keepOutRadius: Math.round(shortAxis * 2.5)
  };
}`;

// 2. Remove debug logging
const debugMarker = `    // DEBUG: Log squad offsets every 5 seconds
    if (!squad._lastDebugLog || Date.now() - squad._lastDebugLog > 5000) {
      squad._lastDebugLog = Date.now();
      console.log('[SQUAD DEBUG] id=' + squad.id + ' moving=' + squad.moving + ' centerX=' + Math.round(squad.centerX) + ' centerY=' + Math.round(squad.centerY) + ' moveAngle=' + (squad.moveAngle || 0).toFixed(2));
      units.forEach((u, idx) => {
        console.log('  unit[' + idx + '] type=' + u.type + ' fwd=' + (u.squadForwardOffset || 0).toFixed(1) + ' lat=' + (u.squadLateralOffset || 0).toFixed(1) + ' x=' + Math.round(u.x) + ' y=' + Math.round(u.y));
      });
    }
`;

let count1 = code.split(oldMetrics).length - 1;
console.log('Found getUnitFormationMetrics:', count1);

let count2 = code.split(debugMarker).length - 1;
console.log('Found debug log:', count2);

if (count1 === 1 && count2 === 1) {
  code = code.replace(oldMetrics, newMetrics);
  code = code.replace(debugMarker, '');
  fs.writeFileSync('server.js', code, 'utf8');
  console.log('Patched formation metrics and removed debug logging');
} else {
  if (count1 !== 1) console.log('ERROR: getUnitFormationMetrics not found or duplicate');
  if (count2 !== 1) console.log('ERROR: debug log not found or duplicate');
}
