// Fix patch: Apply only G3 and G4 to game.js
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
      console.error(`[FAIL] ${label}`);
      const first = oldLF.substring(0, 80);
      console.error(`Looking for: ${JSON.stringify(first)}`);
      process.exit(1);
    }
    const idx2 = code.indexOf(oldLF, idx + 1);
    if (idx2 !== -1) { console.error(`[FAIL] Multiple matches: ${label}`); process.exit(1); }
    code = code.substring(0, idx) + newLF + code.substring(idx + oldLF.length);
    console.log(`[OK] ${label}`);
  }
  if (useCRLF) code = code.replace(/\n/g, '\r\n');
  fs.writeFileSync(filePath, code, 'utf8');
}

const GP = [];

// G3: Formation selector UI - NO blank line between } and selectionInfo
GP.push({
  label: 'G3: formation type selector UI',
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

// G4: Formation button click handlers after squad click handlers
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
console.log('\n=== G3+G4 applied! ===');
