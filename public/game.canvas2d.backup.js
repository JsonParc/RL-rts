// Game state
let socket = null;
let rankingInterval = null;
let slbmTargetingMode = false;
let attackMode = false;
let slbmMissiles = []; // Active SLBM missiles for visualization

function setAttackMode(on) {
    attackMode = on;
    const indicator = document.getElementById('modeIndicator');
    if (indicator) indicator.style.display = on ? 'inline' : 'none';
    if (on) {
        canvas.style.cursor = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'32\' height=\'32\'%3E%3Ccircle cx=\'16\' cy=\'16\' r=\'14\' fill=\'none\' stroke=\'red\' stroke-width=\'2\'/%3E%3Cline x1=\'16\' y1=\'4\' x2=\'16\' y2=\'28\' stroke=\'red\' stroke-width=\'2\'/%3E%3Cline x1=\'4\' y1=\'16\' x2=\'28\' y2=\'16\' stroke=\'red\' stroke-width=\'2\'/%3E%3C/svg%3E") 16 16, crosshair';
    } else {
        canvas.style.cursor = 'crosshair';
    }
}
let attackProjectiles = []; // Active naval attack projectiles for world rendering
let slbmContrails = []; // SLBM vapor trails
let explosionEffects = []; // Ship death explosion/debris effects
let animationFrameId = null;
let fogIntervalId = null;
let minimapIntervalId = null;
let fogDirty = true;
let minimapDirty = true;
let interpolationDurationMs = 100;
let lastServerUpdateTime = 0;
let serverTickAvgMs = 100;
let lastMinimapInvalidateTime = 0;
let isPointerInCanvas = false;
let attackTarget = null; // { id, type, name, x, y } - currently designated attack target for HUD display
let commandGroup = new Set(); // Units that have been given commands and should NOT be deselected by panel clicks
const CAMERA_EDGE_PAN_SPEED = 3800;
const FOG_UPDATE_INTERVAL = 650;
const MINIMAP_UPDATE_INTERVAL = 500;
const fogCircleOffsetsCache = new Map();

// --- Fog Offscreen Canvas ---
// fogLayerCanvas is a gridSize횞gridSize pixel canvas drawn once per fog update
// and composited into the scene with a single drawImage, eliminating the
// per-frame viewport loop + template-string GC pressure.
let fogLayerCanvas = null;
let fogLayerCtx   = null;
let fogLayerGridSize = 0;

// Pre-computed alpha strings for 20 discrete fog buckets (0 ??0.5 in 0.025 steps).
// Reusing these strings avoids per-frame template-string allocations.
const _FOG_ALPHA_STRINGS = Object.freeze(
    Array.from({ length: 20 }, (_, i) => `rgba(0,0,0,${(i / 19 * 0.5).toFixed(3)})`)
);

// Reusable array for own-units iteration inside updateFogOfWar (avoids new [] each tick).
const _ownUnitsTemp = [];

const DEFAULT_MAP_IMAGE_PATH = '/assets/maps/world-map.png';
let mapImage = null;
let mapImagePath = null;
let mapImageLoaded = false;
let mapImageLoadFailed = false;
let landMaskCanvas = null;
let landMaskCacheKey = null;
const IMAGE_LAND_MASK_ALPHA = 0.18;
const MINIMAP_VISIBLE_LAND_COLOR = 'rgba(46, 158, 63, 0.9)';

// Battleship images
let battleshipBaseImage = null;
let battleshipBaseLoaded = false;
let mainCannonImage = null;
let mainCannonLoaded = false;

// Submarine image
let submarineImage = null;
let submarineImageLoaded = false;

// Cruiser image
let cruiserImage = null;
let cruiserImageLoaded = false;

// Carrier image
let carrierImage = null;
let carrierImageLoaded = false;

// Frigate image
let frigateImage = null;
let frigateImageLoaded = false;

// Fighter image
let fighterImage = null;
let fighterImageLoaded = false;

// Load battleship images
function loadBattleshipImages() {
    if (!battleshipBaseImage) {
        battleshipBaseImage = new Image();
        battleshipBaseImage.onload = () => {
            battleshipBaseLoaded = true;
            console.log('Battleship base image loaded');
        };
        battleshipBaseImage.onerror = () => {
            console.warn('Failed to load battleshipbase.png');
        };
        battleshipBaseImage.src = '/battleshipbase.png';
    }
    
    if (!mainCannonImage) {
        mainCannonImage = new Image();
        mainCannonImage.onload = () => {
            mainCannonLoaded = true;
            console.log('Main cannon image loaded');
        };
        mainCannonImage.onerror = () => {
            console.warn('Failed to load maincannon.png');
        };
        mainCannonImage.src = '/maincannon.png';
    }
}

function loadSubmarineImage() {
    if (!submarineImage) {
        submarineImage = new Image();
        submarineImage.onload = () => {
            submarineImageLoaded = true;
            console.log('Submarine image loaded');
        };
        submarineImage.onerror = () => {
            console.warn('Failed to load submarine.png');
        };
        submarineImage.src = '/submarine.png';
    }
}

function loadCruiserImage() {
    if (!cruiserImage) {
        cruiserImage = new Image();
        cruiserImage.onload = () => {
            cruiserImageLoaded = true;
            console.log('Cruiser image loaded');
        };
        cruiserImage.onerror = () => {
            console.warn('Failed to load cruiser.png');
        };
        cruiserImage.src = '/cruiser.png';
    }
}

function loadCarrierImage() {
    if (!carrierImage) {
        carrierImage = new Image();
        carrierImage.onload = () => {
            carrierImageLoaded = true;
            console.log('Carrier image loaded');
        };
        carrierImage.onerror = () => {
            console.warn('Failed to load carrier.png');
        };
        carrierImage.src = '/carrier.png';
    }
}

function loadFrigateImage() {
    if (!frigateImage) {
        frigateImage = new Image();
        frigateImage.onload = () => {
            frigateImageLoaded = true;
            console.log('Frigate image loaded');
        };
        frigateImage.onerror = () => {
            console.warn('Failed to load frigate.png');
        };
        frigateImage.src = '/frigate.png';
    }
}

function loadFighterImage() {
    if (!fighterImage) {
        fighterImage = new Image();
        fighterImage.onload = () => {
            fighterImageLoaded = true;
            console.log('Fighter image loaded');
        };
        fighterImage.onerror = () => {
            console.warn('Failed to load fighter.png');
        };
        fighterImage.src = '/fighter.png';
    }
}

// Initialize all ship images on load
loadBattleshipImages();
loadSubmarineImage();
loadCruiserImage();
loadCarrierImage();
loadFrigateImage();
loadFighterImage();
const DEFAULT_BATTLESHIP_BASE_WIDTH = 19;
const DEFAULT_BATTLESHIP_BASE_HEIGHT = 100;
const DEFAULT_MAIN_CANNON_WIDTH = 11;
const DEFAULT_MAIN_CANNON_HEIGHT = 9;
const BATTLESHIP_BASE_HEIGHT_MULTIPLIER = 2.2 * 3;
const BATTLESHIP_TURRET_IMAGE_COORDS = Object.freeze([
    { x: 0.5, y: 15 },
    { x: 0.5, y: 60 },
    { x: 0.5, y: 70 }
]);
const BATTLESHIP_DEFAULT_ATTACK_COOLDOWN_MS = 4800;
const BATTLESHIP_MUZZLE_DIRECTION_SIGN = 1;

function getBattleshipTargetHoldMs(unit) {
    const cooldown = (unit && Number.isFinite(unit.attackCooldownMs) && unit.attackCooldownMs > 0)
        ? unit.attackCooldownMs
        : BATTLESHIP_DEFAULT_ATTACK_COOLDOWN_MS;
    // Keep turret on last fired target for roughly one firing cycle + small network/render slack.
    return Math.min(7000, Math.max(1200, cooldown + 600));
}

function getBattleshipVisualMetrics(size = 60) {
    const originalWidth = (battleshipBaseLoaded && battleshipBaseImage)
        ? battleshipBaseImage.width
        : DEFAULT_BATTLESHIP_BASE_WIDTH;
    const originalHeight = (battleshipBaseLoaded && battleshipBaseImage)
        ? battleshipBaseImage.height
        : DEFAULT_BATTLESHIP_BASE_HEIGHT;
    const aspectRatio = originalWidth / originalHeight;
    const baseHeight = size * BATTLESHIP_BASE_HEIGHT_MULTIPLIER;
    const baseWidth = baseHeight * aspectRatio;
    const imageScaleX = baseWidth / originalWidth;
    const imageScaleY = baseHeight / originalHeight;
    const centerX = originalWidth / 2;
    const centerY = originalHeight / 2;

    const turretInner = BATTLESHIP_TURRET_IMAGE_COORDS.map(pos => ({
        x: (pos.x * originalWidth - centerX) * imageScaleX,
        y: (pos.y - centerY) * imageScaleY
    }));

    const cannonOriginalWidth = (mainCannonLoaded && mainCannonImage)
        ? mainCannonImage.width
        : DEFAULT_MAIN_CANNON_WIDTH;
    const cannonOriginalHeight = (mainCannonLoaded && mainCannonImage)
        ? mainCannonImage.height
        : DEFAULT_MAIN_CANNON_HEIGHT;
    const turretWidth = cannonOriginalWidth * imageScaleX;
    const turretHeight = cannonOriginalHeight * imageScaleY;

    // Cannon sprite points down (+Y). Use the bottom-most opaque pixel row as muzzle direction.
    const muzzleForwardOffset = Math.max(
        imageScaleY,
        ((cannonOriginalHeight - 1) - (cannonOriginalHeight / 2)) * imageScaleY + imageScaleY * 0.35
    );

    return {
        originalWidth,
        originalHeight,
        baseWidth,
        baseHeight,
        imageScaleX,
        imageScaleY,
        turretInner,
        turretWidth,
        turretHeight,
        muzzleForwardOffset
    };
}

function getBattleshipTurretWorldStates(shipX, shipY, shipAngle, size = 60, turretAngles = null) {
    const metrics = getBattleshipVisualMetrics(size);
    const shipRotAngle = shipAngle - Math.PI / 2;
    const cosShip = Math.cos(shipRotAngle);
    const sinShip = Math.sin(shipRotAngle);

    return metrics.turretInner.map((tp, index) => {
        const worldOffX = tp.x * cosShip - tp.y * sinShip;
        const worldOffY = tp.x * sinShip + tp.y * cosShip;
        const centerX = shipX + worldOffX;
        const centerY = shipY + worldOffY;
        const angle = (turretAngles && turretAngles[index] !== undefined)
            ? turretAngles[index]
            : shipAngle;
        const muzzleX = centerX + Math.cos(angle) * metrics.muzzleForwardOffset * BATTLESHIP_MUZZLE_DIRECTION_SIGN;
        const muzzleY = centerY + Math.sin(angle) * metrics.muzzleForwardOffset * BATTLESHIP_MUZZLE_DIRECTION_SIGN;
        return { centerX, centerY, muzzleX, muzzleY, angle };
    });
}

function getBattleshipAimTarget(unit) {
    if (!unit) return null;

    if (unit.attackTargetId) {
        let attackTargetObj = null;
        if (unit.attackTargetType === 'unit') {
            attackTargetObj = gameState.units.get(unit.attackTargetId);
        } else if (unit.attackTargetType === 'building') {
            attackTargetObj = gameState.buildings.get(unit.attackTargetId);
        }
        if (attackTargetObj) {
            const x = (attackTargetObj.interpDisplayX !== undefined) ? attackTargetObj.interpDisplayX : attackTargetObj.x;
            const y = (attackTargetObj.interpDisplayY !== undefined) ? attackTargetObj.interpDisplayY : attackTargetObj.y;
            return { x, y };
        }
    }

    if (
        Number.isFinite(unit.lastTurretTargetX) &&
        Number.isFinite(unit.lastTurretTargetY) &&
        Number.isFinite(unit.lastTurretTargetTime) &&
        (Date.now() - unit.lastTurretTargetTime) <= getBattleshipTargetHoldMs(unit)
    ) {
        return { x: unit.lastTurretTargetX, y: unit.lastTurretTargetY };
    }

    return null;
}

let gameState = {
    userId: null,
    token: null,
    map: null,
    players: new Map(),
    units: new Map(),
    buildings: new Map(),
    fogOfWar: new Map(), // gridKey -> {lastSeen, explored}
    camera: { x: 0, y: 0, zoom: 1 },
    selection: new Set(),
    selectionBox: null,
    buildMode: null,
    workerMode: null, // 'gather' or 'build'
    missiles: 0 // Player's missile count
};

// ==================== SOUND EFFECTS SYSTEM (MP3 Files) ====================
const soundLaunch = new Audio('launchsound.mp3');
const soundBomb = new Audio('bombsound.mp3');
const soundCannon = new Audio('cannonsound.mp3');
soundLaunch.volume = 0.5;
soundBomb.volume = 0.6;
soundCannon.volume = 0.4;

function playSoundLaunch() {
    try {
        soundLaunch.currentTime = 0;
        soundLaunch.play().catch(() => {});
    } catch(e) {}
}

function playSoundBomb() {
    try {
        soundBomb.currentTime = 0;
        soundBomb.play().catch(() => {});
    } catch(e) {}
}

function playSoundCannon() {
    try {
        soundCannon.currentTime = 0;
        soundCannon.play().catch(() => {});
    } catch(e) {}
}
// ==================== END SOUND EFFECTS ====================

// Canvas setup
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const minimap = document.getElementById('minimap');
const minimapCtx = minimap.getContext('2d');

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    minimap.width = 240;
    minimap.height = 240;
    clampCameraToMapBounds();
}

resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function getCanvasPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: clientX - rect.left,
        y: clientY - rect.top
    };
}

function canvasToWorld(canvasX, canvasY) {
    return {
        x: (canvasX - canvas.width / 2) / gameState.camera.zoom + gameState.camera.x,
        y: (canvasY - canvas.height / 2) / gameState.camera.zoom + gameState.camera.y
    };
}

function clampWorldPointToMap(x, y) {
    const map = gameState.map;
    if (!map) {
        return { x, y };
    }
    return {
        x: Math.max(0, Math.min(map.width, x)),
        y: Math.max(0, Math.min(map.height, y))
    };
}

function clampCameraToMapBounds() {
    const map = gameState.map;
    if (!map) return;

    const halfViewWidth = (canvas.width / gameState.camera.zoom) / 2;
    const halfViewHeight = (canvas.height / gameState.camera.zoom) / 2;

    let minX = halfViewWidth;
    let maxX = map.width - halfViewWidth;
    let minY = halfViewHeight;
    let maxY = map.height - halfViewHeight;

    if (minX > maxX) {
        minX = map.width / 2;
        maxX = map.width / 2;
    }
    if (minY > maxY) {
        minY = map.height / 2;
        maxY = map.height / 2;
    }

    gameState.camera.x = Math.max(minX, Math.min(maxX, gameState.camera.x));
    gameState.camera.y = Math.max(minY, Math.min(maxY, gameState.camera.y));
}

function getMapGridSize(map) {
    if (!map) return 0;
    if (Number.isInteger(map.gridSize) && map.gridSize > 0) {
        return map.gridSize;
    }
    if (Array.isArray(map.terrain)) {
        return map.terrain.length;
    }
    return 0;
}

function getMapCellSize(map) {
    if (!map) return 0;
    if (typeof map.cellSize === 'number' && map.cellSize > 0) {
        return map.cellSize;
    }
    const gridSize = getMapGridSize(map);
    if (!gridSize) return 0;
    return map.width / gridSize;
}

function hydrateClientMap(rawMap) {
    if (!rawMap) return null;
    const map = rawMap;

    map.gridSize = getMapGridSize(map);
    map.cellSize = getMapCellSize(map);

    const landCells = Array.isArray(map.landCells) ? map.landCells : [];
    map.landCells = landCells;
    map.landCellSet = new Set();

    if (map.gridSize > 0) {
        for (let i = 0; i < landCells.length; i++) {
            const cell = landCells[i];
            if (!Array.isArray(cell) || cell.length < 2) continue;
            const x = cell[0];
            const y = cell[1];
            if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
            if (x < 0 || y < 0 || x >= map.gridSize || y >= map.gridSize) continue;
            map.landCellSet.add(getFogKey(x, y, map.gridSize));
        }
    }

    return map;
}

function resetMapImageState() {
    mapImage = null;
    mapImagePath = null;
    mapImageLoaded = false;
    mapImageLoadFailed = false;
    landMaskCanvas = null;
    landMaskCacheKey = null;
}

function ensureMapImageLoaded() {
    if (!gameState.map) return;

    const desiredPath = gameState.map.imagePath || DEFAULT_MAP_IMAGE_PATH;
    if (mapImagePath === desiredPath && (mapImageLoaded || mapImageLoadFailed)) {
        return;
    }
    if (mapImagePath === desiredPath && mapImage && !mapImageLoaded && !mapImageLoadFailed) {
        return;
    }

    mapImagePath = desiredPath;
    mapImageLoaded = false;
    mapImageLoadFailed = false;
    mapImage = new Image();
    mapImage.decoding = 'async';
    mapImage.onload = () => {
        mapImageLoaded = true;
        minimapDirty = true;
    };
    mapImage.onerror = () => {
        mapImageLoadFailed = true;
        console.warn(`Map image load failed: ${desiredPath}. Falling back to plain water background.`);
    };
    mapImage.src = desiredPath;
}

function ensureLandMaskLoaded() {
    const map = gameState.map;
    if (!map) return;

    const gridSize = getMapGridSize(map);
    const landCells = Array.isArray(map.landCells) ? map.landCells : [];
    if (!gridSize || landCells.length === 0) return;

    const cacheKey = `${map.width}:${map.height}:${gridSize}:${landCells.length}`;
    if (landMaskCanvas && landMaskCacheKey === cacheKey) {
        return;
    }

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = gridSize;
    maskCanvas.height = gridSize;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.clearRect(0, 0, gridSize, gridSize);
    maskCtx.fillStyle = '#3d5a3d';

    for (let i = 0; i < landCells.length; i++) {
        const cell = landCells[i];
        if (!Array.isArray(cell) || cell.length < 2) continue;
        maskCtx.fillRect(cell[0], cell[1], 1, 1);
    }

    landMaskCanvas = maskCanvas;
    landMaskCacheKey = cacheKey;
}

