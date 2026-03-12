const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Add debug logging right after the squad units.forEach positioning loop
const marker = `    // Collision separation: push overlapping squad-mates apart (always active)`;
const debugLog = `    // DEBUG: Log squad offsets every 5 seconds
    if (!squad._lastDebugLog || Date.now() - squad._lastDebugLog > 5000) {
      squad._lastDebugLog = Date.now();
      console.log('[SQUAD DEBUG] id=' + squad.id + ' moving=' + squad.moving + ' centerX=' + Math.round(squad.centerX) + ' centerY=' + Math.round(squad.centerY) + ' moveAngle=' + (squad.moveAngle || 0).toFixed(2));
      units.forEach((u, idx) => {
        console.log('  unit[' + idx + '] type=' + u.type + ' fwd=' + (u.squadForwardOffset || 0).toFixed(1) + ' lat=' + (u.squadLateralOffset || 0).toFixed(1) + ' x=' + Math.round(u.x) + ' y=' + Math.round(u.y));
      });
    }
`;

if (code.includes(marker)) {
  code = code.replace(marker, debugLog + '\n' + marker);
  fs.writeFileSync('server.js', code, 'utf8');
  console.log('Debug logging added');
} else {
  console.log('ERROR: Marker not found');
}
