const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const oldCollision = `    // Post-formation collision separation: push overlapping squad-mates apart when stopped
    if (!squad.moving) {
      for (let i = 0; i < units.length; i++) {
        const ui = units[i];
        for (let j = i + 1; j < units.length; j++) {
          const uj = units[j];
          if (doSelectionEllipsesOverlapWithPadding(ui, ui.x, ui.y, uj, uj.x, uj.y, NAVAL_COLLISION_CLEARANCE_BUFFER)) {
            const sdx = uj.x - ui.x;
            const sdy = uj.y - ui.y;
            const sDist = Math.hypot(sdx, sdy);
            if (sDist < 0.1) continue;
            const pushStr = 1.5 * deltaTime * 60;
            const pnx = sdx / sDist;
            const pny = sdy / sDist;
            ui.x -= pnx * pushStr;
            ui.y -= pny * pushStr;
            uj.x += pnx * pushStr;
            uj.y += pny * pushStr;
          }
        }
      }
    }`;

const newCollision = `    // Collision separation: push overlapping squad-mates apart (always active)
    for (let i = 0; i < units.length; i++) {
      const ui = units[i];
      for (let j = i + 1; j < units.length; j++) {
        const uj = units[j];
        if (doSelectionEllipsesOverlapWithPadding(ui, ui.x, ui.y, uj, uj.x, uj.y, NAVAL_COLLISION_CLEARANCE_BUFFER)) {
          const sdx = uj.x - ui.x;
          const sdy = uj.y - ui.y;
          const sDist = Math.hypot(sdx, sdy);
          if (sDist < 0.1) continue;
          const pushStr = 2.5 * deltaTime * 60;
          const pnx = sdx / sDist;
          const pny = sdy / sDist;
          ui.x -= pnx * pushStr;
          ui.y -= pny * pushStr;
          uj.x += pnx * pushStr;
          uj.y += pny * pushStr;
        }
      }
    }`;

const count = code.split(oldCollision).length - 1;
console.log('Found:', count);
if (count === 1) {
  code = code.replace(oldCollision, newCollision);
  fs.writeFileSync('server.js', code, 'utf8');
  console.log('Collision separation now always active');
} else {
  console.log('ERROR');
}