function buildLandCellSnapshotFromMap(map) {
    if (!map) return null;

    const gridSize = getMapGridSize(map);
    const cellSize = getMapCellSize(map);
    if (!gridSize || !cellSize) return null;

    let landCells = Array.isArray(map.landCells) ? map.landCells : [];
    if (!landCells.length && Array.isArray(map.terrain)) {
        landCells = [];
        for (let y = 0; y < gridSize; y++) {
            for (let x = 0; x < gridSize; x++) {
                if (map.terrain[y][x] === 1) {
                    landCells.push([x, y]);
                }
            }
        }
    }

    return {
        generatedAt: new Date().toISOString(),
        mapWidth: map.width,
        mapHeight: map.height,
        gridSize,
        cellSize,
        imagePath: map.imagePath || DEFAULT_MAP_IMAGE_PATH,
        landCells
    };
}

// Helper: get Korean name for unit type
function getUnitTypeName(type) {
    const names = {
        'worker': '일꾼',
        'destroyer': '구축함',
        'cruiser': '순양함',
        'battleship': '전함',
        'carrier': '항공모함',
        'submarine': '잠수함',
        'aircraft': '함재기',
        'frigate': '호위함'
    };
    return names[type] || type;
}

// Helper: get Korean name for building type
// Helper: get Korean name for building type
function getBuildingTypeName(type) {
    const names = {
        'headquarters': '사령부',
        'shipyard': '조선소',
        'naval_academy': '해군사관학교',
        'power_plant': '발전소',
        'missile_silo': '미사일 격납고'
    };
    return names[type] || type;
}

async function downloadLandCells() {
    let payload = null;

    try {
        const res = await fetch('/api/map/land-cells');
        if (res.ok) {
            payload = await res.json();
        }
    } catch (error) {
        console.warn('Failed to fetch /api/map/land-cells:', error);
    }

    if (!payload) {
        payload = buildLandCellSnapshotFromMap(gameState.map);
    }

    if (!payload) {
        alert('맵 데이터가 아직 없어 땅 좌표를 내보낼 수 없습니다.');
        return;
    }

    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'land-cells.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

window.downloadLandCells = downloadLandCells;

// Mouse state
const mouse = {
    x: 0,
    y: 0,
    worldX: 0,
    worldY: 0,
    down: false,
    button: 0,
    startX: 0,
    startY: 0
};

// Input handling
canvas.addEventListener('mousedown', (e) => {
    isPointerInCanvas = true;
    const canvasPoint = getCanvasPoint(e.clientX, e.clientY);
    const worldPoint = canvasToWorld(canvasPoint.x, canvasPoint.y);

    mouse.down = true;
    mouse.button = e.button;
    mouse.startX = canvasPoint.x;
    mouse.startY = canvasPoint.y;
    
    if (e.button === 0) { // Left click
        const worldX = worldPoint.x;
        const worldY = worldPoint.y;
        
        if (attackMode) {
            // In attack mode, left-click does attack-move to position
            const selectedUnits = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type !== 'worker');
            
            if (selectedUnits.length > 0) {
                // Find target at click position (enemy unit or building)
                let targetId = null;
                let targetType = null;
                let targetName = '';
                
                gameState.units.forEach(unit => {
                    if (unit.userId !== gameState.userId) {
                        const dx = unit.x - worldX;
                        const dy = unit.y - worldY;
                        if (Math.sqrt(dx * dx + dy * dy) < 50) {
                            targetId = unit.id;
                            targetType = 'unit';
                            targetName = getUnitTypeName(unit.type);
                        }
                    }
                });
                
                if (!targetId) {
                    gameState.buildings.forEach(building => {
                        if (building.userId !== gameState.userId) {
                            const dx = building.x - worldX;
                            const dy = building.y - worldY;
                            if (Math.sqrt(dx * dx + dy * dy) < 80) {
                                targetId = building.id;
                                targetType = 'building';
                                targetName = getBuildingTypeName(building.type);
                            }
                        }
                    });
                }
                
                const unitIds = selectedUnits.map(u => u.id);
                // Lock these units into a command group
                unitIds.forEach(id => commandGroup.add(id));
                
                if (targetId) {
                    // Face units toward the attacked target
                    let tgtX = worldX, tgtY = worldY;
                    if (targetType === 'unit')     { const tu = gameState.units.get(targetId);    if (tu) { tgtX = tu.x; tgtY = tu.y; } }
                    else if (targetType === 'building') { const tb = gameState.buildings.get(targetId); if (tb) { tgtX = tb.x; tgtY = tb.y; } }
                    socket.emit('attackTarget', {
                        unitIds: unitIds,
                        targetId: targetId,
                        targetType: targetType
                    });
                    selectedUnits.forEach(u => { u.commandAngle = Math.atan2(tgtY - u.y, tgtX - u.x); });
                    attackTarget = { id: targetId, type: targetType, name: targetName };
                } else {
                    // Attack-move to position
                    socket.emit('attackMove', {
                        unitIds: unitIds,
                        targetX: worldX,
                        targetY: worldY
                    });
                    selectedUnits.forEach(u => { u.commandAngle = Math.atan2(worldY - u.y, worldX - u.x); });
                    attackTarget = null;
                }
            }
            
            setAttackMode(false);
        } else if (slbmTargetingMode) {
            const targetPoint = clampWorldPointToMap(worldX, worldY);
            const selectedSubs = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type === 'submarine');

            for (const sub of selectedSubs) {
                if (gameState.missiles > 0) {
                    socket.emit('submarineSLBM', {
                        submarineId: sub.id,
                        targetX: targetPoint.x,
                        targetY: targetPoint.y
                    });
                } else break;
            }
            slbmTargetingMode = false;
            canvas.style.cursor = 'crosshair';
            document.getElementById('slbmInstructions').style.display = 'none';
        } else if (gameState.buildMode) {
            // Check if workers are selected - workers build directly
            const selectedWorkers = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type === 'worker');
            
            if (selectedWorkers.length > 0) {
                // Workers place and build the building
                socket.emit('workerBuild', {
                    workerIds: selectedWorkers.map(w => w.id),
                    buildingType: gameState.buildMode,
                    x: worldX,
                    y: worldY
                });
            } else {
                // Direct building placement (for non-workers or future features)
                socket.emit('buildBuilding', {
                    type: gameState.buildMode,
                    x: worldX,
                    y: worldY
                });
            }
            
            gameState.buildMode = null;
            canvas.style.cursor = 'crosshair';
        } else {
            // Start selection box
            gameState.selectionBox = { startX: worldX, startY: worldY, endX: worldX, endY: worldY };
        }
    }
});

canvas.addEventListener('mousemove', (e) => {
    const canvasPoint = getCanvasPoint(e.clientX, e.clientY);
    const worldPoint = canvasToWorld(canvasPoint.x, canvasPoint.y);
    mouse.x = canvasPoint.x;
    mouse.y = canvasPoint.y;
    mouse.worldX = worldPoint.x;
    mouse.worldY = worldPoint.y;
    
    if (mouse.down && mouse.button === 0 && gameState.selectionBox) {
        gameState.selectionBox.endX = mouse.worldX;
        gameState.selectionBox.endY = mouse.worldY;
    }
    
    // Pan with middle mouse
    if (mouse.down && mouse.button === 1) {
        const dx = e.movementX / gameState.camera.zoom;
        const dy = e.movementY / gameState.camera.zoom;
        gameState.camera.x -= dx;
        gameState.camera.y -= dy;
        clampCameraToMapBounds();
        minimapDirty = true;
    }
});

canvas.addEventListener('mouseup', (e) => {
    if (e.button === 0 && gameState.selectionBox) {
        // Complete selection
        selectUnits();
        gameState.selectionBox = null;
    } else if (e.button === 2) { // Right click - move or attack-target
        e.preventDefault();
        const canvasPoint = getCanvasPoint(e.clientX, e.clientY);
        const worldPoint = canvasToWorld(canvasPoint.x, canvasPoint.y);
        const worldX = worldPoint.x;
        const worldY = worldPoint.y;
        
        if (gameState.selection.size > 0) {
            const selectedUnits = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId);
            
            if (selectedUnits.length > 0) {
                const unitIds = selectedUnits.map(u => u.id);
                
                if (attackMode) {
                    // Attack mode + right-click: find target at click or attack-move
                    let targetId = null;
                    let targetType = null;
                    let targetName = '';
                    
                    gameState.units.forEach(unit => {
                        if (unit.userId !== gameState.userId) {
                            const dx = unit.x - worldX;
                            const dy = unit.y - worldY;
                            if (Math.sqrt(dx * dx + dy * dy) < 60) {
                                targetId = unit.id;
                                targetType = 'unit';
                                targetName = getUnitTypeName(unit.type);
                            }
                        }
                    });
                    
                    if (!targetId) {
                        gameState.buildings.forEach(building => {
                            if (building.userId !== gameState.userId) {
                                const dx = building.x - worldX;
                                const dy = building.y - worldY;
                                if (Math.sqrt(dx * dx + dy * dy) < 100) {
                                    targetId = building.id;
                                    targetType = 'building';
                                    targetName = getBuildingTypeName(building.type);
                                }
                            }
                        });
                    }
                    
                    // Lock units into command group
                    unitIds.forEach(id => commandGroup.add(id));
                    
                    if (targetId) {
                        let tgtX = worldX, tgtY = worldY;
                        if (targetType === 'unit')     { const tu = gameState.units.get(targetId);    if (tu) { tgtX = tu.x; tgtY = tu.y; } }
                        else if (targetType === 'building') { const tb = gameState.buildings.get(targetId); if (tb) { tgtX = tb.x; tgtY = tb.y; } }
                        socket.emit('attackTarget', {
                            unitIds: unitIds,
                            targetId: targetId,
                            targetType: targetType
                        });
                        selectedUnits.forEach(u => { u.commandAngle = Math.atan2(tgtY - u.y, tgtX - u.x); });
                        attackTarget = { id: targetId, type: targetType, name: targetName };
                    } else {
                        socket.emit('attackMove', {
                            unitIds: unitIds,
                            targetX: worldX,
                            targetY: worldY
                        });
                        selectedUnits.forEach(u => { u.commandAngle = Math.atan2(worldY - u.y, worldX - u.x); });
                        attackTarget = null;
                    }
                    
                    setAttackMode(false);
                } else {
                    // Normal right-click: move
                    unitIds.forEach(id => commandGroup.add(id));
                    socket.emit('moveUnits', {
                        unitIds: unitIds,
                        targetX: worldX,
                        targetY: worldY
                    });
                    selectedUnits.forEach(u => { u.commandAngle = Math.atan2(worldY - u.y, worldX - u.x); });
                    attackTarget = null;
                }
            }
        }
    }
    
    mouse.down = false;
});

canvas.addEventListener('mouseenter', () => {
    isPointerInCanvas = true;
});

canvas.addEventListener('mouseleave', () => {
    isPointerInCanvas = false;
    mouse.down = false;
    mouse.x = canvas.width / 2;
    mouse.y = canvas.height / 2;
});

window.addEventListener('blur', () => {
    isPointerInCanvas = false;
    mouse.down = false;
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Zoom
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    gameState.camera.zoom *= zoomFactor;
    gameState.camera.zoom = Math.max(0.3, Math.min(2, gameState.camera.zoom));
    clampCameraToMapBounds();
    minimapDirty = true;
});

// Keyboard controls
const keys = {};
window.addEventListener('keydown', (e) => {
    keys[e.key] = true;
    
    // Cancel all modes with Escape
    if (e.key === 'Escape') {
        gameState.buildMode = null;
        gameState.workerMode = null;
        slbmTargetingMode = false;
        setAttackMode(false);
    }
    
    // Attack mode - 'a'
    if ((e.key === 'a' || e.key === 'A') && gameState.selection.size > 0) {
        const selectedUnits = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type !== 'worker');
        
        if (selectedUnits.length > 0) {
            setAttackMode(true);
        }
    }
    
    // 기존 자원 채집 기능 제거 - 발전소가 자동으로 에너지 생산
    
    // Worker build hotkey - 'b' (build grid is now always shown in skill panel when workers selected)
    if ((e.key === 'b' || e.key === 'B') && gameState.selection.size > 0) {
        // B key no longer needed to toggle menu, build grid is always visible in skill panel
    }
    
    // Home base hotkey - 'h'
    if (e.key === 'h' || e.key === 'H') {
        const player = gameState.players.get(gameState.userId);
        if (player && player.baseX !== undefined && player.baseY !== undefined) {
            gameState.camera.x = player.baseX;
            gameState.camera.y = player.baseY;
            clampCameraToMapBounds();
            minimapDirty = true;
        }
    }
});

window.addEventListener('keyup', (e) => {
    keys[e.key] = false;
});

// Camera movement with edge panning + arrow keys
function updateCamera(deltaMs) {
    const edgeSize = 32;
    const speed = (CAMERA_EDGE_PAN_SPEED * (deltaMs / 1000)) / gameState.camera.zoom;
    const prevX = gameState.camera.x;
    const prevY = gameState.camera.y;
    
    // Arrow key panning (always active)
    if (keys['ArrowLeft']) gameState.camera.x -= speed;
    if (keys['ArrowRight']) gameState.camera.x += speed;
    if (keys['ArrowUp']) gameState.camera.y -= speed;
    if (keys['ArrowDown']) gameState.camera.y += speed;
    
    // Edge panning (only when pointer in canvas)
    if (isPointerInCanvas) {
        if (mouse.x < edgeSize) gameState.camera.x -= speed;
        if (mouse.x > canvas.width - edgeSize) gameState.camera.x += speed;
        if (mouse.y < edgeSize + 50) gameState.camera.y -= speed; // +50 for HUD
        if (mouse.y > canvas.height - edgeSize) gameState.camera.y += speed;
    }
    
    // Clamp camera so viewport never escapes map bounds.
    clampCameraToMapBounds();
    
    if (Math.abs(gameState.camera.x - prevX) > 0.5 || Math.abs(gameState.camera.y - prevY) > 0.5) {
        minimapDirty = true;
    }
}

function selectUnits() {
    const box = gameState.selectionBox;
    const minX = Math.min(box.startX, box.endX);
    const maxX = Math.max(box.startX, box.endX);
    const minY = Math.min(box.startY, box.endY);
    const maxY = Math.max(box.startY, box.endY);
    
    // Check if this is a click (small box) vs drag selection
    const isClick = Math.abs(box.endX - box.startX) < 10 && Math.abs(box.endY - box.startY) < 10;
    const clickX = (box.startX + box.endX) / 2;
    const clickY = (box.startY + box.endY) / 2;
    
    // If click lands on a building, check if we should preserve current unit selection
    if (isClick) {
        let clickedBuilding = null;
        gameState.buildings.forEach((building, buildingId) => {
            if (building.userId === gameState.userId) {
                const buildingSize = 100;
                if (clickX >= building.x - buildingSize && clickX <= building.x + buildingSize &&
                    clickY >= building.y - buildingSize && clickY <= building.y + buildingSize) {
                    clickedBuilding = buildingId;
                }
            }
        });
        
        // If we clicked a building and have units with active commands, 
        // just focus the building for production UI without deselecting units
        if (clickedBuilding !== null) {
            // Store previous unit selection for command persistence
            const prevUnitSelection = new Set();
            gameState.selection.forEach(id => {
                if (gameState.units.has(id)) prevUnitSelection.add(id);
            });
            
            gameState.selection.clear();
            gameState.selection.add(clickedBuilding);
            
            // Keep units with active commands in commandGroup (they won't be deselected server-side)
            // The commandGroup ensures their orders persist
            
            updateSelectionInfo();
            return;
        }
    }
    
    // Normal selection - clear everything
    gameState.selection.clear();
    commandGroup.clear(); // New selection clears command persistence
    attackTarget = null;
    
    // Select units
    gameState.units.forEach((unit, unitId) => {
        if (unit.userId === gameState.userId) {
            const unitSize = unit.type === 'worker' ? 40 : 60;
            if (isClick) {
                const dx = clickX - unit.x;
                const dy = clickY - unit.y;
                if (Math.sqrt(dx * dx + dy * dy) <= unitSize) {
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
    
    // Select buildings (if no units selected)
    if (gameState.selection.size === 0) {
        gameState.buildings.forEach((building, buildingId) => {
            if (building.userId === gameState.userId) {
                const buildingSize = 100;
                if (isClick) {
                    if (clickX >= building.x - buildingSize && clickX <= building.x + buildingSize &&
                        clickY >= building.y - buildingSize && clickY <= building.y + buildingSize) {
                        gameState.selection.add(buildingId);
                    }
                } else {
                    if (building.x + buildingSize >= minX && building.x - buildingSize <= maxX &&
                        building.y + buildingSize >= minY && building.y - buildingSize <= maxY) {
                        gameState.selection.add(buildingId);
                    }
                }
            }
        });
    }
    
    updateSelectionInfo();
}

function updateSelectionInfo() {
    const selectionInfo = document.getElementById('selectionInfo');
    const workerBuildMenu = document.getElementById('workerBuildMenu');
    const bottomPanel = document.getElementById('bottomPanel');
    
    // Hide all panels first
    workerBuildMenu.classList.remove('active');
    workerBuildMenu.style.display = 'none';
    selectionInfo.classList.remove('active');
    bottomPanel.classList.remove('active');
    
    // Hide skill/production slots
    document.getElementById('skillSlot1').style.display = 'none';
    document.getElementById('skillSlot2').style.display = 'none';
    document.getElementById('skillSlot3').style.display = 'none';
    document.getElementById('skillSlot4').style.display = 'none';
    document.getElementById('skillSlot5').style.display = 'none';
    document.getElementById('productionQueueDisplay').style.display = 'none';
    document.getElementById('slbmProgressBar').style.display = 'none';
    document.getElementById('aircraftProgressBar').style.display = 'none';
    
    // Clear production buttons when hiding production display
    const btnContainer = document.getElementById('productionButtons');
    btnContainer.innerHTML = '';
    btnContainer.removeAttribute('data-building-type');
    
    if (gameState.selection.size === 0) {
        // Remove worker build grid if exists when nothing is selected
        const oldBuildGrid = document.getElementById('workerBuildGrid');
        if (oldBuildGrid) oldBuildGrid.remove();
        return;
    }
    
    // Check if buildings are selected
    const selectedBuildings = Array.from(gameState.selection)
        .map(id => gameState.buildings.get(id))
        .filter(b => b !== undefined);
    
    if (selectedBuildings.length > 0) {
        const building = selectedBuildings[0];
        const buildingTypeNames = {
            'headquarters': '사령부',
            'shipyard': '조선소',
            'naval_academy': '해군사관학교',
            'power_plant': '발전소',
            'missile_silo': '미사일 격납고',
            'defense_tower': '방어 타워',
            'research_lab': '연구소'
        };
        
        // Show bottom panel for building stats
        bottomPanel.classList.add('active');
        if (building.type === 'defense_tower') {
            document.getElementById('statDamage').textContent = '26';
            document.getElementById('statRange').textContent = '2500';
        } else {
            document.getElementById('statDamage').textContent = '-';
            document.getElementById('statRange').textContent = '-';
        }
        document.getElementById('statHp').textContent = `${building.hp || 0} / ${building.maxHp || 0}`;
        document.getElementById('statKills').textContent = '-';
        document.getElementById('targetLabel').textContent = buildingTypeNames[building.type] || building.type;
        
        // Show production UI in skill panel for production buildings
        if ((building.type === 'headquarters' || building.type === 'shipyard' || building.type === 'naval_academy') && building.userId === gameState.userId) {
            const prodDisplay = document.getElementById('productionQueueDisplay');
            prodDisplay.style.display = 'block';
            
            const allowedUnits = {
                'headquarters': ['worker'],
                'shipyard': ['destroyer', 'cruiser', 'frigate'],
                'naval_academy': ['battleship', 'carrier', 'submarine']
            };
            const allowed = allowedUnits[building.type] || [];
            const unitIcons = { worker: '👷', destroyer: '🚢', cruiser: '⛴️', battleship: '🛳️', carrier: '🛫', submarine: '🔱', frigate: '⚔️' };
            const unitNames = { worker: '일꾼', destroyer: '구축함', cruiser: '순양함', battleship: '전함', carrier: '항공모함', submarine: '잠수함', frigate: '호위함' };
            const unitCosts = { worker: 50, destroyer: 150, cruiser: 300, battleship: 600, carrier: 800, submarine: 900, frigate: 120 };
            const unitPops = { worker: 1, destroyer: 2, cruiser: 3, battleship: 5, carrier: 6, submarine: 4, frigate: 1 };
            
            // Production buttons
            const btnContainer = document.getElementById('productionButtons');
            const player = gameState.players.get(gameState.userId);
            const queueLen = (building.productionQueue || []).length;
            
            // Check if we need to recreate buttons (building type changed or first time)
            const currentBuildingType = btnContainer.getAttribute('data-building-type');
            if (currentBuildingType !== building.type) {
                btnContainer.innerHTML = '';
                btnContainer.setAttribute('data-building-type', building.type);
            }
            
            // Only create buttons if they don't exist
            if (btnContainer.children.length === 0) {
                btnContainer.innerHTML = allowed.map(uType => {
                    const cost = unitCosts[uType];
                    return `<button class="prod-btn" data-type="${uType}" data-building="${building.id}">${unitNames[uType]}<br><span style="font-size:9px">${cost}</span></button>`;
                }).join('');
                
                // Add click handlers (only once)
                btnContainer.querySelectorAll('.prod-btn').forEach(btn => {
                    btn.onclick = () => {
                        if (btn.classList.contains('disabled')) return;
                        socket.emit('buildUnit', { buildingId: building.id, unitType: btn.getAttribute('data-type') });
                    };
                });
            }
            
            // Update button states
            btnContainer.querySelectorAll('.prod-btn').forEach(btn => {
                const uType = btn.getAttribute('data-type');
                const cost = unitCosts[uType];
                const pop = unitPops[uType];
                const canAfford = player && player.resources >= cost && player.population + pop <= player.maxPopulation;
                const queueFull = queueLen >= 10;
                const shouldDisable = !canAfford || queueFull || building.buildProgress < 100;
                
                if (shouldDisable) {
                    btn.classList.add('disabled');
                } else {
                    btn.classList.remove('disabled');
                }
                btn.title = `${unitNames[uType]} (비용: ${cost}, 인구: ${pop})`;
            });
            
            // Queue icons
            const queueContainer = document.getElementById('productionQueueIcons');
            const queue = building.productionQueue || [];
            queueContainer.innerHTML = queue.map((item, idx) => {
                const icon = unitIcons[item.unitType] || '?';
                const isFirst = idx === 0;
                return `<span style="display:inline-block;width:24px;height:24px;text-align:center;line-height:24px;background:${isFirst ? 'rgba(79,195,247,0.3)' : 'rgba(255,255,255,0.1)'};border:1px solid ${isFirst ? '#4fc3f7' : '#555'};border-radius:3px;font-size:14px;" title="${unitNames[item.unitType]}">${icon}</span>`;
            }).join('');
            
            // Production progress
            const progContainer = document.getElementById('productionProgressInline');
            if (building.producing) {
                progContainer.style.display = 'block';
                const elapsed = Date.now() - building.producing.startTime;
                const progress = Math.min(1, elapsed / building.producing.buildTime);
                const producingName = unitNames[building.producing.unitType] || building.producing.unitType;
                document.getElementById('productionLabelInline').textContent = `${producingName} 생산 중... ${Math.floor(progress * 100)}%`;
                document.getElementById('productionFillInline').style.width = `${Math.floor(progress * 100)}%`;
            } else {
                progContainer.style.display = 'none';
            }
        }
        
        // Missile production for missile silo (queue-based)
        if (building.type === 'missile_silo' && building.buildProgress >= 100 && building.userId === gameState.userId) {
            const missileQueue = building.missileQueue || [];
            const queueFull = missileQueue.length >= 10;
            const player = gameState.players.get(gameState.userId);
            
            const slot2 = document.getElementById('skillSlot2');
            slot2.style.display = 'flex';
            document.getElementById('skillBtn2').textContent = '🔧 미사일 제작';
            document.getElementById('skillBtn2').className = 'skill-btn skill-purple' + ((!player || player.resources < 1500 || queueFull) ? ' disabled' : '');
            document.getElementById('skillDesc2').textContent = `에너지 1500 / 45초 (보유: ${gameState.missiles || 0}) [대기열: ${missileQueue.length}/10]`;
            document.getElementById('skillDesc2').className = 'skill-desc desc-purple';

            // Show missile queue icons and progress
            const slbmBar = document.getElementById('slbmProgressBar');
            slbmBar.style.display = 'block';
            let queueIconsHtml = missileQueue.map((item, idx) => {
                const isFirst = idx === 0;
                return `<span style="display:inline-block;width:24px;height:24px;text-align:center;line-height:24px;background:${isFirst ? 'rgba(206,147,216,0.3)' : 'rgba(255,255,255,0.1)'};border:1px solid ${isFirst ? '#ce93d8' : '#555'};border-radius:3px;font-size:14px;" title="미사일 생산">🚀</span>`;
            }).join('');
            
            if (building.missileProducing) {
                const elapsed = Date.now() - building.missileProducing.startTime;
                const progress = Math.min(1, elapsed / building.missileProducing.buildTime);
                document.getElementById('slbmProgressLabel').innerHTML = `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">${queueIconsHtml}</div>미사일 생산 중... ${Math.floor(progress * 100)}%`;
                document.getElementById('slbmProgressFill').style.width = `${Math.floor(progress * 100)}%`;
            } else {
                document.getElementById('slbmProgressLabel').innerHTML = queueIconsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">${queueIconsHtml}</div>` : '';
                document.getElementById('slbmProgressFill').style.width = '0%';
            }
        }
        
        // Multi-building info
        if (selectedBuildings.length > 1) {
            let html = `<div><strong>선택된 건물: ${selectedBuildings.length}</strong></div>`;
            selectionInfo.innerHTML = html;
            selectionInfo.classList.add('active');
        }
        return;
    }
    
    const selectedUnits = Array.from(gameState.selection).map(id => gameState.units.get(id)).filter(u => u !== undefined);
    
    if (selectedUnits.length === 0) {
        // Remove worker build grid if exists when no units selected
        const oldBuildGrid = document.getElementById('workerBuildGrid');
        if (oldBuildGrid) oldBuildGrid.remove();
        return;
    }
    
    // Check if workers are selected - show build buttons in skill panel
    const hasWorkers = selectedUnits.some(u => u.type === 'worker' && u.userId === gameState.userId);
    
    // Remove worker build grid if workers are not selected
    if (!hasWorkers) {
        const oldBuildGrid = document.getElementById('workerBuildGrid');
        if (oldBuildGrid) oldBuildGrid.remove();
    }
    
    if (hasWorkers) {
        // Mark workerBuildMenu as active (hidden div, used as flag)
        workerBuildMenu.classList.add('active');
        workerBuildMenu.style.display = 'none';
        
        const player = gameState.players.get(gameState.userId);
        const buildData = [
            { type: 'shipyard', name: '조선소', cost: 200, desc: '인구+5' },
            { type: 'power_plant', name: '발전소', cost: 150, desc: '인구+3' },
            { type: 'defense_tower', name: '방어 타워', cost: 250, desc: '' },
            { type: 'naval_academy', name: '해군 사관학교', cost: 300, desc: '인구+10' },
            { type: 'research_lab', name: '연구소', cost: 500, desc: '' },
            { type: 'missile_silo', name: '미사일 격납고', cost: 800, desc: '' }
        ];
        
        const skillsPanel = document.getElementById('unitSkills');
        let buildContainer = document.getElementById('workerBuildGrid');
        
        // Only create buttons if they don't exist
        if (!buildContainer) {
            buildContainer = document.createElement('div');
            buildContainer.id = 'workerBuildGrid';
            buildContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
            buildContainer.innerHTML = buildData.map(b => {
                const descText = b.desc ? ` (${b.desc})` : '';
                return `<button class="build-btn" data-type="${b.type}" data-cost="${b.cost}" style="width:calc(50% - 3px);padding:8px 4px;margin-bottom:0;font-size:12px;">${b.name}<br><small>${b.cost} 에너지${descText}</small></button>`;
            }).join('');
            skillsPanel.appendChild(buildContainer);
            
            // Click handlers for build buttons (attach once)
            buildContainer.querySelectorAll('.build-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (btn.classList.contains('disabled')) return;
                    const buildingType = btn.getAttribute('data-type');
                    const selectedWorkers = Array.from(gameState.selection)
                        .map(id => gameState.units.get(id))
                        .filter(u => u && u.userId === gameState.userId && u.type === 'worker');
                    if (selectedWorkers.length > 0) {
                        gameState.buildMode = buildingType;
                        canvas.style.cursor = 'pointer';
                    }
                });
            });
        }
        
        // Update button states
        buildContainer.querySelectorAll('.build-btn').forEach(btn => {
            const cost = parseInt(btn.getAttribute('data-cost'));
            const canAfford = player && player.resources >= cost;
            if (canAfford) {
                btn.classList.remove('disabled');
            } else {
                btn.classList.add('disabled');
            }
        });
    }
    
    // Show bottom panel for unit stats
    bottomPanel.classList.add('active');
    
    if (selectedUnits.length === 1) {
        // Single unit selected - show detailed stats
        const unit = selectedUnits[0];
        document.getElementById('statDamage').textContent = unit.type === 'carrier' ? '함재기' : (unit.aimedShot ? `${(unit.damage || 0) * 2} (조준)` : (unit.damage || 0));
        document.getElementById('statRange').textContent = unit.aimedShot ? `${(unit.attackRange || 0) * 2} (조준)` : (unit.attackRange || 0);
        document.getElementById('statHp').textContent = `${unit.hp || 0} / ${unit.maxHp || 0}`;
        document.getElementById('statKills').textContent = unit.kills || 0;
        
        // Target info
        if (attackTarget) {
            document.getElementById('targetLabel').textContent = `🎯 ${attackTarget.name}`;
        } else {
            document.getElementById('targetLabel').textContent = `${getUnitTypeName(unit.type)}`;
        }
        
        // Skill slots for submarine
        if (unit.type === 'submarine') {
            const slot1 = document.getElementById('skillSlot1');
            slot1.style.display = 'flex';
            document.getElementById('skillBtn1').textContent = '🚀 미사일 발사';
            document.getElementById('skillBtn1').className = 'skill-btn';
            document.getElementById('skillDesc1').textContent = `핵미사일 발사 - 반경 800 범위 피해 (보유: ${gameState.missiles || 0})`;
            document.getElementById('skillDesc1').className = 'skill-desc';
        }
        
        // Battleship aimed shot skill
        if (unit.type === 'battleship' && unit.userId === gameState.userId) {
            const slot5 = document.getElementById('skillSlot5');
            slot5.style.display = 'flex';
            const isActive = unit.aimedShot ? true : false;
            const now = Date.now();
            const onCooldown = unit.aimedShotCooldownUntil && now < unit.aimedShotCooldownUntil;
            const cdRemain = onCooldown ? Math.ceil((unit.aimedShotCooldownUntil - now) / 1000) : 0;
            if (isActive) {
                document.getElementById('skillBtn5').textContent = '🎯 조준 사격 (활성)';
                document.getElementById('skillBtn5').className = 'skill-btn skill-active';
                document.getElementById('skillDesc5').textContent = '다음 공격 시 사거리·데미지·시야 2배 (활성화됨)';
            } else if (onCooldown) {
                document.getElementById('skillBtn5').textContent = `🎯 조준 사격 (${cdRemain}초)`;
                document.getElementById('skillBtn5').className = 'skill-btn skill-cooldown';
                document.getElementById('skillDesc5').textContent = `쿨타임 ${cdRemain}초 남음`;
            } else {
                document.getElementById('skillBtn5').textContent = '🎯 조준 사격';
                document.getElementById('skillBtn5').className = 'skill-btn';
                document.getElementById('skillDesc5').textContent = '다음 한 번의 공격 사거리·데미지·시야 2배 (쿨타임 16초)';
            }
        }
        
        // Carrier skills
        if (unit.type === 'carrier' && unit.userId === gameState.userId) {
            const acCount = (unit.aircraft || []).length;
            const deployedCount = (unit.aircraftDeployed || []).length;
            const acQueue = unit.aircraftQueue || [];
            const totalAc = acCount + deployedCount + acQueue.length;
            const player = gameState.players.get(gameState.userId);
            const queueFull = acQueue.length >= 10 || totalAc >= 10;
            
            // Produce aircraft button
            const slot3 = document.getElementById('skillSlot3');
            slot3.style.display = 'flex';
            document.getElementById('skillBtn3').textContent = '✈️ 함재기 제작';
            document.getElementById('skillBtn3').className = 'skill-btn' + ((!player || player.resources < 100 || queueFull) ? ' disabled' : '');
            document.getElementById('skillDesc3').textContent = `에너지 100 / 15초 (보유: ${acCount} / 발진: ${deployedCount} / 최대 10) [대기열: ${acQueue.length}]`;
            
            // Deploy aircraft button
            const slot4 = document.getElementById('skillSlot4');
            slot4.style.display = 'flex';
            document.getElementById('skillBtn4').textContent = '🛩️ 함재기 발진';
            document.getElementById('skillDesc4').textContent = `보유한 함재기를 발진시킵니다 (${acCount}기 대기중)`;
            
            // Show aircraft production progress
            if (unit.producingAircraft || acQueue.length > 0) {
                const acBar = document.getElementById('aircraftProgressBar');
                acBar.style.display = 'block';
                let queueIconsHtml = acQueue.map((item, idx) => {
                    const isFirst = idx === 0;
                    return `<span style="display:inline-block;width:24px;height:24px;text-align:center;line-height:24px;background:${isFirst ? 'rgba(129,212,250,0.3)' : 'rgba(255,255,255,0.1)'};border:1px solid ${isFirst ? '#81d4fa' : '#555'};border-radius:3px;font-size:14px;" title="함재기">✈️</span>`;
                }).join('');
                
                if (unit.producingAircraft) {
                    const elapsed = Date.now() - unit.producingAircraft.startTime;
                    const progress = Math.min(1, elapsed / unit.producingAircraft.buildTime);
                    document.getElementById('aircraftProgressLabel').innerHTML = `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">${queueIconsHtml}</div>함재기 제작 중... ${Math.floor(progress * 100)}%`;
                    document.getElementById('aircraftProgressFill').style.width = `${Math.floor(progress * 100)}%`;
                } else {
                    document.getElementById('aircraftProgressLabel').innerHTML = queueIconsHtml ? `<div style="display:flex;gap:4px;flex-wrap:wrap;">${queueIconsHtml}</div>` : '';
                    document.getElementById('aircraftProgressFill').style.width = '0%';
                }
            }
        }
    } else {
        // Multiple units selected - show summary stats
        // Priority order by cost: submarine(900) > carrier(800) > battleship(600) > cruiser(300) > destroyer(150) > worker(50)
        const unitCostPriority = { submarine: 900, carrier: 800, battleship: 600, cruiser: 300, destroyer: 150, frigate: 120, worker: 50, aircraft: 100 };
        const sortedUnits = [...selectedUnits].sort((a, b) => (unitCostPriority[b.type] || 0) - (unitCostPriority[a.type] || 0));
        const primaryUnit = sortedUnits[0];
        
        const totalDamage = selectedUnits.reduce((sum, u) => sum + (u.type === 'carrier' ? 0 : (u.damage || 0)), 0);
        const avgRange = Math.round(selectedUnits.reduce((sum, u) => sum + (u.attackRange || 0), 0) / selectedUnits.length);
        const totalHp = selectedUnits.reduce((sum, u) => sum + (u.hp || 0), 0);
        const totalMaxHp = selectedUnits.reduce((sum, u) => sum + (u.maxHp || 0), 0);
        const totalKills = selectedUnits.reduce((sum, u) => sum + (u.kills || 0), 0);
        
        document.getElementById('statDamage').textContent = totalDamage;
        document.getElementById('statRange').textContent = avgRange;
        document.getElementById('statHp').textContent = `${totalHp} / ${totalMaxHp}`;
        document.getElementById('statKills').textContent = totalKills;
        document.getElementById('targetLabel').textContent = attackTarget ? `🎯 ${attackTarget.name}` : getUnitTypeName(primaryUnit.type) + ` 외 ${selectedUnits.length - 1}`;
        
        // Show skills based on what types are present (priority order)
        const hasTypes = new Set(selectedUnits.map(u => u.type));
        
        // Missile button if subs are among selected
        if (hasTypes.has('submarine')) {
            const slot1 = document.getElementById('skillSlot1');
            slot1.style.display = 'flex';
            document.getElementById('skillBtn1').textContent = '🚀 미사일 발사';
            document.getElementById('skillBtn1').className = 'skill-btn';
            document.getElementById('skillDesc1').textContent = `핵미사일 발사 - 반경 800 범위 피해 (보유: ${gameState.missiles || 0})`;
            document.getElementById('skillDesc1').className = 'skill-desc';
        }
        
        // Battleship aimed shot if battleships are among selected
        if (hasTypes.has('battleship')) {
            const slot5 = document.getElementById('skillSlot5');
            slot5.style.display = 'flex';
            const anyActive = selectedUnits.some(u => u.type === 'battleship' && u.aimedShot);
            const now = Date.now();
            const anyCooldown = selectedUnits.some(u => u.type === 'battleship' && u.aimedShotCooldownUntil && now < u.aimedShotCooldownUntil);
            if (anyActive) {
                document.getElementById('skillBtn5').textContent = '🎯 조준 사격 (활성)';
                document.getElementById('skillBtn5').className = 'skill-btn skill-active';
            } else if (anyCooldown) {
                document.getElementById('skillBtn5').textContent = '🎯 조준 사격 (쿨타임)';
                document.getElementById('skillBtn5').className = 'skill-btn skill-cooldown';
            } else {
                document.getElementById('skillBtn5').textContent = '🎯 조준 사격';
                document.getElementById('skillBtn5').className = 'skill-btn';
            }
            document.getElementById('skillDesc5').textContent = '선택된 전함들의 다음 공격 사거리·데미지·시야 2배 (쿨타임 16초)';
        }
        
        // Carrier skills if carriers are among selected
        if (hasTypes.has('carrier')) {
            const carriers = selectedUnits.filter(u => u.type === 'carrier' && u.userId === gameState.userId);
            if (carriers.length > 0) {
                const firstCarrier = carriers[0];
                const acCount = (firstCarrier.aircraft || []).length;
                const deployedCount = (firstCarrier.aircraftDeployed || []).length;
                const acQueueLen = (firstCarrier.aircraftQueue || []).length;
                
                const slot3 = document.getElementById('skillSlot3');
                slot3.style.display = 'flex';
                document.getElementById('skillBtn3').textContent = '✈️ 함재기 제작';
                document.getElementById('skillDesc3').textContent = `에너지 100 / 15초 (보유: ${acCount} / 발진: ${deployedCount} / 최대 10) [대기열: ${acQueueLen}]`;
                
                const slot4 = document.getElementById('skillSlot4');
                slot4.style.display = 'flex';
                document.getElementById('skillBtn4').textContent = '🛩️ 함재기 발진';
                document.getElementById('skillDesc4').textContent = `보유한 함재기를 발진시킵니다 (${acCount}기 대기중)`;
            }
        }
        
// Multi-unit type summary (sorted by priority)
        const typesByPriority = [...hasTypes].sort((a, b) => (unitCostPriority[b] || 0) - (unitCostPriority[a] || 0));
        let html = `<div><strong>선택된 유닛: ${selectedUnits.length}</strong></div>`;
        typesByPriority.forEach(type => {
            const count = selectedUnits.filter(u => u.type === type).length;
            html += `<div>${getUnitTypeName(type)}: ${count}</div>`;
        });
        selectionInfo.innerHTML = html;
        selectionInfo.classList.add('active');
    }
}

// Rendering
function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (gameState.map) {
        clampCameraToMapBounds();
    }
    
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(gameState.camera.zoom, gameState.camera.zoom);
    ctx.translate(-gameState.camera.x, -gameState.camera.y);
    
    if (gameState.map) {
        renderMap();
        renderResources();
        renderBuildings();
        renderUnits();
        renderContrails();
        renderProjectiles();
        renderFogOfWar();
    }
    
    // Selection box
    if (gameState.selectionBox) {
        const box = gameState.selectionBox;
        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 2 / gameState.camera.zoom;
        ctx.strokeRect(
            Math.min(box.startX, box.endX),
            Math.min(box.startY, box.endY),
            Math.abs(box.endX - box.startX),
            Math.abs(box.endY - box.startY)
        );
    }
    
    // SLBM targeting reticle
    if (slbmTargetingMode) {
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 3 / gameState.camera.zoom;
        ctx.beginPath();
        ctx.arc(mouse.worldX, mouse.worldY, 800, 0, Math.PI * 2);
        ctx.stroke();
        
        // Crosshair
        ctx.beginPath();
        ctx.moveTo(mouse.worldX - 100, mouse.worldY);
        ctx.lineTo(mouse.worldX + 100, mouse.worldY);
        ctx.moveTo(mouse.worldX, mouse.worldY - 100);
        ctx.lineTo(mouse.worldX, mouse.worldY + 100);
        ctx.stroke();
    }
    
    ctx.restore();
    
    // Minimap rendering moved to separate interval for performance
}

function renderFogOfWar() {
    // PERF: Replaced per-frame viewport loop (O(cells) + template-string GC) with
    // a single drawImage of the pre-rendered fogLayerCanvas (updated at ~1.5 Hz).
    // Visual result is identical: unexplored = 0.85-alpha black, explored-but-stale
    // = 0-0.5 alpha overlay, currently-visible = fully transparent.
    if (!fogLayerCanvas) return;
    const map = gameState.map;
    if (!map) return;

    const prevSmoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false; // Pixelated cells match original fillRect look
    ctx.drawImage(fogLayerCanvas, 0, 0, map.width, map.height);
    ctx.imageSmoothingEnabled = prevSmoothing;
}

function renderMap() {
    const map = gameState.map;
    if (!map) {
        console.warn('Map not available');
        return;
    }

    ensureMapImageLoaded();
    ensureLandMaskLoaded();

    const camera = gameState.camera;
    const viewWidth = canvas.width / camera.zoom;
    const viewHeight = canvas.height / camera.zoom;
    const left = Math.max(0, camera.x - viewWidth / 2);
    const top = Math.max(0, camera.y - viewHeight / 2);
    const right = Math.min(map.width, camera.x + viewWidth / 2);
    const bottom = Math.min(map.height, camera.y + viewHeight / 2);
    const drawWidth = right - left;
    const drawHeight = bottom - top;
    
    if (drawWidth <= 0 || drawHeight <= 0) {
        return;
    }

    if (mapImageLoaded && mapImage && !mapImageLoadFailed) {
        const sx = (left / map.width) * mapImage.naturalWidth;
        const sy = (top / map.height) * mapImage.naturalHeight;
        const sw = (drawWidth / map.width) * mapImage.naturalWidth;
        const sh = (drawHeight / map.height) * mapImage.naturalHeight;
        ctx.drawImage(mapImage, sx, sy, sw, sh, left, top, drawWidth, drawHeight);
        if (landMaskCanvas) {
            const gridSize = landMaskCanvas.width;
            const msx = (left / map.width) * gridSize;
            const msy = (top / map.height) * gridSize;
            const msw = (drawWidth / map.width) * gridSize;
            const msh = (drawHeight / map.height) * gridSize;
            ctx.save();
            ctx.globalAlpha = IMAGE_LAND_MASK_ALPHA;
            ctx.drawImage(landMaskCanvas, msx, msy, msw, msh, left, top, drawWidth, drawHeight);
            ctx.restore();
        }
    } else {
        // Fallback background while image is loading or unavailable.
        ctx.fillStyle = '#1a3a5c';
        ctx.fillRect(left, top, drawWidth, drawHeight);
        if (landMaskCanvas) {
            const gridSize = landMaskCanvas.width;
            const msx = (left / map.width) * gridSize;
            const msy = (top / map.height) * gridSize;
            const msw = (drawWidth / map.width) * gridSize;
            const msh = (drawHeight / map.height) * gridSize;
            ctx.drawImage(landMaskCanvas, msx, msy, msw, msh, left, top, drawWidth, drawHeight);
        }
        if (mapImageLoadFailed) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.font = '48px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Map Image Missing', map.width / 2, map.height / 2);
        }
    }
}

function renderResources() {
    // 자원 노드 시각화 비활성화 (요청 반영)
    // 자원은 사전에 존재하고 일꾼은 채집 불가
    return;
}

function getViewportBounds(padding = 0) {
    const viewWidth = canvas.width / gameState.camera.zoom;
    const viewHeight = canvas.height / gameState.camera.zoom;
    return {
        left: gameState.camera.x - viewWidth / 2 - padding,
        right: gameState.camera.x + viewWidth / 2 + padding,
        top: gameState.camera.y - viewHeight / 2 - padding,
        bottom: gameState.camera.y + viewHeight / 2 + padding
    };
}

function isInViewport(x, y, padding = 0) {
    const bounds = getViewportBounds(padding);
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function getFogKey(x, y, gridSize) {
    return (y * gridSize) + x;
}

function getFogCircleOffsets(gridRadius) {
    let cached = fogCircleOffsetsCache.get(gridRadius);
    if (cached) {
        return cached;
    }

    const offsets = [];
    const r2 = gridRadius * gridRadius;
    for (let dx = -gridRadius; dx <= gridRadius; dx++) {
        for (let dy = -gridRadius; dy <= gridRadius; dy++) {
            if ((dx * dx) + (dy * dy) <= r2) {
                offsets.push([dx, dy]);
            }
        }
    }

    fogCircleOffsetsCache.set(gridRadius, offsets);
    return offsets;
}

function revealFogArea(gridX, gridY, gridSize, offsets, now) {
    for (let i = 0; i < offsets.length; i++) {
        const dx = offsets[i][0];
        const dy = offsets[i][1];
        const checkX = gridX + dx;
        const checkY = gridY + dy;

        if (checkX < 0 || checkX >= gridSize || checkY < 0 || checkY >= gridSize) {
            continue;
        }

        const key = getFogKey(checkX, checkY, gridSize);
        const existing = gameState.fogOfWar.get(key);
        if (existing) {
            existing.lastSeen = now;
            existing.explored = true;
        } else {
            gameState.fogOfWar.set(key, { lastSeen: now, explored: true });
        }
    }
}

// ---- Fog offscreen canvas helpers ----

/**
 * Lazily creates (or re-creates on grid-size change) the off-screen fog canvas.
 * One pixel = one grid cell; scaled to map world-size in renderFogOfWar.
 */
function ensureFogLayerCanvas(gridSize) {
    if (fogLayerCanvas && fogLayerGridSize === gridSize) return;
    fogLayerCanvas = document.createElement('canvas');
    fogLayerCanvas.width  = gridSize;
    fogLayerCanvas.height = gridSize;
    fogLayerCtx   = fogLayerCanvas.getContext('2d');
    fogLayerGridSize = gridSize;
    // Fill as fully unexplored on creation so the very first frame looks correct.
    fogLayerCtx.fillStyle = 'rgba(0,0,0,0.85)';
    fogLayerCtx.fillRect(0, 0, gridSize, gridSize);
}

/**
 * Redraws the entire fogLayerCanvas to reflect the current fog state.
 * Called once per updateFogOfWar() tick (??.5 Hz), NOT every rAF frame.
 * Algorithm (visual result = identical to original renderFogOfWar):
 *   1. Fill everything with 0.85-alpha black  (unexplored)
 *   2. destination-out erase every explored cell   (make transparent)
 *   3. source-over draw stale-explored cells with 0??.5 alpha gradual overlay
 */
function refreshFogLayer(gridSize, now) {
    if (!fogLayerCtx) return;
    const fctx = fogLayerCtx;

    // Step 1 ??paint whole canvas as unexplored (opaque fog)
    fctx.globalCompositeOperation = 'source-over';
    fctx.fillStyle = 'rgba(0,0,0,0.85)';
    fctx.fillRect(0, 0, gridSize, gridSize);

    // Step 2 ??punch out all explored cells so they're transparent
    fctx.globalCompositeOperation = 'destination-out';
    fctx.fillStyle = '#000';
    gameState.fogOfWar.forEach((fogInfo, key) => {
        if (!fogInfo.explored) return;
        const x = key % gridSize;
        const y = (key / gridSize) | 0;
        fctx.fillRect(x, y, 1, 1);
    });

    // Step 3 ??re-add semi-transparent overlay for stale (out-of-vision) cells
    fctx.globalCompositeOperation = 'source-over';
    gameState.fogOfWar.forEach((fogInfo, key) => {
        if (!fogInfo.explored) return;
        const timeSince = now - fogInfo.lastSeen;
        if (timeSince <= 500) return; // still visible ??leave transparent
        const alpha  = Math.min(0.5, timeSince / 10000 * 0.5);
        // Snap to one of 20 pre-computed strings to avoid per-cell string allocation
        const bucket = Math.min(19, (alpha / 0.5 * 19 + 0.5) | 0);
        fctx.fillStyle = _FOG_ALPHA_STRINGS[bucket];
        const x = key % gridSize;
        const y = (key / gridSize) | 0;
        fctx.fillRect(x, y, 1, 1);
    });

    // Restore default composite mode
    fctx.globalCompositeOperation = 'source-over';
}

// Get player color based on user ID
function getPlayerColor(userId) {
    if (userId === gameState.userId) {
        return '#4fc3f7'; // Cyan for own units
    }
    
    // Generate consistent color for each player ID
    const colors = [
        '#ff5252', // Red
        '#ffeb3b', // Yellow
        '#4caf50', // Green
        '#9c27b0', // Purple
        '#ff9800', // Orange
        '#00bcd4', // Teal
        '#e91e63', // Pink
        '#8bc34a'  // Light Green
    ];
    
    // Use Math.abs to handle negative AI player IDs
    const idx = Math.abs(userId) % colors.length;
    return colors[idx];
}

// Check if a world position is currently visible (not in fog) for the local player
function isPositionVisible(worldX, worldY) {
    const map = gameState.map;
    if (!map) return true;
    const gridSize = getMapGridSize(map);
    const cellSize = getMapCellSize(map);
    if (!gridSize || !cellSize) return true;
    
    const gx = Math.floor(worldX / cellSize);
    const gy = Math.floor(worldY / cellSize);
    if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) return false;
    
    const key = getFogKey(gx, gy, gridSize);
    const fogInfo = gameState.fogOfWar.get(key);
    if (!fogInfo || !fogInfo.explored) return false;
    
    // Currently visible if seen within the last 1.5 seconds
    const timeSince = Date.now() - fogInfo.lastSeen;
    return timeSince < 1500;
}

function isInViewport(worldX, worldY) {
    const viewport = getViewport();
    return worldX >= viewport.left && worldX <= viewport.right &&
           worldY >= viewport.top && worldY <= viewport.bottom;
}

function renderBuildings() {
    const viewport = getViewportBounds(240);
    gameState.buildings.forEach(building => {
        if (building.x < viewport.left || building.x > viewport.right ||
            building.y < viewport.top || building.y > viewport.bottom) {
            return;
        }
        
        // Hide enemy buildings in fog of war
        if (building.userId !== gameState.userId && !isPositionVisible(building.x, building.y)) {
            return;
        }
        const color = getPlayerColor(building.userId);
        
        // Building size - 鍮꾩쑉: 200 (湲곗? ?ш린)
        const size = 200;
        
        ctx.fillStyle = color;
        ctx.fillRect(building.x - size/2, building.y - size/2, size, size);
        
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.strokeRect(building.x - size/2, building.y - size/2, size, size);
        
        // Build progress
        if (building.buildProgress < 100) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.fillRect(
                building.x - size/2,
                building.y + size/2 + 5,
                (size * building.buildProgress) / 100,
                5
            );
        }
        
        // Unit production progress bar (on building)
        if (building.producing && building.buildProgress >= 100) {
            const elapsed = Date.now() - building.producing.startTime;
            const prodProgress = Math.min(1, elapsed / building.producing.buildTime);
            // Background
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fillRect(building.x - size/2, building.y + size/2 + 12, size, 6);
            // Fill
            ctx.fillStyle = '#ffcc00';
            ctx.fillRect(building.x - size/2, building.y + size/2 + 12, size * prodProgress, 6);
        }
        
        // HP bar
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(building.x - size/2, building.y - size/2 - 10, size, 5);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(
            building.x - size/2,
            building.y - size/2 - 10,
            (size * building.hp) / building.maxHp,
            5
        );
        
        // Type label
        ctx.fillStyle = '#fff';
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        const typeNames = {
            'headquarters': '본부',
            'shipyard': '조선소',
            'power_plant': '발전소',
            'defense_tower': '방어',
            'naval_academy': '사관학교',
            'research_lab': '연구소',
            'missile_silo': '미사일'
        };
        ctx.fillText(typeNames[building.type] || building.type, building.x, building.y);
        
        // SLBM count for missile silo
        if (building.type === 'missile_silo' && building.slbmCount) {
            ctx.fillStyle = '#ff0000';
            ctx.font = '12px Arial';
            ctx.fillText(`SLBM: ${building.slbmCount}`, building.x, building.y + 15);
        }
    });
}

function renderUnits() {
    const viewport = getViewportBounds(120);
    gameState.units.forEach((unit, unitId) => {
        // Don't render enemy submarines in stealth
        if (unit.type === 'submarine' && unit.userId !== gameState.userId && !unit.isDetected) {
            return;
        }
        
        // Hide enemy units in fog of war
        const posX = unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x;
        const posY = unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y;
        if (unit.userId !== gameState.userId && !isPositionVisible(posX, posY)) {
            return;
        }
        
        const isSelected = gameState.selection.has(unitId);
        const color = getPlayerColor(unit.userId);
        
        // Use interpolated display position for smooth rendering
        if (posX < viewport.left || posX > viewport.right ||
            posY < viewport.top || posY > viewport.bottom) {
            return;
        }
        
        // Unit size - 鍮꾩쑉: 60 (嫄대Ъ??30%)
        const size = unit.type === 'worker' ? 40 : (unit.type === 'aircraft' ? 20 : (unit.type === 'frigate' ? 35 : 60));
        
        // Draw unit shape
        ctx.save();
        ctx.translate(posX, posY);
        
        // Face the direction of movement (updated real-time while moving).
        // When stopped, holds the last movement/command direction.
        ctx.rotate(unit.displayAngle !== undefined ? unit.displayAngle : 0);
        
        if (unit.type === 'aircraft') {
            // Aircraft - using fighter.png
            if (fighterImageLoaded && fighterImage) {
                const origW = fighterImage.width;
                const origH = fighterImage.height;
                const aspectRatio = origW / origH;
                const baseHeight = size * BATTLESHIP_BASE_HEIGHT_MULTIPLIER;
                const baseWidth = baseHeight * aspectRatio;
                
                ctx.save();
                ctx.rotate(-Math.PI / 2);
                ctx.drawImage(fighterImage, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
                ctx.restore();
                
                if (isSelected) {
                    ctx.save();
                    ctx.rotate(-Math.PI / 2);
                    ctx.strokeStyle = '#ffff00';
                    ctx.lineWidth = 2;
                    const selW = baseWidth * 1.2;
                    const selH = baseHeight * 1.2;
                    ctx.strokeRect(-selW / 2, -selH / 2, selW, selH);
                    ctx.restore();
                }
            } else {
                // Fallback - small triangle
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.moveTo(size, 0);
                ctx.lineTo(-size * 0.6, size * 0.7);
                ctx.lineTo(-size * 0.3, 0);
                ctx.lineTo(-size * 0.6, -size * 0.7);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = isSelected ? '#ffff00' : '#fff';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        } else if (unit.type === 'worker') {
            // Worker - smaller circle
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(0, 0, size/2, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.strokeStyle = isSelected ? '#ffff00' : '#fff';
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.stroke();
        } else if (unit.type === 'submarine') {
            // Submarine - using submarine.png
            if (submarineImageLoaded && submarineImage) {
                const origW = submarineImage.width;
                const origH = submarineImage.height;
                const aspectRatio = origW / origH;
                const baseHeight = size * BATTLESHIP_BASE_HEIGHT_MULTIPLIER;
                const baseWidth = baseHeight * aspectRatio;
                
                ctx.save();
                ctx.rotate(-Math.PI / 2);
                ctx.drawImage(submarineImage, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
                ctx.restore();
                
                if (isSelected) {
                    ctx.save();
                    ctx.rotate(-Math.PI / 2);
                    ctx.strokeStyle = '#ffff00';
                    ctx.lineWidth = 2;
                    const selW = baseWidth * 1.2;
                    const selH = baseHeight * 1.2;
                    ctx.strokeRect(-selW / 2, -selH / 2, selW, selH);
                    ctx.restore();
                }
            } else {
                // Fallback
                ctx.fillStyle = unit.isDetected ? '#ff5252' : color;
                ctx.beginPath();
                ctx.ellipse(0, 0, size, size/2, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = isSelected ? '#ffff00' : (unit.isDetected ? '#ff0000' : '#fff');
                ctx.lineWidth = isSelected ? 2 : 1;
                ctx.stroke();
            }
            
            // Stealth indicator
            if (!unit.isDetected && unit.userId === gameState.userId) {
                ctx.fillStyle = '#00ff00';
                ctx.font = '12px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('은신', 0, -size - 5);
            }
        } else if (unit.type === 'carrier') {
            // Carrier - using carrier.png
            if (carrierImageLoaded && carrierImage) {
                const origW = carrierImage.width;
                const origH = carrierImage.height;
                const aspectRatio = origW / origH;
                const baseHeight = size * BATTLESHIP_BASE_HEIGHT_MULTIPLIER;
                const baseWidth = baseHeight * aspectRatio;
                
                ctx.save();
                ctx.rotate(-Math.PI / 2);
                ctx.drawImage(carrierImage, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
                ctx.restore();
                
                if (isSelected) {
                    ctx.save();
                    ctx.rotate(-Math.PI / 2);
                    ctx.strokeStyle = '#ffff00';
                    ctx.lineWidth = 2;
                    const selW = baseWidth * 1.2;
                    const selH = baseHeight * 1.2;
                    ctx.strokeRect(-selW / 2, -selH / 2, selW, selH);
                    ctx.restore();
                }
            } else {
                // Fallback
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.rect(-size * 0.8, -size * 0.35, size * 1.6, size * 0.7);
                ctx.fill();
                ctx.strokeStyle = isSelected ? '#ffff00' : '#fff';
                ctx.lineWidth = isSelected ? 2 : 1;
                ctx.stroke();
            }
        } else if (unit.type === 'battleship') {
            // Battleship - using battleshipbase.png and maincannon.png
            if (battleshipBaseLoaded && battleshipBaseImage) {
                const metrics = getBattleshipVisualMetrics(size);
                const baseWidth = metrics.baseWidth;
                const baseHeight = metrics.baseHeight;
                
                // Image is facing 6 o'clock (down) by default, but canvas rotation 
                // assumes 3 o'clock (right) as 0 degrees, so rotate -90 degrees
                ctx.save();
                ctx.rotate(-Math.PI / 2);
                
                // Draw battleship base
                ctx.drawImage(
                    battleshipBaseImage,
                    -baseWidth / 2,
                    -baseHeight / 2,
                    baseWidth,
                    baseHeight
                );
                
                // Draw 3 turrets at specified positions
                // Adjust positions to match battleshipbasewcannon.png layout
                // Original image coordinates for centered turrets on the ship
                const turretPositions = metrics.turretInner;
                
                const attackTarget = getBattleshipAimTarget(unit);
                // Ship faces the same angle as the outer ctx.rotate (displayAngle).
                const shipAngle = unit.displayAngle !== undefined ? unit.displayAngle : 0;
                const turretWorldStates = getBattleshipTurretWorldStates(posX, posY, shipAngle, size);
                const turretTargetAngles = turretWorldStates.map((turretState, ti) => {
                    if (attackTarget) {
                        return Math.atan2(
                            attackTarget.y - turretState.centerY,
                            attackTarget.x - turretState.centerX
                        );
                    }
                    if (unit.turretAngles && unit.turretAngles[ti] !== undefined) {
                        return unit.turretAngles[ti];
                    }
                    return shipAngle;
                });

                // Initialize turret angles array if not exists
                if (!unit.turretAngles || unit.turretAngles.length !== turretTargetAngles.length) {
                    unit.turretAngles = turretTargetAngles.slice();
                }

                // Smooth rotation for each turret independently
                const turretRotationSpeed = 0.08;
                for (let ti = 0; ti < turretTargetAngles.length; ti++) {
                    const target = turretTargetAngles[ti];
                    if (attackTarget) {
                        // While actively attacking, force exact facing to the target.
                        unit.turretAngles[ti] = target;
                        continue;
                    }
                    let diff = target - unit.turretAngles[ti];
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    if (Math.abs(diff) > turretRotationSpeed) {
                        unit.turretAngles[ti] += Math.sign(diff) * turretRotationSpeed;
                    } else {
                        unit.turretAngles[ti] = target;
                    }
                }
                
                if (mainCannonLoaded && mainCannonImage) {
                    turretPositions.forEach((pos, ti) => {
                        ctx.save();
                        // Position turret relative to ship center
                        ctx.translate(pos.x, pos.y);
                        
                        // Cannon sprite faces downward (+Y) in source image.
                        // After ship/body transforms, local +Y aligns to shipAngle in world space.
                        // Subtracting shipAngle maps world target angle into local turret angle.
                        const relativeAngle = unit.turretAngles[ti] - shipAngle;
                        ctx.rotate(relativeAngle);
                        
                        ctx.drawImage(
                            mainCannonImage,
                            -metrics.turretWidth / 2,
                            -metrics.turretHeight / 2,
                            metrics.turretWidth,
                            metrics.turretHeight
                        );
                        ctx.restore();
                    });
                }
                
                ctx.restore(); // Restore from -90deg rotation
                
                // Selection outline (1.2x larger)
                if (isSelected) {
                    ctx.save();
                    ctx.rotate(-Math.PI / 2);
                    ctx.strokeStyle = '#ffff00';
                    ctx.lineWidth = 2;
                    const selectionWidth = baseWidth * 1.2;
                    const selectionHeight = baseHeight * 1.2;
                    ctx.strokeRect(-selectionWidth / 2, -selectionHeight / 2, selectionWidth, selectionHeight);
                    ctx.restore();
                }
            } else {
                // Fallback to original shape if images not loaded
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.moveTo(size, 0);
                ctx.lineTo(size * 0.2, -size * 0.4);
                ctx.lineTo(-size * 0.8, -size * 0.4);
                ctx.lineTo(-size * 0.8, size * 0.4);
                ctx.lineTo(size * 0.2, size * 0.4);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = isSelected ? '#ffff00' : '#fff';
                ctx.lineWidth = isSelected ? 2 : 1;
                ctx.stroke();
            }
        } else if (unit.type === 'cruiser') {
            // Cruiser - using cruiser.png
            if (cruiserImageLoaded && cruiserImage) {
                const origW = cruiserImage.width;
                const origH = cruiserImage.height;
                const aspectRatio = origW / origH;
                const baseHeight = size * BATTLESHIP_BASE_HEIGHT_MULTIPLIER;
                const baseWidth = baseHeight * aspectRatio;
                
                ctx.save();
                ctx.rotate(-Math.PI / 2);
                ctx.drawImage(cruiserImage, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
                ctx.restore();
                
                if (isSelected) {
                    ctx.save();
                    ctx.rotate(-Math.PI / 2);
                    ctx.strokeStyle = '#ffff00';
                    ctx.lineWidth = 2;
                    const selW = baseWidth * 1.2;
                    const selH = baseHeight * 1.2;
                    ctx.strokeRect(-selW / 2, -selH / 2, selW, selH);
                    ctx.restore();
                }
            } else {
                // Fallback
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.moveTo(size, 0);
                ctx.lineTo(-size/2, size/2);
                ctx.lineTo(-size/2, -size/2);
                ctx.closePath();
                ctx.fill();
                ctx.strokeStyle = isSelected ? '#ffff00' : '#fff';
                ctx.lineWidth = isSelected ? 2 : 1;
                ctx.stroke();
            }
        } else if (unit.type === 'frigate') {
            // Frigate - using frigate.png
            if (frigateImageLoaded && frigateImage) {
                const origW = frigateImage.width;
                const origH = frigateImage.height;
                const aspectRatio = origW / origH;
                const baseHeight = size * BATTLESHIP_BASE_HEIGHT_MULTIPLIER;
                const baseWidth = baseHeight * aspectRatio;
                
                ctx.save();
                ctx.rotate(-Math.PI / 2);
                ctx.drawImage(frigateImage, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight);
                ctx.restore();
                
                if (isSelected) {
                    ctx.save();
                    ctx.rotate(-Math.PI / 2);
                    ctx.strokeStyle = '#ffff00';
                    ctx.lineWidth = 2;
                    const selW = baseWidth * 1.2;
                    const selH = baseHeight * 1.2;
                    ctx.strokeRect(-selW / 2, -selH / 2, selW, selH);
                    ctx.restore();
                }
            } else {
                // Fallback - small square
                const hs = size * 0.45;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.rect(-hs, -hs, hs * 2, hs * 2);
                ctx.fill();
                ctx.strokeStyle = isSelected ? '#ffff00' : '#fff';
                ctx.lineWidth = isSelected ? 2 : 1;
                ctx.stroke();
            }
        } else {
            // Regular naval unit - ship shape
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.moveTo(size, 0);
            ctx.lineTo(-size/2, size/2);
            ctx.lineTo(-size/2, -size/2);
            ctx.closePath();
            ctx.fill();
            
            ctx.strokeStyle = isSelected ? '#ffff00' : '#fff';
            ctx.lineWidth = isSelected ? 2 : 1;
            ctx.stroke();
        }
        
        ctx.restore();
        
        // HP bar
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(posX - size, posY - size - 8, size * 2, 4);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(
            posX - size,
            posY - size - 8,
            (size * 2 * unit.hp) / unit.maxHp,
            4
        );
        
        // Worker activity indicator
        if (unit.type === 'worker' && unit.userId === gameState.userId) {
            if (unit.gatheringResourceId) {
                ctx.fillStyle = '#ffd700';
                ctx.font = '10px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('⛏', posX, posY - size - 12);
            } else if (unit.buildingType) {
                ctx.fillStyle = '#00ff00';
                ctx.font = '10px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('🔨', posX, posY - size - 12);
            }
        }
        
        // Selection circle (skip for battleship as it has its own selection box)
        if (isSelected && unit.type !== 'battleship') {
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(posX, posY, size + 5, 0, Math.PI * 2);
            ctx.stroke();
        }
    });
}

// Helper: draw flame trail behind SLBM piece
function drawSlbmFlame(ctx, x, y, angle, width, length) {
    const segments = 6;
    for (let i = segments; i >= 0; i--) {
        const t = i / segments;
        const fx = x - Math.cos(angle) * length * t;
        const fy = y - Math.sin(angle) * length * t;
        const segRadius = (width / 2) * (1 - t * 0.5);
        const segAlpha = (1 - t) * 0.8;
        const r = 255;
        const g = Math.floor(80 + (1 - t) * 175);
        const b = Math.floor((1 - t) * 40);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${segAlpha})`;
        ctx.beginPath();
        ctx.arc(fx, fy, segRadius, 0, Math.PI * 2);
        ctx.fill();
    }
}

function renderContrails() {
    const now = Date.now();
    const ctx = canvas.getContext('2d');
    const viewport = getViewportBounds(500);
    
    slbmContrails.forEach(contrail => {
        // Remove old segments (older than 3 seconds)
        contrail.segments = contrail.segments.filter(seg => now - seg.time < 3000);
        
        // Draw remaining segments
        for (let i = 0; i < contrail.segments.length - 1; i++) {
            const seg = contrail.segments[i];
            const nextSeg = contrail.segments[i + 1];
            
            // Skip if not in viewport
            if (seg.x < viewport.left - 100 || seg.x > viewport.right + 100 ||
                seg.y < viewport.top - 100 || seg.y > viewport.bottom + 100) {
                continue;
            }
            
            const age = now - seg.time;
            const fadeProgress = age / 3000; // 0 to 1 over 3 seconds
            const alpha = Math.max(0, 0.3 - fadeProgress * 0.3); // Start at 0.3, fade to 0
            
            ctx.strokeStyle = `rgba(200, 200, 200, ${alpha})`;
            ctx.lineWidth = 24;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(seg.x, seg.y);
            ctx.lineTo(nextSeg.x, nextSeg.y);
            ctx.stroke();
        }
    });
    
    // Remove empty contrails
    slbmContrails = slbmContrails.filter(c => c.segments.length > 0);
}

function renderProjectiles() {
    const now = Date.now();
    const viewport = getViewportBounds(500);

    if (attackProjectiles.length > 0) {
        attackProjectiles = attackProjectiles.filter(projectile => {
            const lifetime = now - projectile.startTime;
            return lifetime <= projectile.flightTime + 900;
        });
    }

    attackProjectiles.forEach(projectile => {
        const progress = Math.max(0, Math.min(1, (now - projectile.startTime) / projectile.flightTime));
        
        // If targetId exists, use the unit's interpolated display position
        let finalTargetX = projectile.targetX;
        let finalTargetY = projectile.targetY;
        if (projectile.targetId) {
            const targetUnit = gameState.units.get(projectile.targetId);
            if (targetUnit) {
                finalTargetX = targetUnit.interpDisplayX !== undefined ? targetUnit.interpDisplayX : targetUnit.x;
                finalTargetY = targetUnit.interpDisplayY !== undefined ? targetUnit.interpDisplayY : targetUnit.y;
            }
        }
        
        const currentX = projectile.fromX + (finalTargetX - projectile.fromX) * progress;
        const currentY = projectile.fromY + (finalTargetY - projectile.fromY) * progress;

        const inView = (
            currentX >= viewport.left &&
            currentX <= viewport.right &&
            currentY >= viewport.top &&
            currentY <= viewport.bottom
        );

        if (!inView || !isPositionVisible(currentX, currentY)) {
            return;
        }

        if (progress >= 1) {
            // Impact effect
            const impactAge = (now - projectile.startTime) - projectile.flightTime;
            const impactProgress = impactAge / 900;
            if (impactProgress < 1) {
                const isBig = projectile.shooterType === 'battleship' || projectile.shooterType === 'defense_tower';
                const impactRadius = (isBig ? 30 : 18) * (1 + impactProgress * 0.5);
                const impactAlpha = Math.max(0, 0.6 - impactProgress * 0.6);
                ctx.fillStyle = `rgba(255, 140, 40, ${impactAlpha})`;
                ctx.beginPath();
                ctx.arc(finalTargetX, finalTargetY, impactRadius, 0, Math.PI * 2);
                ctx.fill();
            }
            return;
        }

        const isBattleshipShell = projectile.shooterType === 'battleship' || projectile.shooterType === 'defense_tower';
        const shellRadius = isBattleshipShell ? 5 : 3;
        const isAimedShot = projectile.aimedShot;

        // Calculate angle of flight
        const dx = finalTargetX - projectile.fromX;
        const dy = finalTargetY - projectile.fromY;
        const angle = Math.atan2(dy, dx);

        // Draw flame trail behind the shell
        const trailLength = isBattleshipShell ? 120 : 22;
        const trailSegments = 8;
        for (let i = trailSegments; i >= 0; i--) {
            const t = i / trailSegments;
            const trailX = currentX - Math.cos(angle) * trailLength * t;
            const trailY = currentY - Math.sin(angle) * trailLength * t;
            const segRadius = shellRadius * (1 - t * 0.6);
            const segAlpha = (1 - t) * 0.85;
            if (isAimedShot) {
                // Blue flame for aimed shot
                const r = Math.floor(50 + (1 - t) * 80);
                const g = Math.floor(120 + (1 - t) * 135);
                const b = 255;
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${segAlpha})`;
            } else {
                // Red-to-yellow flame for normal shots
                const r = 255;
                const g = Math.floor(60 + (1 - t) * 195);
                const b = Math.floor((1 - t) * 50);
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${segAlpha})`;
            }
            ctx.beginPath();
            ctx.arc(trailX, trailY, segRadius, 0, Math.PI * 2);
            ctx.fill();
        }

        // Draw black shell (projectile head)
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.arc(currentX, currentY, shellRadius, 0, Math.PI * 2);
        ctx.fill();
    });

    slbmMissiles.forEach(missile => {
        if (!missile.impacted) {
            const progress = Math.max(0, Math.min(1, (now - missile.startTime) / missile.flightTime));
            
            // Auto-impact when flight animation completes (don't wait for server event)
            if (progress >= 1) {
                missile.impacted = true;
                missile.impactTime = now;
                return;
            }
            
            const dx = missile.targetX - missile.fromX;
            const dy = missile.targetY - missile.fromY;
            const angle = Math.atan2(dy, dx);
            const currentX = missile.fromX + dx * progress;
            const currentY = missile.fromY + dy * progress;

            if (currentX < viewport.left - 200 || currentX > viewport.right + 200 || currentY < viewport.top - 200 || currentY > viewport.bottom + 200) {
                return;
            }

            // SLBM body: black rectangle, 24px wide, ~150px tall (doubled size)
            const missileWidth = 24;
            const missileFullLen = 150;
            
            // Add contrail segments
            if (!missile.contrailId) {
                missile.contrailId = `contrail-${missile.id}`;
                slbmContrails.push({ 
                    id: missile.contrailId, 
                    segments: [{ x: missile.fromX, y: missile.fromY, time: missile.startTime }] 
                });
            }
            const contrail = slbmContrails.find(c => c.id === missile.contrailId);
            if (contrail && (contrail.segments.length === 0 || now - contrail.segments[contrail.segments.length - 1].time > 50)) {
                contrail.segments.push({ x: currentX, y: currentY, time: now });
            }

            if (progress < 0.333) {
                // Phase 1: Single missile body
                ctx.save();
                ctx.translate(currentX, currentY);
                ctx.rotate(angle + Math.PI / 2);
                ctx.fillStyle = '#111';
                ctx.fillRect(-missileWidth / 2, -missileFullLen / 2, missileWidth, missileFullLen);
                ctx.restore();
                // Flame trail from rear of missile
                const rearX = currentX - Math.cos(angle) * (missileFullLen / 2);
                const rearY = currentY - Math.sin(angle) * (missileFullLen / 2);
                drawSlbmFlame(ctx, rearX, rearY, angle, missileWidth, 50);
            } else if (progress < 0.666) {
                // Phase 2: Split into 2 pieces (main + 1st separated piece)
                const splitProgress = (progress - 0.333) / 0.333;
                const pieceLen = missileFullLen / 3;

                // Main body (2/3 length)
                ctx.save();
                ctx.translate(currentX, currentY);
                ctx.rotate(angle + Math.PI / 2);
                ctx.fillStyle = '#111';
                ctx.fillRect(-missileWidth / 2, -pieceLen, missileWidth, pieceLen * 2);
                ctx.restore();
                // Flame trail from rear of main body
                const rearX = currentX - Math.cos(angle) * pieceLen;
                const rearY = currentY - Math.sin(angle) * pieceLen;
                drawSlbmFlame(ctx, rearX, rearY, angle, missileWidth, 40);

                // 1st separated piece - drifts away perpendicular (no flame)
                const sep1X = currentX - Math.cos(angle) * pieceLen * 1.5 + Math.sin(angle) * 20 * splitProgress;
                const sep1Y = currentY - Math.sin(angle) * pieceLen * 1.5 - Math.cos(angle) * 20 * splitProgress;
                ctx.save();
                ctx.translate(sep1X, sep1Y);
                ctx.rotate(angle + Math.PI / 2 + splitProgress * 0.3);
                ctx.fillStyle = '#333';
                ctx.fillRect(-missileWidth / 2, -pieceLen / 2, missileWidth, pieceLen);
                ctx.restore();
            } else {
                // Phase 3: Split into 3 pieces (main warhead + 2 separated)
                const splitProgress = (progress - 0.666) / 0.334;
                const pieceLen = missileFullLen / 3;

                // Main warhead (1/3 length)
                ctx.save();
                ctx.translate(currentX, currentY);
                ctx.rotate(angle + Math.PI / 2);
                ctx.fillStyle = '#111';
                ctx.fillRect(-missileWidth / 2, -pieceLen / 2, missileWidth, pieceLen);
                ctx.restore();
                // Flame trail from rear of warhead
                const rearX = currentX - Math.cos(angle) * (pieceLen / 2);
                const rearY = currentY - Math.sin(angle) * (pieceLen / 2);
                drawSlbmFlame(ctx, rearX, rearY, angle, missileWidth, 35);

                // 1st separated piece (no flame)
                const sep1X = currentX - Math.cos(angle) * pieceLen * 2.5 + Math.sin(angle) * 35 * Math.min(splitProgress + 0.5, 1);
                const sep1Y = currentY - Math.sin(angle) * pieceLen * 2.5 - Math.cos(angle) * 35 * Math.min(splitProgress + 0.5, 1);
                const alpha1 = Math.max(0, 1 - splitProgress * 0.7);
                ctx.save();
                ctx.translate(sep1X, sep1Y);
                ctx.rotate(angle + Math.PI / 2 + 0.5);
                ctx.globalAlpha = alpha1;
                ctx.fillStyle = '#444';
                ctx.fillRect(-missileWidth / 2, -pieceLen / 2, missileWidth, pieceLen);
                ctx.globalAlpha = 1;
                ctx.restore();

                // 2nd separated piece (no flame)
                const sep2X = currentX - Math.cos(angle) * pieceLen * 1.5 - Math.sin(angle) * 30 * splitProgress;
                const sep2Y = currentY - Math.sin(angle) * pieceLen * 1.5 + Math.cos(angle) * 30 * splitProgress;
                const alpha2 = Math.max(0, 1 - splitProgress * 0.5);
                ctx.save();
                ctx.translate(sep2X, sep2Y);
                ctx.rotate(angle + Math.PI / 2 - splitProgress * 0.4);
                ctx.globalAlpha = alpha2;
                ctx.fillStyle = '#444';
                ctx.fillRect(-missileWidth / 2, -pieceLen / 2, missileWidth, pieceLen);
                ctx.globalAlpha = 1;
                ctx.restore();
            }
            
            // Draw SLBM HP bar if damaged
            if (missile.hp !== undefined && missile.maxHp && missile.hp < missile.maxHp) {
                const barWidth = 40;
                const barHeight = 4;
                const barX = currentX - barWidth / 2;
                const barY = currentY - 50;
                const hpRatio = Math.max(0, missile.hp / missile.maxHp);
                
                ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                ctx.fillRect(barX, barY, barWidth, barHeight);
                ctx.fillStyle = hpRatio > 0.5 ? '#4caf50' : (hpRatio > 0.25 ? '#ff9800' : '#f44336');
                ctx.fillRect(barX, barY, barWidth * hpRatio, barHeight);
                ctx.strokeStyle = '#333';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(barX, barY, barWidth, barHeight);
            }
            return;
        }

        const impactElapsed = now - (missile.impactTime || 0);
        if (impactElapsed > 2600) {
            return;
        }
        if (
            missile.targetX < viewport.left ||
            missile.targetX > viewport.right ||
            missile.targetY < viewport.top ||
            missile.targetY > viewport.bottom
        ) {
            return;
        }

        const pulseRadius = 120 + (impactElapsed * 0.42);
        const pulseAlpha = Math.max(0, 0.52 - (impactElapsed / 2600));
        ctx.fillStyle = `rgba(255, 95, 20, ${pulseAlpha})`;
        ctx.beginPath();
        ctx.arc(missile.targetX, missile.targetY, pulseRadius, 0, Math.PI * 2);
        ctx.fill();
    });

    // Render ship death explosion effects
    explosionEffects = explosionEffects.filter(exp => now - exp.startTime < exp.duration);
    explosionEffects.forEach(exp => {
        // Skip if not in fog of war vision
        if (!isPositionVisible(exp.x, exp.y)) return;
        
        const elapsed = now - exp.startTime;
        const progress = elapsed / exp.duration;
        
        // Central flash (fades out quickly)
        if (progress < 0.3) {
            const flashAlpha = 1 - (progress / 0.3);
            const flashRadius = 30 + progress * 60;
            ctx.fillStyle = `rgba(255, 200, 50, ${flashAlpha * 0.8})`;
            ctx.beginPath();
            ctx.arc(exp.x, exp.y, flashRadius, 0, Math.PI * 2);
            ctx.fill();
            
            // White core
            ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha * 0.6})`;
            ctx.beginPath();
            ctx.arc(exp.x, exp.y, flashRadius * 0.4, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Expanding smoke ring
        if (progress > 0.1) {
            const ringAlpha = Math.max(0, 0.4 - progress * 0.4);
            const ringRadius = 20 + progress * 80;
            ctx.strokeStyle = `rgba(100, 100, 100, ${ringAlpha})`;
            ctx.lineWidth = 6;
            ctx.beginPath();
            ctx.arc(exp.x, exp.y, ringRadius, 0, Math.PI * 2);
            ctx.stroke();
        }
        
        // Flying debris particles
        exp.debris.forEach(d => {
            const alpha = Math.max(0, 1 - progress);
            const px = exp.x + d.dx * progress;
            const py = exp.y + d.dy * progress + (progress * progress * 40); // gravity
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(d.rotation + progress * 5);
            ctx.fillStyle = d.color.replace(')', `, ${alpha})`).replace('rgb', 'rgba');
            // Handle hex colors
            if (d.color.startsWith('#')) {
                const r = parseInt(d.color.slice(1,3), 16);
                const g = parseInt(d.color.slice(3,5), 16);
                const b = parseInt(d.color.slice(5,7), 16);
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
            }
            ctx.fillRect(-d.size/2, -d.size/2, d.size, d.size * 0.6);
            ctx.restore();
        });
    });
}

function renderMinimap() {
    const map = gameState.map;
    if (!map) return;
    ensureMapImageLoaded();
    ensureLandMaskLoaded();
    
    minimapCtx.clearRect(0, 0, minimap.width, minimap.height);
    const now = Date.now();
    
    const scaleX = minimap.width / map.width;
    const scaleY = minimap.height / map.height;

    if (mapImageLoaded && mapImage && !mapImageLoadFailed) {
        minimapCtx.drawImage(mapImage, 0, 0, minimap.width, minimap.height);
        if (landMaskCanvas) {
            minimapCtx.save();
            minimapCtx.globalAlpha = IMAGE_LAND_MASK_ALPHA;
            minimapCtx.drawImage(landMaskCanvas, 0, 0, minimap.width, minimap.height);
            minimapCtx.restore();
        }
    } else {
        minimapCtx.fillStyle = '#1a3a5c';
        minimapCtx.fillRect(0, 0, minimap.width, minimap.height);
        if (landMaskCanvas) {
            minimapCtx.drawImage(landMaskCanvas, 0, 0, minimap.width, minimap.height);
        }
    }

    const gridSize = getMapGridSize(map);
    const fogCellSize = getMapCellSize(map);
    if (gridSize > 0 && fogCellSize > 0) {
        const minimapVisionRanges = {
            worker: 1000,
            destroyer: 1500,
            cruiser: 1200,
            battleship: 3200,
            carrier: 2000,
            submarine: 800,
            frigate: 900,
            aircraft: 1000
        };
        const visibleCircles = [];

        gameState.units.forEach(unit => {
            if (unit.userId != gameState.userId) return;
            const displayX = unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x;
            const displayY = unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y;
            const worldRadius = minimapVisionRanges[unit.type] || 1000;
            visibleCircles.push({
                x: displayX * scaleX,
                y: displayY * scaleY,
                r: worldRadius * ((scaleX + scaleY) * 0.5)
            });
        });

        gameState.buildings.forEach(building => {
            if (building.userId != gameState.userId) return;
            const worldRadius = 2000;
            visibleCircles.push({
                x: building.x * scaleX,
                y: building.y * scaleY,
                r: worldRadius * ((scaleX + scaleY) * 0.5)
            });
        });

        // Fast minimap fog: darken all, then carve out only current-vision circles.
        minimapCtx.fillStyle = 'rgba(0, 0, 0, 0.86)';
        minimapCtx.fillRect(0, 0, minimap.width, minimap.height);
        if (visibleCircles.length > 0) {
            minimapCtx.save();
            minimapCtx.globalCompositeOperation = 'destination-out';
            minimapCtx.fillStyle = 'rgba(0, 0, 0, 1)';
            for (let i = 0; i < visibleCircles.length; i++) {
                const circle = visibleCircles[i];
                minimapCtx.beginPath();
                minimapCtx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
                minimapCtx.fill();
            }
            minimapCtx.restore();

            // Paint visible land in strong green only inside current vision.
            if (landMaskCanvas) {
                minimapCtx.save();
                minimapCtx.beginPath();
                for (let i = 0; i < visibleCircles.length; i++) {
                    const circle = visibleCircles[i];
                    minimapCtx.moveTo(circle.x + circle.r, circle.y);
                    minimapCtx.arc(circle.x, circle.y, circle.r, 0, Math.PI * 2);
                }
                minimapCtx.clip();
                minimapCtx.drawImage(landMaskCanvas, 0, 0, minimap.width, minimap.height);
                minimapCtx.globalCompositeOperation = 'source-atop';
                minimapCtx.fillStyle = MINIMAP_VISIBLE_LAND_COLOR;
                minimapCtx.fillRect(0, 0, minimap.width, minimap.height);
                minimapCtx.restore();
            }
        }
    }
    
    // Draw SLBM impact zones (darkened areas)
    slbmMissiles.forEach(missile => {
        if (missile.impacted) {
            const impactX = missile.targetX * scaleX;
            const impactY = missile.targetY * scaleY;
            minimapCtx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            minimapCtx.beginPath();
            minimapCtx.arc(impactX, impactY, 15, 0, Math.PI * 2);
            minimapCtx.fill();
        }
    });
    
    // Draw units - always show own units, others only in explored area
    gameState.units.forEach(unit => {
        const displayX = unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x;
        const displayY = unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y;
        
        if (unit.userId == gameState.userId) {
            minimapCtx.fillStyle = '#00ff00';
            minimapCtx.fillRect(displayX * scaleX - 2, displayY * scaleY - 2, 5, 5);
        } else if (gridSize > 0 && fogCellSize > 0) {
            const fogX = Math.floor(unit.x / fogCellSize);
            const fogY = Math.floor(unit.y / fogCellSize);
            const gridKey = getFogKey(fogX, fogY, gridSize);
            const fogData = gameState.fogOfWar.get(gridKey);
            if (fogData && fogData.explored && now - fogData.lastSeen < 5000) {
                minimapCtx.fillStyle = '#ff0000';
                minimapCtx.fillRect(displayX * scaleX - 1, displayY * scaleY - 1, 4, 4);
            }
        }
    });
    
    // Draw buildings
    gameState.buildings.forEach(building => {
        if (building.userId == gameState.userId) {
            minimapCtx.fillStyle = '#ffff00';
            minimapCtx.fillRect(building.x * scaleX - 3, building.y * scaleY - 3, 7, 7);
        } else if (gridSize > 0 && fogCellSize > 0) {
            const fogX = Math.floor(building.x / fogCellSize);
            const fogY = Math.floor(building.y / fogCellSize);
            const gridKey = getFogKey(fogX, fogY, gridSize);
            const fogData = gameState.fogOfWar.get(gridKey);
            if (fogData && fogData.explored && now - fogData.lastSeen < 5000) {
                minimapCtx.fillStyle = '#ff0000';
                minimapCtx.fillRect(building.x * scaleX - 2, building.y * scaleY - 2, 5, 5);
            }
        }
    });
    
    // Draw active SLBM missiles (black bar with separation stages, scaled for minimap)
    slbmMissiles.forEach(missile => {
        if (!missile.impacted) {
            const progress = Math.min(1, (now - missile.startTime) / missile.flightTime);
            if (progress >= 1) return;
            const dx = missile.targetX - missile.fromX;
            const dy = missile.targetY - missile.fromY;
            const angle = Math.atan2(dy, dx);
            const currentX = (missile.fromX + dx * progress) * scaleX;
            const currentY = (missile.fromY + dy * progress) * scaleY;
            
            // Minimap-scaled missile dimensions
            const mw = 2; // missile width on minimap
            const mLen = 8; // missile full length on minimap
            
            if (progress < 0.333) {
                // Phase 1: Single body
                minimapCtx.save();
                minimapCtx.translate(currentX, currentY);
                minimapCtx.rotate(angle + Math.PI / 2);
                minimapCtx.fillStyle = '#111';
                minimapCtx.fillRect(-mw / 2, -mLen / 2, mw, mLen);
                minimapCtx.restore();
            } else if (progress < 0.666) {
                // Phase 2: Main body + 1 separated piece
                const sp = (progress - 0.333) / 0.333;
                const pieceLen = mLen / 3;
                
                // Main body
                minimapCtx.save();
                minimapCtx.translate(currentX, currentY);
                minimapCtx.rotate(angle + Math.PI / 2);
                minimapCtx.fillStyle = '#111';
                minimapCtx.fillRect(-mw / 2, -pieceLen, mw, pieceLen * 2);
                minimapCtx.restore();
                
                // Separated piece
                const s1x = currentX - Math.cos(angle) * pieceLen * 1.5 * scaleX + Math.sin(angle) * 3 * sp;
                const s1y = currentY - Math.sin(angle) * pieceLen * 1.5 * scaleY - Math.cos(angle) * 3 * sp;
                minimapCtx.save();
                minimapCtx.translate(s1x, s1y);
                minimapCtx.rotate(angle + Math.PI / 2 + sp * 0.3);
                minimapCtx.fillStyle = '#555';
                minimapCtx.fillRect(-mw / 2, -pieceLen / 2, mw, pieceLen);
                minimapCtx.restore();
            } else {
                // Phase 3: Warhead + 2 separated pieces
                const sp = (progress - 0.666) / 0.334;
                const pieceLen = mLen / 3;
                
                // Main warhead
                minimapCtx.save();
                minimapCtx.translate(currentX, currentY);
                minimapCtx.rotate(angle + Math.PI / 2);
                minimapCtx.fillStyle = '#111';
                minimapCtx.fillRect(-mw / 2, -pieceLen / 2, mw, pieceLen);
                minimapCtx.restore();
                
                // 1st separated piece
                const s1x = currentX - Math.cos(angle) * pieceLen * 2.5 + Math.sin(angle) * 5 * Math.min(sp + 0.5, 1);
                const s1y = currentY - Math.sin(angle) * pieceLen * 2.5 - Math.cos(angle) * 5 * Math.min(sp + 0.5, 1);
                minimapCtx.save();
                minimapCtx.translate(s1x, s1y);
                minimapCtx.rotate(angle + Math.PI / 2 + 0.5);
                minimapCtx.globalAlpha = Math.max(0, 1 - sp * 0.7);
                minimapCtx.fillStyle = '#666';
                minimapCtx.fillRect(-mw / 2, -pieceLen / 2, mw, pieceLen);
                minimapCtx.globalAlpha = 1;
                minimapCtx.restore();
                
                // 2nd separated piece
                const s2x = currentX - Math.cos(angle) * pieceLen * 1.5 - Math.sin(angle) * 4 * sp;
                const s2y = currentY - Math.sin(angle) * pieceLen * 1.5 + Math.cos(angle) * 4 * sp;
                minimapCtx.save();
                minimapCtx.translate(s2x, s2y);
                minimapCtx.rotate(angle + Math.PI / 2 - sp * 0.4);
                minimapCtx.globalAlpha = Math.max(0, 1 - sp * 0.5);
                minimapCtx.fillStyle = '#666';
                minimapCtx.fillRect(-mw / 2, -pieceLen / 2, mw, pieceLen);
                minimapCtx.globalAlpha = 1;
                minimapCtx.restore();
            }
            
            // Small flame dot at tail
            minimapCtx.fillStyle = 'rgba(255, 120, 30, 0.8)';
            minimapCtx.beginPath();
            minimapCtx.arc(
                currentX - Math.cos(angle) * (mLen / 2),
                currentY - Math.sin(angle) * (mLen / 2),
                1.5, 0, Math.PI * 2
            );
            minimapCtx.fill();
        }
    });
    
    // Draw camera viewport
    const viewWidth = (canvas.width / gameState.camera.zoom) * scaleX;
    const viewHeight = (canvas.height / gameState.camera.zoom) * scaleY;
    const viewX = gameState.camera.x * scaleX - viewWidth / 2;
    const viewY = gameState.camera.y * scaleY - viewHeight / 2;
    
    minimapCtx.strokeStyle = '#fff';
    minimapCtx.lineWidth = 2;
    minimapCtx.strokeRect(viewX, viewY, viewWidth, viewHeight);
    
    // Draw SLBM targeting indicator
    if (slbmTargetingMode) {
        minimapCtx.strokeStyle = '#ff0000';
        minimapCtx.lineWidth = 2;
        minimapCtx.setLineDash([5, 5]);
        minimapCtx.strokeRect(0, 0, minimap.width, minimap.height);
        minimapCtx.setLineDash([]);
    }
}

// Helper: convert minimap click to world coordinates
function minimapClickToWorld(e) {
    const rect = minimap.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const cssScaleX = minimap.width / rect.width;
    const cssScaleY = minimap.height / rect.height;
    const canvasX = clickX * cssScaleX;
    const canvasY = clickY * cssScaleY;
    const worldScaleX = gameState.map.width / minimap.width;
    const worldScaleY = gameState.map.height / minimap.height;
    return clampWorldPointToMap(canvasX * worldScaleX, canvasY * worldScaleY);
}

// Minimap LEFT-click: always move camera (also handle SLBM targeting)
minimap.addEventListener('click', (e) => {
    if (!gameState.map) return;
    const target = minimapClickToWorld(e);
    
    // Handle SLBM targeting mode
    if (slbmTargetingMode) {
        const selectedSubs = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'submarine');
        
        for (const sub of selectedSubs) {
            if (gameState.missiles > 0) {
                socket.emit('submarineSLBM', {
                    submarineId: sub.id,
                    targetX: target.x,
                    targetY: target.y
                });
            } else break;
        }
        
        slbmTargetingMode = false;
        canvas.style.cursor = 'crosshair';
        document.getElementById('slbmInstructions').style.display = 'none';
        return;
    }
    
    // Move camera
    gameState.camera.x = target.x;
    gameState.camera.y = target.y;
    clampCameraToMapBounds();
    minimapDirty = true;
});

// Minimap RIGHT-click: move selected units (if any), else move camera
minimap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!gameState.map) return;
    const target = minimapClickToWorld(e);
    
    const selectedUnits = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId);
    
    if (selectedUnits.length > 0) {
        const unitIds = selectedUnits.map(u => u.id);
        unitIds.forEach(id => commandGroup.add(id));
        socket.emit('moveUnits', {
            unitIds: unitIds,
            targetX: target.x,
            targetY: target.y
        });
        // Store command facing angle (minimap command)
        selectedUnits.forEach(u => { u.commandAngle = Math.atan2(target.y - u.y, target.x - u.x); });
        return;
    }
    
    // No units selected - move camera
    gameState.camera.x = target.x;
    gameState.camera.y = target.y;
    clampCameraToMapBounds();
    minimapDirty = true;
});

// Update loop (60fps for smooth interpolation)
let isUpdateRunning = false;
let lastFrameTime = 0;
const FPS_LIMIT = 60;
const FRAME_INTERVAL = 1000 / FPS_LIMIT;

// Interpolate unit positions for smooth movement
function updateUnitInterpolation() {
    const now = Date.now();
    
    gameState.units.forEach(unit => {
        if (unit.interpTargetX !== undefined && unit.interpStartTime !== undefined) {
            const elapsed = now - unit.interpStartTime;
            const t = Math.min(elapsed / interpolationDurationMs, 1);

            // Linear interpolation reduces stop-and-go artifacts between server ticks.
            unit.interpDisplayX = unit.interpPrevX + (unit.interpTargetX - unit.interpPrevX) * t;
            unit.interpDisplayY = unit.interpPrevY + (unit.interpTargetY - unit.interpPrevY) * t;

            // --- Facing angle ---
            // While the unit is actually moving (server reported a position change),
            // face the movement direction in real-time.
            // When stopped, hold the last movement angle (= commandAngle fallback).
            const moveDx = unit.interpTargetX - unit.interpPrevX;
            const moveDy = unit.interpTargetY - unit.interpPrevY;
            const moveDist = Math.sqrt(moveDx * moveDx + moveDy * moveDy);
            if (moveDist > 0.5) {
                // Moving: use actual movement vector as facing
                unit.displayAngle = Math.atan2(moveDy, moveDx);
                // Also keep commandAngle in sync so it holds this angle when stopped
                unit.commandAngle = unit.displayAngle;
            } else {
                // Stopped: hold commandAngle set by the last player command (or last movement)
                unit.displayAngle = unit.commandAngle !== undefined ? unit.commandAngle : 0;
            }
        } else {
            unit.interpDisplayX = unit.x;
            unit.interpDisplayY = unit.y;
            unit.displayAngle = unit.commandAngle !== undefined ? unit.commandAngle : 0;
        }
    });
}

function update() {
    if (!isUpdateRunning) {
        return;
    }

    try {
        const now = performance.now();
        const elapsed = now - lastFrameTime;
        
        if (elapsed > FRAME_INTERVAL) {
            lastFrameTime = now - (elapsed % FRAME_INTERVAL);
            updateUnitInterpolation();
            updateCamera(elapsed);
            render();
        }
        
        animationFrameId = requestAnimationFrame(update);
    } catch (error) {
        console.error('Error in update loop:', error);
        stopUpdate();
    }
}

function startUpdate() {
    if (!isUpdateRunning) {
        isUpdateRunning = true;
        lastFrameTime = performance.now();
        animationFrameId = requestAnimationFrame(update);
    }
}

function stopUpdate() {
    isUpdateRunning = false;
    if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

// Kill Log - shows elimination messages
function showKillLog(attackerName, defeatedName) {
    const container = document.getElementById('killLogContainer');
    if (!container) return;
    
    const message = document.createElement('div');
    message.className = 'kill-log-message';
    message.innerHTML = `<span class="attacker">${attackerName}</span>이(가) <span class="defeated">${defeatedName}</span>을(를) 처치했습니다!`;
    
    container.appendChild(message);
    
    // Remove the message after animation completes (3 seconds)
    setTimeout(() => {
        if (message.parentNode) {
            message.parentNode.removeChild(message);
        }
    }, 3000);
}

// UI Updates
function updateHUD() {
    const player = gameState.players.get(gameState.userId);
    if (!player) return;
    
    document.getElementById('resources').textContent = Math.floor(player.resources);
    document.getElementById('missileCount').textContent = gameState.missiles;
    document.getElementById('population').textContent = player.population;
    document.getElementById('maxPopulation').textContent = player.maxPopulation;
    document.getElementById('combatPower').textContent = player.combatPower;
    document.getElementById('score').textContent = Math.floor(player.score);
    
    // Update action buttons based on selection
    updateActionButtons();
}

function updateActionButtons() {
    // Skill button visibility is managed by updateSelectionInfo()
    // No standalone slbmFireBtn / produceMissileBtn elements exist.
}

// SLBM Fire button handler (skillBtn1 in bottom panel)
document.getElementById('skillBtn1').addEventListener('click', () => {
    const selectedSubs = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'submarine');
    
    if (selectedSubs.length > 0 && gameState.missiles > 0) {
        slbmTargetingMode = true;
        document.getElementById('slbmInstructions').style.display = 'block';
    }
});

// Missile production button handler (skillBtn2 in bottom panel)
document.getElementById('skillBtn2').addEventListener('click', () => {
    const selectedBuildings = Array.from(gameState.selection)
        .map(id => gameState.buildings.get(id))
        .filter(b => b && b.userId === gameState.userId && b.type === 'missile_silo');
    
    if (selectedBuildings.length > 0 && socket) {
        socket.emit('produceMissile', { buildingId: selectedBuildings[0].id });
    }
});

// Carrier: produce aircraft (skillBtn3)
document.getElementById('skillBtn3').addEventListener('click', () => {
    const selectedCarriers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'carrier');
    if (selectedCarriers.length > 0 && socket) {
        selectedCarriers.forEach(carrier => {
            socket.emit('produceAircraft', { unitId: carrier.id });
        });
    }
});

// Carrier: deploy aircraft (skillBtn4)
document.getElementById('skillBtn4').addEventListener('click', () => {
    const selectedCarriers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'carrier');
    if (selectedCarriers.length > 0 && socket) {
        selectedCarriers.forEach(carrier => {
            socket.emit('deployAircraft', { unitId: carrier.id });
        });
    }
});

// Battleship: aimed shot (skillBtn5)
document.getElementById('skillBtn5').addEventListener('click', () => {
    const selectedBattleships = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'battleship');
    if (selectedBattleships.length > 0 && socket) {
        const unitIds = selectedBattleships.map(u => u.id);
        socket.emit('activateAimedShot', { unitIds });
    }
});

function updateRankings() {
    fetch('/api/rankings')
        .then(res => res.json())
        .then(rankings => {
            const list = document.getElementById('rankingsList');
            list.innerHTML = rankings.map((rank, index) => `
                <div class="ranking-item rank-${index + 1}">
                    <span class="rank-number">#${index + 1}</span>
                    <div class="username">${rank.username}</div>
                    <div class="stats">
                        점수: ${Math.floor(rank.score)} | 
                        자원: ${Math.floor(rank.resources)} | 
                        인구: ${rank.population} | 
                        전투력: ${rank.combat_power}
                    </div>
                </div>
            `).join('');
        });
}

// Build buttons (now rendered dynamically in skill panel for workers)

// Auth
document.getElementById('loginBtn').addEventListener('click', login);
document.getElementById('registerBtn').addEventListener('click', register);
document.getElementById('logoutBtn').addEventListener('click', logout);
document.getElementById('resetBtn').addEventListener('click', resetGame);

// Fetch server room info for login screen
async function fetchRoomInfo() {
    try {
        const res = await fetch('/api/rooms');
        const rooms = await res.json();
        const infoEl = document.getElementById('serverInfo');
        if (infoEl && rooms.length) {
            infoEl.textContent = rooms.map(r => `${r.name}: ${r.playerCount}/${r.maxPlayers}명`).join(' | ');
        }
    } catch(e) {}
}
fetchRoomInfo();
setInterval(fetchRoomInfo, 5000);

// Enter key support for login
document.getElementById('username').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
});
document.getElementById('password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') login();
});

let isLoggingIn = false;

async function login() {
    // 중복 실행 방지
    if (isLoggingIn) {
        console.log('Login already in progress');
        return;
    }
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    if (!username || !password) {
        document.getElementById('authError').textContent = '사용자명과 비밀번호를 입력하세요.';
        return;
    }
    
    isLoggingIn = true;
    document.getElementById('authError').textContent = '로그인 중...';
    console.log('Starting login...');
    
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            gameState.token = data.token;
            gameState.userId = data.userId;
            gameState.selectedRoom = document.getElementById('serverSelect').value;
            localStorage.setItem('token', data.token);
            localStorage.setItem('selectedRoom', gameState.selectedRoom);
            document.getElementById('authError').textContent = '';
            console.log('Login successful, connecting to game...');
            connectToGame();
        } else {
            document.getElementById('authError').textContent = data.error || '로그인 실패';
            isLoggingIn = false;
        }
    } catch (err) {
        console.error('Login error:', err);
        document.getElementById('authError').textContent = '서버 연결 실패';
        isLoggingIn = false;
    }
}

async function register() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    if (!username || !password) {
        document.getElementById('authError').textContent = '사용자명과 비밀번호를 입력하세요.';
        return;
    }
    
    if (password.length < 4) {
        document.getElementById('authError').textContent = '비밀번호는 4자 이상이어야 합니다.';
        return;
    }
    
    document.getElementById('authError').textContent = '회원가입 중...';
    
    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            document.getElementById('authError').textContent = '';
            alert('회원가입 성공! 로그인해주세요.');
        } else {
            document.getElementById('authError').textContent = data.error || '회원가입 실패';
        }
    } catch (err) {
        console.error('Register error:', err);
        document.getElementById('authError').textContent = '서버 연결 실패';
    }
}

function logout() {
    console.log('Logging out...');
    isLoggingIn = false;
    slbmMissiles = [];
    attackProjectiles = [];
    localStorage.removeItem('token');
    stopUpdate();
    stopBackgroundLoops();
    if (rankingInterval) {
        clearInterval(rankingInterval);
        rankingInterval = null;
    }
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
    document.getElementById('loginScreen').classList.add('active');
    document.getElementById('gameScreen').classList.remove('active');
}

async function resetGame() {
    // Confirm before reset
    if (!confirm('게임을 초기화하시겠습니까?\n진행 중인 게임, 점수, 사용자 데이터가 모두 초기화됩니다.')) {
        return;
    }
    
    const token = localStorage.getItem('token');
    if (!token) {
        alert('로그인이 필요합니다.');
        return;
    }
    
    try {
        const res = await fetch('/api/reset', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await res.json();
        
        if (res.ok) {
            alert('내 기지가 초기화되었습니다. 새로운 위치에서 시작합니다.');
            // Reconnect to game
            if (socket) {
                socket.removeAllListeners();
                socket.disconnect();
                socket = null;
            }
            connectToGame();
        } else {
            alert(data.error || '초기화 실패');
        }
    } catch (error) {
        console.error('Reset error:', error);
        alert('서버 연결 실패');
    }
}

function connectToGame() {
    console.log('connectToGame called');
    stopUpdate();
    stopBackgroundLoops();
    
    // Disconnect existing socket if any
    if (socket) {
        console.log('Cleaning up existing socket');
        socket.removeAllListeners();
        socket.disconnect();
        socket = null;
    }
    
    // Clear existing ranking interval
    if (rankingInterval) {
        clearInterval(rankingInterval);
        rankingInterval = null;
    }
    
    // 화면 전환은 init 이벤트를 받은 뒤 수행
    
    socket = io({
        auth: {
            token: gameState.token,
            roomId: gameState.selectedRoom || localStorage.getItem('selectedRoom') || 'server1'
        },
        reconnection: false // 자동 재연결 비활성화
    });
    
    socket.on('connect', () => {
        console.log('Connected to server');
    });
    
    socket.on('connect_error', (error) => {
        console.error('Connection error:', error);
        isLoggingIn = false;
        if (socket) {
            socket.removeAllListeners();
            socket.disconnect();
            socket = null;
        }
        document.getElementById('loginScreen').classList.add('active');
        document.getElementById('gameScreen').classList.remove('active');
        document.getElementById('authError').textContent = '로그인 실패: 토큰이 유효하지 않거나 만료되었습니다.';
        localStorage.removeItem('token');
    });
    
    socket.on('disconnect', (reason) => {
        console.log('Disconnected:', reason);
        if (reason === 'io server disconnect' || reason === 'io client disconnect') {
            // Don't auto-reconnect
        }
    });
    
    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });
    
    socket.on('init', (data) => {
        console.log('Received init data:', data);
        
        try {
            gameState.userId = data.userId;
            gameState.map = hydrateClientMap(data.map);
            resetMapImageState();
            ensureMapImageLoaded();
            gameState.missiles = data.missiles || 0;
            
            console.log('Map loaded:', gameState.map ? 'yes' : 'no');
            console.log('Map size:', gameState.map ? `${gameState.map.width}x${gameState.map.height}` : 'no map');
            console.log('Land cells: GET /api/map/land-cells or run downloadLandCells() in browser console');
            
            gameState.players.clear();
            data.players.forEach(p => gameState.players.set(p.userId, p));
            console.log('Players loaded:', gameState.players.size);
            
            gameState.units.clear();
            data.units.forEach(u => gameState.units.set(u.id, u));
            console.log('Units loaded:', gameState.units.size);
            
            gameState.buildings.clear();
            data.buildings.forEach(b => gameState.buildings.set(b.id, b));
            console.log('Buildings loaded:', gameState.buildings.size);
            
            // Clear fog of war for fresh start
            gameState.fogOfWar.clear();
            slbmMissiles = [];
            attackProjectiles = [];
            fogDirty = true;
            minimapDirty = true;
            lastServerUpdateTime = 0;
            serverTickAvgMs = 100;
            interpolationDurationMs = 100;
            
            // Center camera on player's base
            const player = gameState.players.get(gameState.userId);
            if (player) {
                gameState.camera.x = player.baseX;
                gameState.camera.y = player.baseY;
                clampCameraToMapBounds();
                console.log('Camera centered at:', gameState.camera.x, gameState.camera.y);
            } else {
                console.warn('Player data not found!');
            }
            
            console.log('Starting game update loop...');
            updateHUD();
            updateFogOfWar(true); // Initial fog of war update
            renderMinimap();
            startBackgroundLoops();
            startUpdate();
            updateRankings();
            rankingInterval = setInterval(updateRankings, 5000);
            
            // 실제 화면 전환
            console.log('Switching to game screen...');
            document.getElementById('loginScreen').classList.remove('active');
            document.getElementById('gameScreen').classList.add('active');
            isLoggingIn = false;
            
            console.log('Game initialized successfully!');
        } catch (error) {
            console.error('Error in init handler:', error);
            socket.disconnect();
            isLoggingIn = false;
        }
    });
    
    socket.on('gameUpdate', (data) => {
        const nowMs = Date.now();
        if (lastServerUpdateTime > 0) {
            const tick = nowMs - lastServerUpdateTime;
            if (tick >= 40 && tick <= 500) {
                serverTickAvgMs = (serverTickAvgMs * 0.8) + (tick * 0.2);
                interpolationDurationMs = Math.max(90, Math.min(260, Math.round(serverTickAvgMs * 1.15)));
            }
        }
        lastServerUpdateTime = nowMs;

        data.players.forEach(p => gameState.players.set(p.userId, p));
        
        // Track which units exist in this update
        const serverUnitIds = new Set(data.units.map(u => u.id));
        
        // Remove units that no longer exist on server
        const toDelete = [];
        gameState.units.forEach((unit, id) => {
            if (!serverUnitIds.has(id)) {
                toDelete.push(id);
            }
        });
        toDelete.forEach(id => gameState.units.delete(id));
        
        // Update units with interpolation support
        data.units.forEach(u => {
            const existingUnit = gameState.units.get(u.id);
            if (existingUnit) {
                // Store previous display position for interpolation
                u.interpPrevX = existingUnit.interpDisplayX !== undefined ? existingUnit.interpDisplayX : existingUnit.x;
                u.interpPrevY = existingUnit.interpDisplayY !== undefined ? existingUnit.interpDisplayY : existingUnit.y;
                u.interpTargetX = u.x;
                u.interpTargetY = u.y;
                u.interpDisplayX = u.interpPrevX;
                u.interpDisplayY = u.interpPrevY;
                u.interpStartTime = nowMs;
                // Preserve client-side visual properties not tracked by server
                if (existingUnit.commandAngle !== undefined) u.commandAngle = existingUnit.commandAngle;
                if (existingUnit.turretAngles) u.turretAngles = existingUnit.turretAngles;
                if (existingUnit.lastTurretTargetTime !== undefined) {
                    u.lastTurretTargetX = existingUnit.lastTurretTargetX;
                    u.lastTurretTargetY = existingUnit.lastTurretTargetY;
                    u.lastTurretTargetTime = existingUnit.lastTurretTargetTime;
                }
            } else {
                // New unit - no interpolation needed
                u.interpDisplayX = u.x;
                u.interpDisplayY = u.y;
            }
            gameState.units.set(u.id, u);
        });
        
        // Track which buildings exist
        const serverBuildingIds = new Set(data.buildings.map(b => b.id));
        const buildingsToDelete = [];
        gameState.buildings.forEach((building, id) => {
            if (!serverBuildingIds.has(id)) {
                buildingsToDelete.push(id);
            }
        });
        buildingsToDelete.forEach(id => gameState.buildings.delete(id));
        
        data.buildings.forEach(b => gameState.buildings.set(b.id, b));
        fogDirty = true;
        if (nowMs - lastMinimapInvalidateTime >= 220) {
            minimapDirty = true;
            lastMinimapInvalidateTime = nowMs;
        }
        
        updateHUD();
        if (gameState.selection.size > 0) {
            updateSelectionInfo(); // Refresh production progress bar etc.
        }
    });
    
    socket.on('unitCreated', (unit) => {
        gameState.units.set(unit.id, unit);
        fogDirty = true;
        minimapDirty = true;
    });
    
    socket.on('buildingCreated', (building) => {
        gameState.buildings.set(building.id, building);
        fogDirty = true;
        minimapDirty = true;
    });
    
    socket.on('playerDefeated', (data) => {
        // Show kill log message on screen
        if (data.defeatedName && data.attackerName) {
            showKillLog(data.attackerName, data.defeatedName);
        }
        
        if (data.userId === gameState.userId && data.respawned) {
            // Reset local player data
            const player = gameState.players.get(gameState.userId);
            if (player) {
                player.resources = 1000;
                player.population = 0;
                player.maxPopulation = 10;
                player.combatPower = 0;
                player.score = 0;
                player.researchedSLBM = false;
            }
            gameState.missiles = 0;
            gameState.selection.clear();
            updateHUD();
            updateSelectionInfo();
            fogDirty = true;
            minimapDirty = true;
            alert('게임에서 패배했습니다. 새로운 게임을 시작합니다.');
        }
    });
    
    socket.on('slbmFired', (data) => {
        // Add missile to visualization array
        slbmMissiles.push({
            id: data.id,
            fromX: data.fromX,
            fromY: data.fromY,
            targetX: data.targetX,
            targetY: data.targetY,
            startTime: Date.now(),
            flightTime: 5000, // 5 seconds flight time
            impacted: false,
            userId: data.userId
        });
        minimapDirty = true;
        
        // Play launch sound (SLBM always audible as it reveals fog)
        playSoundLaunch();
        
        // Decrease missile count if it's our missile
        if (data.userId === gameState.userId) {
            gameState.missiles = Math.max(0, gameState.missiles - 1);
            updateHUD();
        }
        
        console.log('SLBM fired from', data.fromX, data.fromY, 'to', data.targetX, data.targetY);
    });

    socket.on('attackProjectileFired', (data) => {
        const baseId       = data.id || `${Date.now()}-${Math.random()}`;
        const startTime    = data.startTime || Date.now();
        const flightTime   = data.flightTime || 600;
        const isBattleship = data.shooterType === 'battleship';

        if (isBattleship) {
            const shooter = data.shooterId ? gameState.units.get(data.shooterId) : null;
            const shipAngle = (shooter && shooter.displayAngle !== undefined)
                ? shooter.displayAngle
                : (shooter && shooter.commandAngle !== undefined)
                    ? shooter.commandAngle
                    : Math.atan2(data.targetY - data.fromY, data.targetX - data.fromX);

            const shipX = (shooter && shooter.interpDisplayX !== undefined)
                ? shooter.interpDisplayX
                : ((shooter && shooter.x !== undefined) ? shooter.x : data.fromX);
            const shipY = (shooter && shooter.interpDisplayY !== undefined)
                ? shooter.interpDisplayY
                : ((shooter && shooter.y !== undefined) ? shooter.y : data.fromY);

            const turretCenters = getBattleshipTurretWorldStates(shipX, shipY, shipAngle, 60);
            const fireAngles = turretCenters.map(turret => Math.atan2(
                data.targetY - turret.centerY,
                data.targetX - turret.centerX
            ));

            if (shooter) {
                // Force render-side turrets to face the same shot target immediately.
                shooter.turretAngles = fireAngles.slice();
                shooter.lastTurretTargetX = data.targetX;
                shooter.lastTurretTargetY = data.targetY;
                shooter.lastTurretTargetTime = startTime;
            }

            const turretMuzzles = getBattleshipTurretWorldStates(shipX, shipY, shipAngle, 60, fireAngles);
            turretMuzzles.forEach((turret, i) => {
                attackProjectiles.push({
                    id: `${baseId}-${i}`,
                    fromX: turret.muzzleX,
                    fromY: turret.muzzleY,
                    targetX: data.targetX,
                    targetY: data.targetY,
                    targetId: data.targetId,
                    shooterType: 'battleship',
                    aimedShot: data.aimedShot || false,
                    startTime,
                    flightTime
                });
            });
        } else {
            attackProjectiles.push({
                id: baseId,
                fromX:      data.fromX,
                fromY:      data.fromY,
                targetX:    data.targetX,
                targetY:    data.targetY,
                targetId:   data.targetId,
                shooterType: data.shooterType || 'destroyer',
                aimedShot:  data.aimedShot || false,
                startTime,
                flightTime
            });
        }
        
        // Play cannon sound when battleship fires in currently visible area
        if (isBattleship && isPositionVisible(data.fromX, data.fromY)) {
            playSoundCannon();
        }
    });
    
    socket.on('slbmImpact', (data) => {
        // Mark missile as impacted for visualization
        slbmMissiles.forEach(missile => {
            if (!missile.impacted && (
                (data.id && missile.id === data.id) ||
                (Math.abs(missile.targetX - data.x) < 50 && Math.abs(missile.targetY - data.y) < 50)
            )) {
                missile.impacted = true;
                missile.impactTime = Date.now();
            }
        });
        
        // Play bomb sound (SLBM impact always audible)
        soundLaunch.pause();
        soundLaunch.currentTime = 0;
        playSoundBomb();
        
        // Clean up old missiles after 30 seconds
        setTimeout(() => {
            slbmMissiles = slbmMissiles.filter(m => !m.impacted || Date.now() - m.impactTime < 30000);
            minimapDirty = true;
        }, 30000);
        minimapDirty = true;
        
        console.log('SLBM impact at', data.x, data.y);
    });
    
    socket.on('slbmDestroyed', (data) => {
        // SLBM was intercepted - remove it from visualization
        slbmMissiles = slbmMissiles.filter(missile => missile.id !== data.id);
        minimapDirty = true;
        console.log('SLBM intercepted at', data.x, data.y);
    });
    
    socket.on('slbmDamaged', (data) => {
        // Update SLBM HP for visualization
        const missile = slbmMissiles.find(m => m.id === data.id);
        if (missile) {
            missile.hp = data.hp;
            missile.maxHp = data.maxHp;
        }
    });
    
    socket.on('missileProduced', (data) => {
        if (data.userId === gameState.userId) {
            gameState.missiles = data.count;
            updateHUD();
        }
    });
    
    socket.on('researchCompleted', (data) => {
        if (data.userId === gameState.userId) {
            alert('연구 완료: ' + data.research);
        }
    });
    
    socket.on('slbmProduced', (data) => {
        const building = gameState.buildings.get(data.buildingId);
        if (building) {
            building.slbmCount = data.count;
            minimapDirty = true;
        }
    });

    // Ship death explosion effect
    socket.on('unitDestroyed', (data) => {
        if (!isPositionVisible(data.x, data.y)) return;
        const debrisCount = data.type === 'battleship' ? 20 : (data.type === 'carrier' ? 18 : 12);
        const explosion = {
            x: data.x,
            y: data.y,
            startTime: Date.now(),
            duration: 1500,
            debris: []
        };
        for (let i = 0; i < debrisCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 40 + Math.random() * 120;
            explosion.debris.push({
                dx: Math.cos(angle) * speed,
                dy: Math.sin(angle) * speed,
                size: 2 + Math.random() * 5,
                color: Math.random() > 0.5 ? '#ff6600' : (Math.random() > 0.5 ? '#ffaa00' : '#ff3300'),
                rotation: Math.random() * Math.PI * 2
            });
        }
        explosionEffects.push(explosion);
    });

    // Building destruction explosion effect (grey debris)
    socket.on('buildingDestroyed', (data) => {
        if (!isPositionVisible(data.x, data.y)) return;
        const debrisCount = 25;
        const explosion = {
            x: data.x,
            y: data.y,
            startTime: Date.now(),
            duration: 2000,
            debris: []
        };
        for (let i = 0; i < debrisCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 30 + Math.random() * 150;
            explosion.debris.push({
                dx: Math.cos(angle) * speed,
                dy: Math.sin(angle) * speed,
                size: 3 + Math.random() * 8,
                color: Math.random() > 0.6 ? '#888888' : (Math.random() > 0.5 ? '#666666' : '#aaaaaa'),
                rotation: Math.random() * Math.PI * 2
            });
        }
        // Add some fire/smoke debris too
        for (let i = 0; i < 8; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 20 + Math.random() * 80;
            explosion.debris.push({
                dx: Math.cos(angle) * speed,
                dy: Math.sin(angle) * speed,
                size: 4 + Math.random() * 6,
                color: Math.random() > 0.5 ? '#ff6600' : '#cc4400',
                rotation: Math.random() * Math.PI * 2
            });
        }
        explosionEffects.push(explosion);
    });
}

function startBackgroundLoops() {
    if (!fogIntervalId) {
        fogIntervalId = setInterval(() => {
            updateFogOfWar();
        }, FOG_UPDATE_INTERVAL);
    }

    if (!minimapIntervalId) {
        minimapIntervalId = setInterval(() => {
            if (gameState.map && minimapDirty) {
                renderMinimap();
                minimapDirty = false;
            }
        }, MINIMAP_UPDATE_INTERVAL);
    }
}

function stopBackgroundLoops() {
    if (fogIntervalId) {
        clearInterval(fogIntervalId);
        fogIntervalId = null;
    }
    if (minimapIntervalId) {
        clearInterval(minimapIntervalId);
        minimapIntervalId = null;
    }
}

// Update fog of war based on player's units and buildings
function updateFogOfWar(force = false) {
    if (!gameState.map) return;
    if (!force && !fogDirty) return;
    
    const now = Date.now();
    const gridSize = getMapGridSize(gameState.map);
    const cellSize = getMapCellSize(gameState.map); // World units per grid cell
    if (!gridSize || !cellSize) return;

    // Ensure the offscreen fog canvas exists (creates it on first call / grid-size change).
    ensureFogLayerCanvas(gridSize);
    
    // Vision ranges (in world units) - increased for better visibility
    const visionRanges = {
        'worker': 1000,
        'destroyer': 1500,
        'cruiser': 1200,
        'battleship': 3200,
        'carrier': 2000,
        'submarine': 800
    };
    
    // Only update for own units (use == for type coercion).
    // Sampling keeps fog updates stable when hundreds of units are selected/active.
    // PERF: Reuse module-level _ownUnitsTemp array to avoid new [] every tick.
    _ownUnitsTemp.length = 0;
    gameState.units.forEach(unit => {
        if (unit.userId == gameState.userId) {
            _ownUnitsTemp.push(unit);
        }
    });
    const maxVisionSources = 180;
    const unitSampleStep = _ownUnitsTemp.length > maxVisionSources
        ? Math.ceil(_ownUnitsTemp.length / maxVisionSources)
        : 1;

    for (let i = 0; i < _ownUnitsTemp.length; i += unitSampleStep) {
        const unit = _ownUnitsTemp[i];
        const radius = visionRanges[unit.type] || 1000;
        const gridX = Math.floor(unit.x / cellSize);
        const gridY = Math.floor(unit.y / cellSize);
        const gridRadius = Math.ceil(radius / cellSize);
        const offsets = getFogCircleOffsets(gridRadius);
        revealFogArea(gridX, gridY, gridSize, offsets, now);
    }
    
    // Update for own buildings (provide vision even if not complete)
    gameState.buildings.forEach(building => {
        if (building.userId == gameState.userId) {
            const radius = 2000; // Building vision range - large for good visibility
            const gridX = Math.floor(building.x / cellSize);
            const gridY = Math.floor(building.y / cellSize);
            const gridRadius = Math.ceil(radius / cellSize);
            const offsets = getFogCircleOffsets(gridRadius);
            revealFogArea(gridX, gridY, gridSize, offsets, now);
        }
    });

    // Reveal fog around active SLBM missiles (all SLBMs visible to everyone)
    const slbmVisionRadius = 2000;
    const slbmGridRadius = Math.ceil(slbmVisionRadius / cellSize);
    const slbmOffsets = getFogCircleOffsets(slbmGridRadius);
    slbmMissiles.forEach(missile => {
        if (!missile.impacted) {
            const progress = Math.min(1, (now - missile.startTime) / missile.flightTime);
            const mx = missile.fromX + (missile.targetX - missile.fromX) * progress;
            const my = missile.fromY + (missile.targetY - missile.fromY) * progress;
            const gridX = Math.floor(mx / cellSize);
            const gridY = Math.floor(my / cellSize);
            revealFogArea(gridX, gridY, gridSize, slbmOffsets, now);
        }
        // Temporarily reveal impact area
        if (missile.impacted && missile.impactTime && (now - missile.impactTime < 10000)) {
            const gridX = Math.floor(missile.targetX / cellSize);
            const gridY = Math.floor(missile.targetY / cellSize);
            revealFogArea(gridX, gridY, gridSize, slbmOffsets, now);
        }
    });

    // Rebuild the offscreen fog canvas to reflect all reveals made in this tick.
    // This runs at ~1.5 Hz (FOG_UPDATE_INTERVAL), not 60 fps.
    refreshFogLayer(gridSize, now);

    fogDirty = false;
    minimapDirty = true;
}

// Initialize - show login screen by default
document.getElementById('loginScreen').classList.add('active');
document.getElementById('gameScreen').classList.remove('active');

// Don't auto-login to prevent infinite reconnection issues
// Users must login manually
localStorage.removeItem('token'); // Clear any old tokens
