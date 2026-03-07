// Game state
let socket = null;
let rankingInterval = null;
let slbmTargetingMode = false;
let mineTargetingMode = false;
let airstrikeTargetingMode = false;
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
const APP_NAME = 'MW Craft';
const CAMERA_EDGE_PAN_SPEED = 3800;
const FOG_UPDATE_INTERVAL = 650;
const MINIMAP_UPDATE_INTERVAL = 500;
const SECRET_CLICK_STREAK_RESET_MS = 900;
const SECRET_RANKING_CLICK_TARGET = 10;
const SECRET_MINIMAP_CLICK_TARGET = 22;
const TEMPORARY_FULL_MAP_REVEAL_MS = 5000;
const fogCircleOffsetsCache = new Map();
const rankingPanelSecretClicks = { count: 0, lastAt: 0 };
const minimapSecretClicks = { count: 0, lastAt: 0 };
let fullMapRevealUntil = 0;
let fullMapRevealTimeoutId = null;

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

// Cruiser Aegis image
let cruiserAegisImage = null;
let cruiserAegisImageLoaded = false;

// Destroyer image
let destroyerImage = null;
let destroyerImageLoaded = false;

// Airstrike image
let airstrikeImage = null;
let airstrikeImageLoaded = false;

// Building images - HQ
let hqImage = null;
let hqImageLoaded = false;

// Building images - Power Plant (bjs, bjs1, bjs2)
let bjsImages = [null, null, null]; // [bjs, bjs1, bjs2]
let bjsImagesLoaded = [false, false, false];

// Building images - Shipyard (jss, jss1, jss2, jss3)
let jssImages = [null, null, null, null];
let jssImagesLoaded = [false, false, false, false];

// Building images - Naval Academy (djss ~ djss9)
let djssImages = Array(10).fill(null);
let djssImagesLoaded = Array(10).fill(false);

// Building images - Defense Tower / Missile Silo
let defenseTowerBaseImage = null;
let defenseTowerBaseLoaded = false;
let defenseTowerCannonImage = null;
let defenseTowerCannonLoaded = false;
let missileSiloImage = null;
let missileSiloLoaded = false;

// Building animation state
let buildingAnimationTimers = {}; // buildingId -> animation state

// Power plant animation: bjs2(4s) -> bjs1(3s) -> bjs(3s), cycle = 10s
const POWER_PLANT_CYCLE_MS = 10000;
const COASTAL_BUILDING_SIZE_SCALE = 0.6;
const POWER_PLANT_SIZE_SCALE = COASTAL_BUILDING_SIZE_SCALE * 0.7;
const FIXED_BUILDING_IMAGE_MAX_DIMENSION = 200;
const DEFENSE_TOWER_CANNON_START = Object.freeze({ x: 5, y: 8 });
const DEFENSE_TOWER_CANNON_MUZZLE = Object.freeze({ x: 21, y: 12 });
const AIRSTRIKE_TARGET_RADIUS = 400;
const DESTROYER_VISION_RADIUS = 1000;
const DESTROYER_SEARCH_VISION_RADIUS = 4800;
const DESTROYER_MAX_MINES = 5;
const WORKER_FILL_COLOR = 0x8f99a3;
const WORKER_OUTLINE_COLOR = 0xe4e8eb;
const QUEUE_HIGHLIGHT_BG = 'rgba(143,153,163,0.28)';
const QUEUE_HIGHLIGHT_BORDER = '#b8c0c7';

// Building display size (derived from image scaling, same ratio as ships)
let buildingDisplaySize = { width: 200, height: 200 }; // updated on image load
let buildingSizeInitialized = false;

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
        battleshipBaseImage.src = '/assets/images/units/battleshipbase.png';
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
        mainCannonImage.src = '/assets/images/units/maincannon.png';
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
        submarineImage.src = '/assets/images/units/submarine.png';
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
        cruiserImage.src = '/assets/images/units/cruiser.png';
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
        carrierImage.src = '/assets/images/units/carrier.png';
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
        frigateImage.src = '/assets/images/units/frigate.png';
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
        fighterImage.src = '/assets/images/units/fighter.png';
    }
}

function loadCruiserAegisImage() {
    if (!cruiserAegisImage) {
        cruiserAegisImage = new Image();
        cruiserAegisImage.onload = () => {
            cruiserAegisImageLoaded = true;
            console.log('Cruiser Aegis image loaded');
        };
        cruiserAegisImage.onerror = () => {
            console.warn('Failed to load cruiseraegis.png');
        };
        cruiserAegisImage.src = '/assets/images/units/cruiseraegis.png';
    }
}

function loadDestroyerImage() {
    if (!destroyerImage) {
        destroyerImage = new Image();
        destroyerImage.onload = () => {
            destroyerImageLoaded = true;
            console.log('Destroyer image loaded');
        };
        destroyerImage.onerror = () => {
            console.warn('Failed to load destroyer.png');
        };
        destroyerImage.src = '/assets/images/units/destroyer.png';
    }
}

function loadAirstrikeImage() {
    if (!airstrikeImage) {
        airstrikeImage = new Image();
        airstrikeImage.onload = () => {
            airstrikeImageLoaded = true;
            console.log('Airstrike image loaded');
        };
        airstrikeImage.onerror = () => {
            console.warn('Failed to load airstrike.png');
        };
        airstrikeImage.src = '/assets/images/units/airstrike.png';
    }
}

// Initialize all ship images on load
loadBattleshipImages();
loadSubmarineImage();
loadCruiserImage();
loadCarrierImage();
loadFrigateImage();
loadFighterImage();
loadCruiserAegisImage();
loadDestroyerImage();
loadAirstrikeImage();

// Load building images
function loadBuildingImages() {
    hqImage = new Image();
    hqImage.onload = () => {
        hqImageLoaded = true;
        console.log('hq.png image loaded');
        if (!buildingSizeInitialized) {
            const origH = hqImage.height;
            const origW = hqImage.width;
            const heightMult = 6.6; // same as ships
            const baseSize = 60;    // same as ships
            const displayHeight = baseSize * heightMult;
            const displayWidth = displayHeight * (origW / origH);
            buildingDisplaySize = { width: displayWidth, height: displayHeight };
            buildingSizeInitialized = true;
            console.log(`Building display size set to ${displayWidth.toFixed(0)}x${displayHeight.toFixed(0)}`);
        }
    };
    hqImage.onerror = () => console.warn('Failed to load hq.png');
    hqImage.src = '/assets/images/buildings/hq.png';

    // Power plant images: bjs, bjs1, bjs2
    const bjsNames = ['bjs', 'bjs1', 'bjs2'];
    for (let i = 0; i < 3; i++) {
        const idx = i;
        bjsImages[idx] = new Image();
        bjsImages[idx].onload = () => {
            bjsImagesLoaded[idx] = true;
            console.log(`${bjsNames[idx]} image loaded`);
        };
        bjsImages[idx].onerror = () => console.warn(`Failed to load ${bjsNames[idx]}.png`);
        bjsImages[idx].src = `/assets/images/buildings/${bjsNames[idx]}.png`;
    }

    // Shipyard images: jss, jss1, jss2, jss3
    const jssNames = ['jss', 'jss1', 'jss2', 'jss3'];
    for (let i = 0; i < jssNames.length; i++) {
        const idx = i;
        jssImages[idx] = new Image();
        jssImages[idx].onload = () => {
            jssImagesLoaded[idx] = true;
            console.log(`${jssNames[idx]} image loaded`);
        };
        jssImages[idx].onerror = () => console.warn(`Failed to load ${jssNames[idx]}.png`);
        jssImages[idx].src = `/assets/images/buildings/${jssNames[idx]}.png`;
    }

    // Naval academy images: djss, djss1 ... djss9
    const djssNames = ['djss', 'djss1', 'djss2', 'djss3', 'djss4', 'djss5', 'djss6', 'djss7', 'djss8', 'djss9'];
    for (let i = 0; i < djssNames.length; i++) {
        const idx = i;
        djssImages[idx] = new Image();
        djssImages[idx].onload = () => {
            djssImagesLoaded[idx] = true;
            console.log(`${djssNames[idx]} image loaded`);
        };
        djssImages[idx].onerror = () => console.warn(`Failed to load ${djssNames[idx]}.png`);
        djssImages[idx].src = `/assets/images/buildings/${djssNames[idx]}.png`;
    }

    defenseTowerBaseImage = new Image();
    defenseTowerBaseImage.onload = () => {
        defenseTowerBaseLoaded = true;
        console.log('turret.png image loaded');
    };
    defenseTowerBaseImage.onerror = () => console.warn('Failed to load turret.png');
    defenseTowerBaseImage.src = '/assets/images/buildings/turret.png';

    defenseTowerCannonImage = new Image();
    defenseTowerCannonImage.onload = () => {
        defenseTowerCannonLoaded = true;
        console.log('turretcannon.png image loaded');
    };
    defenseTowerCannonImage.onerror = () => console.warn('Failed to load turretcannon.png');
    defenseTowerCannonImage.src = '/assets/images/buildings/turretcannon.png';

    missileSiloImage = new Image();
    missileSiloImage.onload = () => {
        missileSiloLoaded = true;
        console.log('silo.png image loaded');
    };
    missileSiloImage.onerror = () => console.warn('Failed to load silo.png');
    missileSiloImage.src = '/assets/images/buildings/silo.png';
}
loadBuildingImages();

// Get current power plant image index based on 10-second cycle
// bjs2(4s) -> bjs1(3s) -> bjs(3s)
function getPowerPlantImageIndex() {
    const elapsed = Date.now() % POWER_PLANT_CYCLE_MS;
    if (elapsed < 4000) return 2;       // bjs2 (0-4s)
    else if (elapsed < 7000) return 1;  // bjs1 (4-7s)
    else return 0;                       // bjs  (7-10s)
}

function getBuildingProductionProgress(building) {
    if (!building || !building.producing || !building.producing.buildTime) return 0;
    const elapsed = Date.now() - building.producing.startTime;
    return Math.max(0, Math.min(1, elapsed / building.producing.buildTime));
}

function getShipyardImageIndex(building) {
    const progress = getBuildingProductionProgress(building);
    if (progress < 0.25) return 0;  // jss
    if (progress < 0.50) return 1;  // jss1
    if (progress < 0.75) return 2;  // jss2
    return 3;                       // jss3
}

function getNavalAcademyImageIndex(building) {
    const progress = getBuildingProductionProgress(building);
    return Math.min(djssImages.length - 1, Math.floor(progress * djssImages.length));
}

function getFixedImageDisplaySize(image, maxDimension = FIXED_BUILDING_IMAGE_MAX_DIMENSION) {
    const safeWidth = Math.max(1, (image && image.width) ? image.width : 29);
    const safeHeight = Math.max(1, (image && image.height) ? image.height : 24);
    const scale = maxDimension / Math.max(safeWidth, safeHeight);
    return {
        width: safeWidth * scale,
        height: safeHeight * scale,
        scale
    };
}

function getDefenseTowerVisualMetrics() {
    const baseImage = defenseTowerBaseLoaded ? defenseTowerBaseImage : null;
    const cannonImage = defenseTowerCannonLoaded ? defenseTowerCannonImage : null;
    const baseSize = getFixedImageDisplaySize(baseImage, FIXED_BUILDING_IMAGE_MAX_DIMENSION);
    const baseOriginalWidth = Math.max(1, (baseImage && baseImage.width) ? baseImage.width : 29);
    const baseOriginalHeight = Math.max(1, (baseImage && baseImage.height) ? baseImage.height : 24);
    const cannonOriginalWidth = Math.max(1, (cannonImage && cannonImage.width) ? cannonImage.width : 29);
    const cannonOriginalHeight = Math.max(1, (cannonImage && cannonImage.height) ? cannonImage.height : 24);
    const scaleX = baseSize.width / baseOriginalWidth;
    const scaleY = baseSize.height / baseOriginalHeight;
    return {
        baseWidth: baseSize.width,
        baseHeight: baseSize.height,
        cannonWidth: cannonOriginalWidth * scaleX,
        cannonHeight: cannonOriginalHeight * scaleY,
        cannonPivotLocalX: -(baseSize.width / 2) + (DEFENSE_TOWER_CANNON_START.x * scaleX),
        cannonPivotLocalY: -(baseSize.height / 2) + (DEFENSE_TOWER_CANNON_START.y * scaleY),
        cannonAnchorX: DEFENSE_TOWER_CANNON_START.x / cannonOriginalWidth,
        cannonAnchorY: DEFENSE_TOWER_CANNON_START.y / cannonOriginalHeight
    };
}

const DEFAULT_BATTLESHIP_BASE_WIDTH = 19;
const DEFAULT_BATTLESHIP_BASE_HEIGHT = 100;
const DEFAULT_MAIN_CANNON_WIDTH = 11;
const DEFAULT_MAIN_CANNON_HEIGHT = 9;
const BATTLESHIP_BASE_HEIGHT_MULTIPLIER = 2.2 * 3 * 1.2;
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

function getSlbmWorldPosition(missile, nowMs = Date.now()) {
    if (!missile || missile.impacted) return null;
    const progress = Math.max(0, Math.min(1, (nowMs - missile.startTime) / missile.flightTime));
    return {
        x: missile.fromX + (missile.targetX - missile.fromX) * progress,
        y: missile.fromY + (missile.targetY - missile.fromY) * progress
    };
}

function getDefenseTowerAimTarget(building) {
    if (!building) return null;

    if (building.attackTargetId) {
        if (building.attackTargetType === 'unit') {
            const targetUnit = gameState.units.get(building.attackTargetId);
            if (targetUnit) {
                return {
                    x: targetUnit.interpDisplayX !== undefined ? targetUnit.interpDisplayX : targetUnit.x,
                    y: targetUnit.interpDisplayY !== undefined ? targetUnit.interpDisplayY : targetUnit.y
                };
            }
        } else if (building.attackTargetType === 'slbm') {
            const targetMissile = slbmMissiles.find(missile => missile.id === building.attackTargetId);
            const missilePos = getSlbmWorldPosition(targetMissile);
            if (missilePos) return missilePos;
        }
    }

    if (
        Number.isFinite(building.turretTargetX) &&
        Number.isFinite(building.turretTargetY) &&
        Number.isFinite(building.lastTurretTargetTime) &&
        (Date.now() - building.lastTurretTargetTime) <= 1200
    ) {
        return { x: building.turretTargetX, y: building.turretTargetY };
    }

    return null;
}

function normalizeBuildingPayload(building) {
    if (!building) return building;
    if (building.type === 'research_lab') {
        return { ...building, type: 'missile_silo' };
    }
    return building;
}

function mergeUnitState(existingUnit, nextUnit, nowMs) {
    if (!existingUnit) {
        return {
            ...nextUnit,
            interpDisplayX: nextUnit.x,
            interpDisplayY: nextUnit.y
        };
    }

    const merged = {
        ...existingUnit,
        ...nextUnit
    };

    merged.interpPrevX = existingUnit.interpDisplayX !== undefined ? existingUnit.interpDisplayX : existingUnit.x;
    merged.interpPrevY = existingUnit.interpDisplayY !== undefined ? existingUnit.interpDisplayY : existingUnit.y;
    merged.interpTargetX = merged.x;
    merged.interpTargetY = merged.y;
    merged.interpDisplayX = merged.interpPrevX;
    merged.interpDisplayY = merged.interpPrevY;
    merged.interpStartTime = nowMs;

    const incomingTargetTime = Number.isFinite(nextUnit.lastTurretTargetTime) ? nextUnit.lastTurretTargetTime : -Infinity;
    const existingTargetTime = Number.isFinite(existingUnit.lastTurretTargetTime) ? existingUnit.lastTurretTargetTime : -Infinity;
    if (existingTargetTime > incomingTargetTime) {
        merged.lastTurretTargetX = existingUnit.lastTurretTargetX;
        merged.lastTurretTargetY = existingUnit.lastTurretTargetY;
        merged.lastTurretTargetTime = existingUnit.lastTurretTargetTime;
    }

    return merged;
}

function mergeBuildingVisualState(existingBuilding, nextBuilding) {
    const normalizedBuilding = normalizeBuildingPayload(nextBuilding);
    const merged = existingBuilding
        ? { ...existingBuilding, ...normalizedBuilding }
        : normalizedBuilding;
    if (!existingBuilding) return merged;

    if (!Number.isFinite(merged.turretAngle) && Number.isFinite(existingBuilding.turretAngle)) {
        merged.turretAngle = existingBuilding.turretAngle;
    }

    const incomingTargetTime = Number.isFinite(normalizedBuilding.lastTurretTargetTime) ? normalizedBuilding.lastTurretTargetTime : -Infinity;
    const existingTargetTime = Number.isFinite(existingBuilding.lastTurretTargetTime) ? existingBuilding.lastTurretTargetTime : -Infinity;
    if (existingTargetTime > incomingTargetTime) {
        merged.turretTargetX = existingBuilding.turretTargetX;
        merged.turretTargetY = existingBuilding.turretTargetY;
        merged.lastTurretTargetTime = existingBuilding.lastTurretTargetTime;
        if (!merged.attackTargetId) merged.attackTargetId = existingBuilding.attackTargetId;
        if (!merged.attackTargetType) merged.attackTargetType = existingBuilding.attackTargetType;
        if (!Number.isFinite(merged.turretAngle) && Number.isFinite(existingBuilding.turretAngle)) {
            merged.turretAngle = existingBuilding.turretAngle;
        }
    }

    return merged;
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
    inspectedUnitId: null,
    selectionBox: null,
    buildMode: null,
    workerMode: null, // 'gather' or 'build'
    missiles: 0 // Player's missile count
};

function resetSecretClickStreak(streak) {
    streak.count = 0;
    streak.lastAt = 0;
}

function registerSecretRapidClick(streak, requiredClicks, now = Date.now()) {
    if ((now - streak.lastAt) > SECRET_CLICK_STREAK_RESET_MS) {
        streak.count = 0;
    }
    streak.lastAt = now;
    streak.count += 1;
    if (streak.count === requiredClicks) {
        resetSecretClickStreak(streak);
        return true;
    }
    return false;
}

function invalidateFogAndMinimap() {
    fogDirty = true;
    minimapDirty = true;
}

function hasTemporaryFullMapReveal() {
    return fullMapRevealUntil > Date.now();
}

function clearTemporaryFullMapReveal() {
    fullMapRevealUntil = 0;
    if (fullMapRevealTimeoutId) {
        clearTimeout(fullMapRevealTimeoutId);
        fullMapRevealTimeoutId = null;
    }
    invalidateFogAndMinimap();
}

function activateTemporaryFullMapReveal(durationMs = TEMPORARY_FULL_MAP_REVEAL_MS) {
    fullMapRevealUntil = Date.now() + durationMs;
    if (fullMapRevealTimeoutId) {
        clearTimeout(fullMapRevealTimeoutId);
    }
    invalidateFogAndMinimap();
    if (gameState.map) {
        updateFogOfWar(true);
        renderMinimap();
    }
    fullMapRevealTimeoutId = setTimeout(() => {
        fullMapRevealUntil = 0;
        fullMapRevealTimeoutId = null;
        invalidateFogAndMinimap();
        if (gameState.map) {
            updateFogOfWar(true);
        }
    }, durationMs);
}

// ==================== SOUND EFFECTS SYSTEM (MP3 Files) ====================
function createSound(src, options = {}) {
    const audio = new Audio(src);
    audio.preload = 'auto';
    audio.volume = options.volume ?? 1;
    audio.loop = !!options.loop;
    audio.addEventListener('error', () => {
        console.warn(`Failed to load sound: ${src}`);
    });
    return audio;
}

const soundLaunch = createSound('/launchsound.mp3', { volume: 0.5, loop: true });
const soundBomb = createSound('/bombsound.mp3', { volume: 0.6 });
const soundCannon = createSound('/cannonsound.mp3', { volume: 0.4 });

function playOneShot(soundTemplate) {
    try {
        const sound = soundTemplate.cloneNode();
        sound.volume = soundTemplate.volume;
        sound.play().catch(() => {});
    } catch(e) {}
}

function startSlbmFlightSound() {
    try {
        const hasActiveSlbm = slbmMissiles.some(missile => !missile.impacted);
        if (!hasActiveSlbm || !soundLaunch.paused) return;
        soundLaunch.currentTime = 0;
        soundLaunch.play().catch(() => {});
    } catch(e) {}
}

function stopSlbmFlightSound(force = false) {
    try {
        const hasActiveSlbm = slbmMissiles.some(missile => !missile.impacted);
        if (!force && hasActiveSlbm) return;
        soundLaunch.pause();
        soundLaunch.currentTime = 0;
    } catch(e) {}
}

function playSoundBomb() {
    playOneShot(soundBomb);
}

function playSoundCannon() {
    playOneShot(soundCannon);
}
// ==================== END SOUND EFFECTS ====================

// Canvas setup - PixiJS WebGL Renderer
const canvas = document.getElementById('gameCanvas');
const minimap = document.getElementById('minimap');
const minimapCtx = minimap.getContext('2d');

// PixiJS Application & Layer System
let pixiApp = null;
let worldContainer = null;
let mapLayer = null;
let landMaskLayer = null;
let buildingGfx = null;
let buildingSpriteLayer = null;
let unitLayer = null;
let effectsGfx = null;
let airstrikeLayer = null;
let fogLayer = null;
let overlayGfx = null;

// Sprite pool maps
const unitSpriteMap = new Map();   // unitId -> { container, mainGfx, hpBg, hpFg, labelGfx, selGfx, type, ... }
const texCache = new Map();        // src -> PIXI.Texture
let fogTexture = null;
let mapTexture = null;
let landMaskTexture = null;

function getOrCreateTexture(image) {
    if (!image || !image.complete || !image.naturalWidth) return null;
    let tex = texCache.get(image.src);
    if (!tex) {
        tex = PIXI.Texture.from(image);
        texCache.set(image.src, tex);
    }
    return tex;
}

function getUnitImage(unitOrType) {
    const type = (typeof unitOrType === 'string') ? unitOrType : unitOrType.type;
    const unit = (typeof unitOrType === 'object') ? unitOrType : null;
    switch (type) {
        case 'submarine': return submarineImageLoaded ? submarineImage : null;
        case 'cruiser':
            if (unit && unit.aegisMode && cruiserAegisImageLoaded) return cruiserAegisImage;
            return cruiserImageLoaded ? cruiserImage : null;
        case 'carrier': return carrierImageLoaded ? carrierImage : null;
        case 'frigate': return frigateImageLoaded ? frigateImage : null;
        case 'aircraft': return fighterImageLoaded ? fighterImage : null;
        case 'destroyer': return destroyerImageLoaded ? destroyerImage : null;
        default: return null;
    }
}

function initPixiApp() {
    pixiApp = new PIXI.Application({
        view: canvas,
        width: window.innerWidth,
        height: window.innerHeight,
        backgroundColor: 0x1a3a5c,
        antialias: false,
        resolution: 1,
        autoDensity: false,
        powerPreference: 'high-performance',
    });
    pixiApp.ticker.stop(); // We manage our own render loop

    worldContainer = new PIXI.Container();
    pixiApp.stage.addChild(worldContainer);

    // Layers in draw order
    mapLayer = new PIXI.Sprite();
    mapLayer.visible = false;
    worldContainer.addChild(mapLayer);

    landMaskLayer = new PIXI.Sprite();
    landMaskLayer.alpha = IMAGE_LAND_MASK_ALPHA;
    landMaskLayer.visible = false;
    worldContainer.addChild(landMaskLayer);

    buildingGfx = new PIXI.Graphics();
    worldContainer.addChild(buildingGfx);

    buildingSpriteLayer = new PIXI.Container();
    worldContainer.addChild(buildingSpriteLayer);

    unitLayer = new PIXI.Container();
    unitLayer.sortableChildren = false;
    worldContainer.addChild(unitLayer);

    effectsGfx = new PIXI.Graphics();
    worldContainer.addChild(effectsGfx);

    airstrikeLayer = new PIXI.Container();
    worldContainer.addChild(airstrikeLayer);

    fogLayer = new PIXI.Sprite();
    fogLayer.visible = false;
    worldContainer.addChild(fogLayer);

    overlayGfx = new PIXI.Graphics();
    worldContainer.addChild(overlayGfx);
}

initPixiApp();

function resizeCanvas() {
    if (pixiApp) {
        pixiApp.renderer.resize(window.innerWidth, window.innerHeight);
    }
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
        'naval_academy': '대형조선소',
        'power_plant': '발전소',
        'missile_silo': '미사일 사일로',
        'defense_tower': '방어 타워'
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
                            const hitRadius = getBuildingHitboxHalfSize(building);
                            if (Math.sqrt(dx * dx + dy * dy) < hitRadius) {
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
        } else if (airstrikeTargetingMode) {
            const targetPoint = clampWorldPointToMap(worldX, worldY);
            const selectedCarriers = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type === 'carrier' && (u.airstrikeReady || gameState.username === 'JsonParc'));
            
            if (selectedCarriers.length > 0 && socket) {
                socket.emit('launchAirstrike', {
                    unitId: selectedCarriers[0].id,
                    targetX: targetPoint.x,
                    targetY: targetPoint.y
                });
            }
            airstrikeTargetingMode = false;
            canvas.style.cursor = 'crosshair';
            document.getElementById('airstrikeInstructions').style.display = 'none';
        } else if (mineTargetingMode) {
            const targetPoint = clampWorldPointToMap(worldX, worldY);
            const selectedDestroyers = Array.from(gameState.selection)
                .map(id => gameState.units.get(id))
                .filter(u => u && u.userId === gameState.userId && u.type === 'destroyer');
            
            if (selectedDestroyers.length > 0 && socket && canLayMineAtTarget(selectedDestroyers[0], targetPoint.x, targetPoint.y)) {
                socket.emit('layMine', {
                    unitId: selectedDestroyers[0].id,
                    targetX: targetPoint.x,
                    targetY: targetPoint.y
                });
            }
            mineTargetingMode = false;
            canvas.style.cursor = 'crosshair';
            document.getElementById('mineInstructions').style.display = 'none';
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
                                const hitRadius = getBuildingHitboxHalfSize(building);
                                if (Math.sqrt(dx * dx + dy * dy) < hitRadius) {
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

function cancelActiveModes() {
    gameState.buildMode = null;
    gameState.workerMode = null;
    slbmTargetingMode = false;
    mineTargetingMode = false;
    airstrikeTargetingMode = false;
    setAttackMode(false);
    document.getElementById('slbmInstructions').style.display = 'none';
    document.getElementById('airstrikeInstructions').style.display = 'none';
    document.getElementById('mineInstructions').style.display = 'none';
}

window.addEventListener('keydown', (e) => {
    keys[e.key] = true;
    
    // Cancel all modes with Escape
    if (e.key === 'Escape') {
        cancelActiveModes();
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
    
    // Hold position - 'h'
    if ((e.key === 'h' || e.key === 'H') && !e.repeat) {
        const selectedUnits = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId);
        if (selectedUnits.length > 0 && socket) {
            cancelActiveModes();
            attackTarget = null;
            selectedUnits.forEach(unit => {
                unit.holdPosition = true;
                unit.attackMove = false;
                unit.attackTargetId = null;
                unit.attackTargetType = null;
                unit.targetX = null;
                unit.targetY = null;
                unit.pathWaypoints = null;
                unit.gatheringResourceId = null;
                unit.buildingType = null;
                unit.buildTargetX = null;
                unit.buildTargetY = null;
            });
            socket.emit('holdPosition', { unitIds: selectedUnits.map(unit => unit.id) });
            updateSelectionInfo();
            return;
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

function getUnitSelectionBaseSize(unit) {
    return unit.type === 'worker' ? 40 : (unit.type === 'mine' ? 40 : (unit.type === 'aircraft' ? 20 : (unit.type === 'frigate' ? 35 : (unit.type === 'destroyer' ? 45 : 60))));
}

function getUnitDisplayPosition(unit) {
    return {
        x: unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x,
        y: unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y
    };
}

function isUnitVisibleToPlayer(unit) {
    if (!unit) return false;
    if (hasTemporaryFullMapReveal()) return true;
    if (unit.type === 'submarine' && unit.userId !== gameState.userId && !unit.isDetected) return false;
    if (unit.type === 'mine' && unit.userId !== gameState.userId && !unit.isDetected) return false;
    const { x, y } = getUnitDisplayPosition(unit);
    if (unit.userId !== gameState.userId && !isPositionVisible(x, y)) return false;
    return true;
}

function isPointInsideUnitHitbox(unit, worldX, worldY) {
    const baseSize = getUnitSelectionBaseSize(unit);
    const { x, y } = getUnitDisplayPosition(unit);
    const dx = worldX - x;
    const dy = worldY - y;

    if (unit.type === 'worker' || unit.type === 'mine') {
        return Math.sqrt(dx * dx + dy * dy) <= baseSize;
    }

    const heightMult = (unit.type === 'aircraft') ? 2.5 : (unit.type === 'battleship' ? BATTLESHIP_BASE_HEIGHT_MULTIPLIER : 6.6);
    const img = getUnitImage(unit);
    const aspectRatio = (img && img.width && img.height) ? (img.width / img.height) : 0.25;
    const semiMajor = (baseSize * heightMult) / 2;
    const semiMinor = (baseSize * heightMult * aspectRatio) / 2;
    const angle = unit.displayAngle !== undefined ? unit.displayAngle : 0;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    return (localX * localX) / (semiMajor * semiMajor) + (localY * localY) / (semiMinor * semiMinor) <= 1;
}

function findInspectableEnemyUnitAt(worldX, worldY) {
    let clickedUnitId = null;
    let closestDistanceSq = Infinity;

    gameState.units.forEach((unit, unitId) => {
        if (unit.userId === gameState.userId) return;
        if (!isUnitVisibleToPlayer(unit)) return;
        if (!isPointInsideUnitHitbox(unit, worldX, worldY)) return;

        const { x, y } = getUnitDisplayPosition(unit);
        const dx = worldX - x;
        const dy = worldY - y;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq < closestDistanceSq) {
            closestDistanceSq = distanceSq;
            clickedUnitId = unitId;
        }
    });

    return clickedUnitId;
}

function getInspectedUnit() {
    if (!gameState.inspectedUnitId) return null;
    const unit = gameState.units.get(gameState.inspectedUnitId);
    if (!isUnitVisibleToPlayer(unit)) {
        gameState.inspectedUnitId = null;
        return null;
    }
    return unit;
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
                const buildingHalfSize = getBuildingHitboxHalfSize(building);
                if (clickX >= building.x - buildingHalfSize && clickX <= building.x + buildingHalfSize &&
                    clickY >= building.y - buildingHalfSize && clickY <= building.y + buildingHalfSize) {
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
            
            gameState.inspectedUnitId = null;
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
    gameState.inspectedUnitId = null;
    commandGroup.clear(); // New selection clears command persistence
    attackTarget = null;
    
    // Select units
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
    
    // Select buildings (if no units selected)
    if (gameState.selection.size === 0) {
        gameState.buildings.forEach((building, buildingId) => {
            if (building.userId === gameState.userId) {
                const buildingHalfSize = getBuildingHitboxHalfSize(building);
                if (isClick) {
                    if (clickX >= building.x - buildingHalfSize && clickX <= building.x + buildingHalfSize &&
                        clickY >= building.y - buildingHalfSize && clickY <= building.y + buildingHalfSize) {
                        gameState.selection.add(buildingId);
                    }
                } else {
                    if (building.x + buildingHalfSize >= minX && building.x - buildingHalfSize <= maxX &&
                        building.y + buildingHalfSize >= minY && building.y - buildingHalfSize <= maxY) {
                        gameState.selection.add(buildingId);
                    }
                }
            }
        });
    }

    if (gameState.selection.size === 0 && isClick) {
        const enemyUnitId = findInspectableEnemyUnitAt(clickX, clickY);
        if (enemyUnitId !== null) {
            gameState.inspectedUnitId = enemyUnitId;
        }
    }
    
    updateSelectionInfo();
}

function renderSingleUnitPanel(unit, options = {}) {
    const { allowSkills = true, showAttackTarget = true } = options;

    let displayDamage = unit.damage || 0;
    if (unit.type === 'carrier') {
        displayDamage = '함재기';
    } else if (unit.type === 'cruiser' && unit.aegisMode) {
        displayDamage = '25 (이지스)';
    } else if (unit.aimedShot) {
        displayDamage = `${displayDamage * 2} (조준)`;
    } else if (unit.type === 'cruiser' && unit.isIsolated) {
        displayDamage = `${displayDamage * 2} (외로운 늑대)`;
    }
    document.getElementById('statDamage').textContent = displayDamage;

    let displayRange = unit.attackRange || 0;
    if (unit.aimedShot) {
        displayRange = `${displayRange * 2} (조준)`;
    } else if (unit.type === 'cruiser' && unit.aegisMode) {
        displayRange = `${Math.round(displayRange * 0.4)} (이지스)`;
    }
    document.getElementById('statRange').textContent = displayRange;
    document.getElementById('statHp').textContent = `${unit.hp || 0} / ${unit.maxHp || 0}`;
    document.getElementById('statKills').textContent = unit.kills || 0;

    if (showAttackTarget && attackTarget && !unit.holdPosition) {
        document.getElementById('targetLabel').textContent = `🎯 ${attackTarget.name}`;
    } else {
        const factionSuffix = unit.userId === gameState.userId ? '' : ' (적군)';
        const holdSuffix = unit.userId === gameState.userId && unit.holdPosition ? ' | 홀드' : '';
        document.getElementById('targetLabel').textContent = `${getUnitTypeName(unit.type)}${factionSuffix}${holdSuffix}`;
    }

    if (!allowSkills || unit.userId !== gameState.userId) return;

    if (unit.type === 'submarine') {
        const slot1 = document.getElementById('skillSlot1');
        slot1.style.display = 'flex';
        document.getElementById('skillBtn1').textContent = '🚀 미사일 발사';
        document.getElementById('skillBtn1').className = 'skill-btn';
        document.getElementById('skillDesc1').textContent = `핵미사일 발사 - 반경 800 범위 피해 (보유: ${gameState.missiles || 0})`;
        document.getElementById('skillDesc1').className = 'skill-desc';
    }

    if (unit.type === 'battleship') {
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

    if (unit.type === 'cruiser') {
        const slot6 = document.getElementById('skillSlot6');
        slot6.style.display = 'flex';
        const isAegis = unit.aegisMode ? true : false;
        if (isAegis) {
            document.getElementById('skillBtn6').textContent = '🛡️ 이지스 모드 (활성)';
            document.getElementById('skillBtn6').className = 'skill-btn skill-active';
            document.getElementById('skillDesc6').textContent = 'SLBM 요격 가능 / 함선 25, SLBM 50 / 피해감소 30% / 사거리 60% 감소';
        } else {
            document.getElementById('skillBtn6').textContent = '🛡️ 이지스 모드';
            document.getElementById('skillBtn6').className = 'skill-btn';
            document.getElementById('skillDesc6').textContent = 'SLBM 요격 모드 전환 (함선 25, SLBM 50, 피해감소 30%, 사거리 60%↓)';
        }
        if (unit.isIsolated) {
            document.getElementById('skillDesc6').textContent += ' | 🐺 외로운 늑대: 데미지 +100%, 피해감소 50%';
        }
    }

    if (unit.type === 'destroyer') {
        const now7 = Date.now();
        const slot7 = document.getElementById('skillSlot7');
        slot7.style.display = 'flex';
        const searchActive = unit.searchActiveUntil && now7 < unit.searchActiveUntil;
        const searchActiveRemain = searchActive ? Math.ceil((unit.searchActiveUntil - now7) / 1000) : 0;
        const searchCd = unit.searchCooldownUntil && now7 < unit.searchCooldownUntil;
        const searchRemain = searchCd ? Math.ceil((unit.searchCooldownUntil - now7) / 1000) : 0;
        if (searchActive) {
            document.getElementById('skillBtn7').textContent = `🔍 탐색 활성 (${searchActiveRemain}초)`;
            document.getElementById('skillBtn7').className = 'skill-btn skill-active';
            document.getElementById('skillDesc7').textContent = `시야 4800 유지 중 | 쿨타임 ${searchRemain}초`;
        } else if (searchCd) {
            document.getElementById('skillBtn7').textContent = `🔍 탐색 (${searchRemain}초)`;
            document.getElementById('skillBtn7').className = 'skill-btn skill-cooldown';
            document.getElementById('skillDesc7').textContent = `쿨타임 ${searchRemain}초 남음`;
        } else {
            document.getElementById('skillBtn7').textContent = '🔍 탐색';
            document.getElementById('skillBtn7').className = 'skill-btn';
            document.getElementById('skillDesc7').textContent = '기본: 시야 내 잠수함/기뢰 자동 탐지 | 사용: 10초간 시야 4800';
        }
        const slot8 = document.getElementById('skillSlot8');
        slot8.style.display = 'flex';
        document.getElementById('skillBtn8').textContent = '💣 기뢰매설';
        document.getElementById('skillBtn8').className = 'skill-btn';
        document.getElementById('skillDesc8').textContent = '클릭한 위치에 기뢰를 설치합니다';
    }

    if (unit.type === 'carrier') {
        const acCount = (unit.aircraft || []).length;
        const deployedCount = (unit.aircraftDeployed || []).length;
        const acQueue = unit.aircraftQueue || [];
        const totalAc = acCount + deployedCount + acQueue.length;
        const player = gameState.players.get(gameState.userId);
        const queueFull = acQueue.length >= 10 || totalAc >= 10;

        const slot3 = document.getElementById('skillSlot3');
        slot3.style.display = 'flex';
        document.getElementById('skillBtn3').textContent = '✈️ 함재기 제작';
        document.getElementById('skillBtn3').className = 'skill-btn' + ((!player || player.resources < 100 || queueFull) ? ' disabled' : '');
        document.getElementById('skillDesc3').textContent = `에너지 100 / 15초 (보유: ${acCount} / 발진: ${deployedCount} / 최대 10) [대기열: ${acQueue.length}]`;

        const slot4 = document.getElementById('skillSlot4');
        slot4.style.display = 'flex';
        const isAdminUser = gameState.username === 'JsonParc';
        const airstrikeReady = unit.airstrikeReady || isAdminUser;
        const now4 = Date.now();
        const airstrikeCd = !isAdminUser && unit.airstrikeCooldownUntil && now4 < unit.airstrikeCooldownUntil;
        const cdRemain4 = airstrikeCd ? Math.ceil((unit.airstrikeCooldownUntil - now4) / 1000) : 0;
        if (airstrikeReady) {
            document.getElementById('skillBtn4').textContent = '✈️ 공중강습 (준비)';
            document.getElementById('skillBtn4').className = 'skill-btn skill-active';
            document.getElementById('skillDesc4').textContent = isAdminUser ? '관리자 모드: 즉시 사용 가능' : `함재기 10기 소모하여 범위 폭격 3회 (준비 완료)`;
        } else if (acCount >= 10 && airstrikeCd) {
            document.getElementById('skillBtn4').textContent = `✈️ 공중강습 (${cdRemain4}초)`;
            document.getElementById('skillBtn4').className = 'skill-btn skill-cooldown';
            document.getElementById('skillDesc4').textContent = `쿨타임 ${cdRemain4}초 남음`;
        } else {
            document.getElementById('skillBtn4').textContent = '✈️ 공중강습';
            document.getElementById('skillBtn4').className = 'skill-btn disabled';
            document.getElementById('skillDesc4').textContent = `함재기 10기 필요 (현재: ${acCount}기)`;
        }

        if (unit.producingAircraft || acQueue.length > 0) {
            const acBar = document.getElementById('aircraftProgressBar');
            acBar.style.display = 'block';
            let queueIconsHtml = acQueue.map((item, idx) => {
                const isFirst = idx === 0;
                return `<span style="display:inline-block;width:24px;height:24px;text-align:center;line-height:24px;background:${isFirst ? QUEUE_HIGHLIGHT_BG : 'rgba(255,255,255,0.1)'};border:1px solid ${isFirst ? QUEUE_HIGHLIGHT_BORDER : '#555'};border-radius:3px;font-size:14px;" title="함재기">✈️</span>`;
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
}

function removeWorkerBuildGrid() {
    const oldBuildGrid = document.getElementById('workerBuildGrid');
    if (oldBuildGrid) oldBuildGrid.remove();
}

function updateSelectionInfo() {
    const selectionInfo = document.getElementById('selectionInfo');
    const workerBuildMenu = document.getElementById('workerBuildMenu');
    const bottomPanel = document.getElementById('bottomPanel');
    const inspectedUnit = getInspectedUnit();
    
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
    document.getElementById('skillSlot6').style.display = 'none';
    document.getElementById('skillSlot7').style.display = 'none';
    document.getElementById('skillSlot8').style.display = 'none';
    document.getElementById('productionQueueDisplay').style.display = 'none';
    document.getElementById('slbmProgressBar').style.display = 'none';
    document.getElementById('aircraftProgressBar').style.display = 'none';
    
    // Clear production buttons when hiding production display
    const btnContainer = document.getElementById('productionButtons');
    btnContainer.innerHTML = '';
    btnContainer.removeAttribute('data-building-type');
    
    if (gameState.selection.size === 0 && !inspectedUnit) {
        // Remove worker build grid if exists when nothing is selected
        removeWorkerBuildGrid();
        return;
    }
    
    // Check if buildings are selected
    const selectedBuildings = Array.from(gameState.selection)
        .map(id => gameState.buildings.get(id))
        .filter(b => b !== undefined);
    
    if (selectedBuildings.length > 0) {
        removeWorkerBuildGrid();
        const building = selectedBuildings[0];
        const buildingTypeNames = {
            'headquarters': '사령부',
            'shipyard': '조선소',
            'naval_academy': '대형조선소',
            'power_plant': '발전소',
            'missile_silo': '미사일 사일로',
            'defense_tower': '방어 타워'
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
                return `<span style="display:inline-block;width:24px;height:24px;text-align:center;line-height:24px;background:${isFirst ? QUEUE_HIGHLIGHT_BG : 'rgba(255,255,255,0.1)'};border:1px solid ${isFirst ? QUEUE_HIGHLIGHT_BORDER : '#555'};border-radius:3px;font-size:14px;" title="${unitNames[item.unitType]}">${icon}</span>`;
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
        removeWorkerBuildGrid();
        if (!inspectedUnit) return;
        bottomPanel.classList.add('active');
        renderSingleUnitPanel(inspectedUnit, { allowSkills: false, showAttackTarget: false });
        return;
    }
    
    // Check if workers are selected - show build buttons in skill panel
    const hasWorkers = selectedUnits.some(u => u.type === 'worker' && u.userId === gameState.userId);
    
    // Remove worker build grid if workers are not selected
    if (!hasWorkers) {
        removeWorkerBuildGrid();
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
            { type: 'naval_academy', name: '대형조선소', cost: 300, desc: '인구+10' },
            { type: 'missile_silo', name: '미사일 사일로', cost: 1600, desc: '' }
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
        renderSingleUnitPanel(selectedUnits[0]);
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
        const holdCount = selectedUnits.filter(u => u.userId === gameState.userId && u.holdPosition).length;
        const holdSuffix = holdCount === selectedUnits.length ? ' | 홀드' : (holdCount > 0 ? ` | 홀드 ${holdCount}` : '');
        
        document.getElementById('statDamage').textContent = totalDamage;
        document.getElementById('statRange').textContent = avgRange;
        document.getElementById('statHp').textContent = `${totalHp} / ${totalMaxHp}`;
        document.getElementById('statKills').textContent = totalKills;
        document.getElementById('targetLabel').textContent = attackTarget && holdCount === 0
            ? `🎯 ${attackTarget.name}`
            : getUnitTypeName(primaryUnit.type) + ` 외 ${selectedUnits.length - 1}${holdSuffix}`;
        
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
                const anyAirstrikeReady = carriers.some(c => c.airstrikeReady) || gameState.username === 'JsonParc';
                if (anyAirstrikeReady) {
                    document.getElementById('skillBtn4').textContent = '✈️ 공중강습 (준비)';
                    document.getElementById('skillBtn4').className = 'skill-btn skill-active';
                } else {
                    document.getElementById('skillBtn4').textContent = '✈️ 공중강습';
                    document.getElementById('skillBtn4').className = 'skill-btn disabled';
                }
                document.getElementById('skillDesc4').textContent = `함재기 10기 소모하여 범위 폭격 3회`;
            }
        }
        
        // Destroyer skills if destroyers are among selected
        if (hasTypes.has('destroyer')) {
            const slot7 = document.getElementById('skillSlot7');
            slot7.style.display = 'flex';
            document.getElementById('skillBtn7').textContent = '🔍 탐색';
            document.getElementById('skillBtn7').className = 'skill-btn';
            document.getElementById('skillDesc7').textContent = '기본: 시야 내 잠수함/기뢰 자동 탐지 | 사용: 10초간 시야 4800';
            
            const slot8 = document.getElementById('skillSlot8');
            slot8.style.display = 'flex';
            document.getElementById('skillBtn8').textContent = '💣 기뢰매설';
            document.getElementById('skillBtn8').className = 'skill-btn';
            document.getElementById('skillDesc8').textContent = '클릭한 위치에 기뢰를 설치합니다';
        }
        
        // Cruiser aegis mode if cruisers are among selected
        if (hasTypes.has('cruiser')) {
            const slot6 = document.getElementById('skillSlot6');
            slot6.style.display = 'flex';
            const anyAegis = selectedUnits.some(u => u.type === 'cruiser' && u.aegisMode);
            if (anyAegis) {
                document.getElementById('skillBtn6').textContent = '🛡️ 이지스 모드 (활성)';
                document.getElementById('skillBtn6').className = 'skill-btn skill-active';
            } else {
                document.getElementById('skillBtn6').textContent = '🛡️ 이지스 모드';
                document.getElementById('skillBtn6').className = 'skill-btn';
            }
            document.getElementById('skillDesc6').textContent = 'SLBM 요격 모드 전환 (함선 25, SLBM 50, 피해감소 30%, 사거리 60%↓)';
        }
        
// Multi-unit type summary (sorted by priority)
        const typesByPriority = [...hasTypes].sort((a, b) => (unitCostPriority[b] || 0) - (unitCostPriority[a] || 0));
        let html = `<div><strong>선택된 유닛: ${selectedUnits.length}</strong></div>`;
        if (holdCount > 0) {
            html += `<div>홀드 포지션: ${holdCount}/${selectedUnits.length}</div>`;
        }
        typesByPriority.forEach(type => {
            const count = selectedUnits.filter(u => u.type === type).length;
            html += `<div>${getUnitTypeName(type)}: ${count}</div>`;
        });
        selectionInfo.innerHTML = html;
        selectionInfo.classList.add('active');
    }
}

// Rendering (PixiJS WebGL)
function render() {
    if (!pixiApp || !worldContainer) return;
    if (gameState.map) {
        clampCameraToMapBounds();
    }

    // Camera transform via worldContainer
    const sw = pixiApp.renderer.width;
    const sh = pixiApp.renderer.height;
    worldContainer.position.set(
        sw / 2 - gameState.camera.x * gameState.camera.zoom,
        sh / 2 - gameState.camera.y * gameState.camera.zoom
    );
    worldContainer.scale.set(gameState.camera.zoom);

    if (gameState.map) {
        syncMapLayer();
        renderResources();
        syncBuildingLayer();
        syncUnitLayer();
        syncEffectsLayer(); // contrails + projectiles + explosions
        syncFogLayer();
    }

    // Overlay (selection box, SLBM targeting) – drawn in world space
    overlayGfx.clear();
    if (gameState.selectionBox) {
        const box = gameState.selectionBox;
        overlayGfx.lineStyle(2 / gameState.camera.zoom, 0x4fc3f7, 1);
        overlayGfx.drawRect(
            Math.min(box.startX, box.endX),
            Math.min(box.startY, box.endY),
            Math.abs(box.endX - box.startX),
            Math.abs(box.endY - box.startY)
        );
    }
    if (slbmTargetingMode) {
        overlayGfx.lineStyle(3 / gameState.camera.zoom, 0xff0000, 1);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, 800);
        overlayGfx.moveTo(mouse.worldX - 100, mouse.worldY);
        overlayGfx.lineTo(mouse.worldX + 100, mouse.worldY);
        overlayGfx.moveTo(mouse.worldX, mouse.worldY - 100);
        overlayGfx.lineTo(mouse.worldX, mouse.worldY + 100);
    }
    if (airstrikeTargetingMode) {
        overlayGfx.lineStyle(3 / gameState.camera.zoom, 0xff7800, 1);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, AIRSTRIKE_TARGET_RADIUS);
        overlayGfx.moveTo(mouse.worldX - 80, mouse.worldY);
        overlayGfx.lineTo(mouse.worldX + 80, mouse.worldY);
        overlayGfx.moveTo(mouse.worldX, mouse.worldY - 80);
        overlayGfx.lineTo(mouse.worldX, mouse.worldY + 80);
    }
    if (mineTargetingMode) {
        const selectedDestroyer = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .find(u => u && u.userId === gameState.userId && u.type === 'destroyer');
        const canLayMine = canLayMineAtTarget(selectedDestroyer, mouse.worldX, mouse.worldY);
        overlayGfx.lineStyle(2 / gameState.camera.zoom, canLayMine ? 0x00c853 : 0xff5252, 1);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, 80);
        overlayGfx.beginFill(canLayMine ? 0x111111 : 0x880000, 0.5);
        overlayGfx.drawCircle(mouse.worldX, mouse.worldY, 20);
        overlayGfx.endFill();
    }

    // Trigger PixiJS to present the frame
    pixiApp.renderer.render(pixiApp.stage);
}

function syncFogLayer() {
    if (!fogLayerCanvas) { fogLayer.visible = false; return; }
    const map = gameState.map;
    if (!map) { fogLayer.visible = false; return; }
    if (hasTemporaryFullMapReveal()) { fogLayer.visible = false; return; }

    // Create or update fog texture from offscreen canvas
    if (!fogTexture) {
        fogTexture = PIXI.Texture.from(fogLayerCanvas, { scaleMode: PIXI.SCALE_MODES.NEAREST });
    }
    fogTexture.baseTexture.resource.update();
    fogTexture.update();
    fogLayer.texture = fogTexture;
    fogLayer.width = map.width;
    fogLayer.height = map.height;
    fogLayer.visible = true;
}

function syncMapLayer() {
    const map = gameState.map;
    if (!map) { mapLayer.visible = false; return; }
    ensureMapImageLoaded();
    ensureLandMaskLoaded();

    if (mapImageLoaded && mapImage && !mapImageLoadFailed) {
        if (!mapTexture) {
            mapTexture = PIXI.Texture.from(mapImage);
        }
        mapLayer.texture = mapTexture;
        mapLayer.width = map.width;
        mapLayer.height = map.height;
        mapLayer.visible = true;
    } else {
        mapLayer.visible = false;
    }

    if (landMaskCanvas) {
        if (!landMaskTexture) {
            landMaskTexture = PIXI.Texture.from(landMaskCanvas, { scaleMode: PIXI.SCALE_MODES.NEAREST });
        }
        landMaskLayer.texture = landMaskTexture;
        landMaskLayer.width = map.width;
        landMaskLayer.height = map.height;
        landMaskLayer.alpha = IMAGE_LAND_MASK_ALPHA;
        landMaskLayer.visible = true;
    } else {
        landMaskLayer.visible = false;
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
    if (hasTemporaryFullMapReveal()) return true;
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

function isLandAtWorldPosition(worldX, worldY) {
    const map = gameState.map;
    if (!map) return false;
    const gridSize = getMapGridSize(map);
    const cellSize = getMapCellSize(map);
    if (!gridSize || !cellSize || !map.landCellSet) return false;
    const gx = Math.floor(worldX / cellSize);
    const gy = Math.floor(worldY / cellSize);
    if (gx < 0 || gx >= gridSize || gy < 0 || gy >= gridSize) return false;
    return map.landCellSet.has(getFogKey(gx, gy, gridSize));
}

function getDestroyerOwnedMineCount(destroyerId) {
    let count = 0;
    gameState.units.forEach(unit => {
        if (unit.type !== 'mine' || unit.userId !== gameState.userId) return;
        if (unit.sourceDestroyerId == null || unit.sourceDestroyerId === destroyerId) {
            count++;
        }
    });
    return count;
}

function canLayMineAtTarget(destroyer, targetX, targetY) {
    if (!destroyer) return false;
    const dx = targetX - destroyer.x;
    const dy = targetY - destroyer.y;
    if ((dx * dx) + (dy * dy) > DESTROYER_VISION_RADIUS * DESTROYER_VISION_RADIUS) return false;
    if (isLandAtWorldPosition(targetX, targetY)) return false;
    if (!isPositionVisible(targetX, targetY)) return false;
    if (getDestroyerOwnedMineCount(destroyer.id) >= DESTROYER_MAX_MINES) return false;
    return true;
}

// PixiJS helper: parse hex color string to number
function colorToHex(colorStr) {
    if (typeof colorStr === 'number') return colorStr;
    if (colorStr.startsWith('#')) return parseInt(colorStr.slice(1), 16);
    return 0xffffff;
}

// Building sprite cache for PixiJS
const buildingSpriteMap = new Map(); // buildingId -> { container, sprite, lastImgIdx }

function pickLoadedBuildingFrame(images, loadedFlags, preferredIdx) {
    if (loadedFlags[preferredIdx]) {
        return { img: images[preferredIdx], idx: preferredIdx };
    }
    for (let i = preferredIdx - 1; i >= 0; i--) {
        if (loadedFlags[i]) return { img: images[i], idx: i };
    }
    for (let i = preferredIdx + 1; i < loadedFlags.length; i++) {
        if (loadedFlags[i]) return { img: images[i], idx: i };
    }
    return null;
}

function getBuildingImage(building) {
    if (building.type === 'headquarters') {
        if (hqImageLoaded) return { img: hqImage, idx: 0 };
        return null;
    }
    if (building.type === 'power_plant') {
        const idx = getPowerPlantImageIndex();
        return pickLoadedBuildingFrame(bjsImages, bjsImagesLoaded, idx);
    }
    if (building.type === 'shipyard') {
        const idx = getShipyardImageIndex(building);
        return pickLoadedBuildingFrame(jssImages, jssImagesLoaded, idx);
    }
    if (building.type === 'naval_academy') {
        const idx = getNavalAcademyImageIndex(building);
        return pickLoadedBuildingFrame(djssImages, djssImagesLoaded, idx);
    }
    if (building.type === 'defense_tower' && defenseTowerBaseLoaded) {
        return {
            img: defenseTowerBaseImage,
            idx: 0,
            fixedMaxDimension: FIXED_BUILDING_IMAGE_MAX_DIMENSION
        };
    }
    if (building.type === 'missile_silo' && missileSiloLoaded) {
        return {
            img: missileSiloImage,
            idx: 0,
            fixedMaxDimension: FIXED_BUILDING_IMAGE_MAX_DIMENSION
        };
    }
    return null;
}

function getBuildingTypeSizeScale(type) {
    if (type === 'power_plant') return POWER_PLANT_SIZE_SCALE;
    if (type === 'shipyard' || type === 'naval_academy') return COASTAL_BUILDING_SIZE_SCALE;
    return 1;
}

function getBuildingDisplaySize(building) {
    const imgData = getBuildingImage(building);
    if (imgData && imgData.fixedMaxDimension) {
        const fixedSize = getFixedImageDisplaySize(imgData.img, imgData.fixedMaxDimension);
        return {
            width: fixedSize.width,
            height: fixedSize.height
        };
    }
    const hasImage = !!(imgData && imgData.img);
    const aspectRatio = hasImage && imgData.img.height
        ? imgData.img.width / imgData.img.height
        : (buildingDisplaySize.width / Math.max(1, buildingDisplaySize.height));
    const baseHeight = (imgData && buildingSizeInitialized) ? buildingDisplaySize.height : 200;
    const baseSize = {
        width: baseHeight * aspectRatio,
        height: baseHeight
    };
    const scale = getBuildingTypeSizeScale(building.type);
    return {
        width: baseSize.width * scale,
        height: baseSize.height * scale
    };
}

function getBuildingHitboxHalfSize(building) {
    const dispSize = getBuildingDisplaySize(building);
    return Math.max(dispSize.width, dispSize.height) / 2;
}

function createBuildingSpriteEntry(building, imgData, dispSize) {
    const container = new PIXI.Container();
    const tex = getOrCreateTexture(imgData.img);
    const sprite = tex ? new PIXI.Sprite(tex) : null;
    let cannonSprite = null;

    if (sprite) {
        sprite.anchor.set(0.5);
        sprite.width = dispSize.width;
        sprite.height = dispSize.height;
        container.addChild(sprite);
    }

    if (building.type === 'defense_tower' && defenseTowerCannonLoaded && defenseTowerCannonImage) {
        const cannonTex = getOrCreateTexture(defenseTowerCannonImage);
        if (cannonTex) {
            const metrics = getDefenseTowerVisualMetrics();
            cannonSprite = new PIXI.Sprite(cannonTex);
            cannonSprite.anchor.set(metrics.cannonAnchorX, metrics.cannonAnchorY);
            cannonSprite.width = metrics.cannonWidth;
            cannonSprite.height = metrics.cannonHeight;
            cannonSprite.position.set(metrics.cannonPivotLocalX, metrics.cannonPivotLocalY);
            container.addChild(cannonSprite);
        }
    }

    container.position.set(building.x, building.y);
    buildingSpriteLayer.addChild(container);
    return {
        container,
        sprite,
        cannonSprite,
        lastImgIdx: imgData.idx,
        buildingType: building.type
    };
}

function syncBuildingLayer() {
    buildingGfx.clear();
    const viewport = getViewportBounds(240);
    const activeBuildingIds = new Set();
    
    gameState.buildings.forEach((building, buildingId) => {
        if (building.x < viewport.left || building.x > viewport.right ||
            building.y < viewport.top || building.y > viewport.bottom) return;
        if (building.userId !== gameState.userId && !isPositionVisible(building.x, building.y)) return;

        activeBuildingIds.add(buildingId);
        const color = colorToHex(getPlayerColor(building.userId));
        const dispSize = getBuildingDisplaySize(building);
        const size = Math.max(dispSize.width, dispSize.height);
        const isSelected = gameState.selection.has(buildingId);

        // Try to render with image
        const imgData = getBuildingImage(building);
        if (imgData) {
            let entry = buildingSpriteMap.get(buildingId);
            if (entry && entry.buildingType !== building.type) {
                if (entry.container.parent) entry.container.parent.removeChild(entry.container);
                entry.container.destroy({ children: true });
                buildingSpriteMap.delete(buildingId);
                entry = null;
            }
            if (!entry) {
                entry = createBuildingSpriteEntry(building, imgData, dispSize);
                buildingSpriteMap.set(buildingId, entry);
            } else {
                entry.container.position.set(building.x, building.y);
                if (entry.sprite) {
                    entry.sprite.width = dispSize.width;
                    entry.sprite.height = dispSize.height;
                }
                if (entry.lastImgIdx !== imgData.idx && entry.sprite) {
                    const tex = getOrCreateTexture(imgData.img);
                    if (tex) {
                        entry.sprite.texture = tex;
                        entry.lastImgIdx = imgData.idx;
                    }
                }
            }

            if (building.type === 'defense_tower') {
                if (!entry.cannonSprite && defenseTowerCannonLoaded && defenseTowerCannonImage) {
                    const cannonTex = getOrCreateTexture(defenseTowerCannonImage);
                    if (cannonTex) {
                        const metrics = getDefenseTowerVisualMetrics();
                        entry.cannonSprite = new PIXI.Sprite(cannonTex);
                        entry.cannonSprite.anchor.set(metrics.cannonAnchorX, metrics.cannonAnchorY);
                        entry.cannonSprite.width = metrics.cannonWidth;
                        entry.cannonSprite.height = metrics.cannonHeight;
                        entry.cannonSprite.position.set(metrics.cannonPivotLocalX, metrics.cannonPivotLocalY);
                        entry.container.addChild(entry.cannonSprite);
                    }
                }

                if (entry.cannonSprite) {
                    const metrics = getDefenseTowerVisualMetrics();
                    entry.cannonSprite.width = metrics.cannonWidth;
                    entry.cannonSprite.height = metrics.cannonHeight;
                    entry.cannonSprite.position.set(metrics.cannonPivotLocalX, metrics.cannonPivotLocalY);
                    const aimTarget = getDefenseTowerAimTarget(building);
                    if (!Number.isFinite(building.turretAngle)) {
                        building.turretAngle = 0;
                    }
                    if (aimTarget) {
                        building.turretAngle = Math.atan2(
                            aimTarget.y - (building.y + metrics.cannonPivotLocalY),
                            aimTarget.x - (building.x + metrics.cannonPivotLocalX)
                        );
                    }
                    entry.cannonSprite.rotation = building.turretAngle;
                }
            }
            entry.container.visible = true;
        } else {
            // Fallback: colored rectangle for buildings without images
            buildingGfx.beginFill(color);
            buildingGfx.drawRect(building.x - size/2, building.y - size/2, size, size);
            buildingGfx.endFill();
            buildingGfx.lineStyle(2, 0xffffff, 1);
            buildingGfx.drawRect(building.x - size/2, building.y - size/2, size, size);
            buildingGfx.lineStyle(0);
        }

        // Build progress bar
        if (building.buildProgress < 100) {
            buildingGfx.beginFill(0xffffff, 0.3);
            buildingGfx.drawRect(building.x - size/2, building.y + size/2 + 5, (size * building.buildProgress) / 100, 5);
            buildingGfx.endFill();
        }

        // Production progress bar
        if (building.producing && building.buildProgress >= 100) {
            const elapsed = Date.now() - building.producing.startTime;
            const prodProgress = Math.min(1, elapsed / building.producing.buildTime);
            buildingGfx.beginFill(0x000000, 0.5);
            buildingGfx.drawRect(building.x - size/2, building.y + size/2 + 12, size, 6);
            buildingGfx.endFill();
            buildingGfx.beginFill(0xffcc00);
            buildingGfx.drawRect(building.x - size/2, building.y + size/2 + 12, size * prodProgress, 6);
            buildingGfx.endFill();
        }

        if (isSelected) {
            const hpBarWidth = size * 0.6;
            const hpBarHeight = 4;
            const hpBarX = building.x - hpBarWidth / 2;
            let hpBarY = building.y + size / 2 + 10;
            if (building.buildProgress < 100) hpBarY += 8;
            if (building.producing && building.buildProgress >= 100) hpBarY += 10;
            buildingGfx.beginFill(0xff0000);
            buildingGfx.drawRect(hpBarX, hpBarY, hpBarWidth, hpBarHeight);
            buildingGfx.endFill();
            buildingGfx.beginFill(0x00ff00);
            buildingGfx.drawRect(hpBarX, hpBarY, (hpBarWidth * building.hp) / building.maxHp, hpBarHeight);
            buildingGfx.endFill();
        }
    });
    
    // Cleanup sprites for destroyed buildings, hide off-viewport ones
    buildingSpriteMap.forEach((entry, id) => {
        if (!gameState.buildings.has(id)) {
            if (entry.container.parent) entry.container.parent.removeChild(entry.container);
            entry.container.destroy({ children: true });
            buildingSpriteMap.delete(id);
        } else if (!activeBuildingIds.has(id)) {
            entry.container.visible = false;
        }
    });
}

function syncUnitLayer() {
    const viewport = getViewportBounds(120);
    const activeIds = new Set();
    const gfx = effectsGfx; // We draw HP bars, selection, labels into effectsGfx

    gameState.units.forEach((unit, unitId) => {
        // Visibility checks
        if (unit.type === 'submarine' && unit.userId !== gameState.userId && !unit.isDetected) return;
        // Mines are hidden from enemies unless detected by destroyer search
        if (unit.type === 'mine' && unit.userId !== gameState.userId && !unit.isDetected) return;
        const posX = unit.interpDisplayX !== undefined ? unit.interpDisplayX : unit.x;
        const posY = unit.interpDisplayY !== undefined ? unit.interpDisplayY : unit.y;
        if (unit.userId !== gameState.userId && !isPositionVisible(posX, posY)) return;
        if (posX < viewport.left || posX > viewport.right || posY < viewport.top || posY > viewport.bottom) return;

        activeIds.add(unitId);
        const isSelected = gameState.selection.has(unitId);
        const size = unit.type === 'worker' ? 40 : (unit.type === 'mine' ? 40 : (unit.type === 'aircraft' ? 20 : (unit.type === 'frigate' ? 35 : (unit.type === 'destroyer' ? 45 : 60))));
        const angle = unit.displayAngle !== undefined ? unit.displayAngle : 0;

        // Get or create sprite entry
        let entry = unitSpriteMap.get(unitId);
        if (!entry || entry.unitType !== unit.type) {
            // Remove old sprite if type changed
            if (entry) { unitLayer.removeChild(entry.container); entry.container.destroy({ children: true }); }
            entry = createUnitSpriteEntry(unit, size);
            unitSpriteMap.set(unitId, entry);
            unitLayer.addChild(entry.container);
        }

        // If entry was created with fallback shape but image is now loaded, recreate
        if (!entry.mainSprite && unit.type !== 'worker' && unit.type !== 'battleship') {
            const img = getUnitImage(unit.type);
            if (img) {
                unitLayer.removeChild(entry.container);
                entry.container.destroy({ children: true });
                entry = createUnitSpriteEntry(unit, size);
                unitSpriteMap.set(unitId, entry);
                unitLayer.addChild(entry.container);
            }
        }
        
        // Cruiser aegis mode sprite swap: recreate when aegisMode toggles
        if (unit.type === 'cruiser' && entry.aegisMode !== !!unit.aegisMode) {
            unitLayer.removeChild(entry.container);
            entry.container.destroy({ children: true });
            entry = createUnitSpriteEntry(unit, size);
            entry.aegisMode = !!unit.aegisMode;
            unitSpriteMap.set(unitId, entry);
            unitLayer.addChild(entry.container);
        }

        // Update position and rotation
        entry.container.position.set(posX, posY);
        entry.container.rotation = angle;
        entry.container.visible = true;

        // Update color for worker
        if (unit.type === 'worker' && entry.gfxShape) {
            const c = WORKER_FILL_COLOR;
            if (entry.lastColor !== c) {
                entry.gfxShape.clear();
                entry.gfxShape.beginFill(c);
                entry.gfxShape.drawCircle(0, 0, size / 2);
                entry.gfxShape.endFill();
                entry.gfxShape.lineStyle(1, WORKER_OUTLINE_COLOR);
                entry.gfxShape.drawCircle(0, 0, size / 2);
                entry.lastColor = c;
            }
        }

        // Battleship turret logic
        if (unit.type === 'battleship' && entry.turretSprites && entry.turretSprites.length > 0) {
            const shipAngle = angle;
            const attackTgt = getBattleshipAimTarget(unit);
            const turretWorldStates = getBattleshipTurretWorldStates(posX, posY, shipAngle, size);
            const turretTargetAngles = turretWorldStates.map((ts, ti) => {
                if (attackTgt) return Math.atan2(attackTgt.y - ts.centerY, attackTgt.x - ts.centerX);
                if (unit.turretAngles && unit.turretAngles[ti] !== undefined) return unit.turretAngles[ti];
                return shipAngle;
            });
            if (!unit.turretAngles || unit.turretAngles.length !== turretTargetAngles.length) {
                unit.turretAngles = turretTargetAngles.slice();
            }
            const rotSpeed = 0.08;
            for (let ti = 0; ti < turretTargetAngles.length; ti++) {
                const target = turretTargetAngles[ti];
                if (attackTgt) { unit.turretAngles[ti] = target; continue; }
                let diff = target - unit.turretAngles[ti];
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                unit.turretAngles[ti] = Math.abs(diff) > rotSpeed
                    ? unit.turretAngles[ti] + Math.sign(diff) * rotSpeed
                    : target;
            }
            entry.turretSprites.forEach((ts, ti) => {
                ts.rotation = unit.turretAngles[ti] - shipAngle;
            });
        }
    });

    // Remove sprites for units that no longer exist
    unitSpriteMap.forEach((entry, id) => {
        if (!activeIds.has(id)) {
            entry.container.visible = false;
            unitLayer.removeChild(entry.container);
            entry.container.destroy({ children: true });
            unitSpriteMap.delete(id);
        }
    });
}

function createUnitSpriteEntry(unit, size) {
    const container = new PIXI.Container();
    let gfxShape = null;
    let mainSprite = null;
    const turretSprites = [];
    let lastColor = 0;

    if (unit.type === 'worker') {
        // Worker - circle via Graphics
        gfxShape = new PIXI.Graphics();
        const c = WORKER_FILL_COLOR;
        gfxShape.beginFill(c);
        gfxShape.drawCircle(0, 0, size / 2);
        gfxShape.endFill();
        gfxShape.lineStyle(1, WORKER_OUTLINE_COLOR);
        gfxShape.drawCircle(0, 0, size / 2);
        lastColor = c;
        container.addChild(gfxShape);
    } else if (unit.type === 'mine') {
        // Mine - black circle with dark outline
        gfxShape = new PIXI.Graphics();
        gfxShape.beginFill(0x111111);
        gfxShape.drawCircle(0, 0, size / 2);
        gfxShape.endFill();
        gfxShape.lineStyle(2, 0x333333);
        gfxShape.drawCircle(0, 0, size / 2);
        container.addChild(gfxShape);
    } else if (unit.type === 'battleship') {
        // Battleship body + turrets
        const bodyImg = battleshipBaseLoaded ? battleshipBaseImage : null;
        if (bodyImg) {
            const tex = getOrCreateTexture(bodyImg);
            if (tex) {
                const metrics = getBattleshipVisualMetrics(size);
                const bodyGroup = new PIXI.Container();
                bodyGroup.rotation = -Math.PI / 2;

                const body = new PIXI.Sprite(tex);
                body.anchor.set(0.5);
                body.width = metrics.baseWidth;
                body.height = metrics.baseHeight;
                bodyGroup.addChild(body);

                // Turrets
                if (mainCannonLoaded && mainCannonImage) {
                    const cannonTex = getOrCreateTexture(mainCannonImage);
                    if (cannonTex) {
                        metrics.turretInner.forEach(pos => {
                            const turretC = new PIXI.Container();
                            turretC.position.set(pos.x, pos.y);
                            const ts = new PIXI.Sprite(cannonTex);
                            ts.anchor.set(0.5);
                            ts.width = metrics.turretWidth;
                            ts.height = metrics.turretHeight;
                            turretC.addChild(ts);
                            bodyGroup.addChild(turretC);
                            turretSprites.push(turretC);
                        });
                    }
                }
                container.addChild(bodyGroup);
            }
        }
        if (container.children.length === 0) {
            // Fallback
            gfxShape = new PIXI.Graphics();
            gfxShape.beginFill(0x4fc3f7);
            gfxShape.moveTo(size, 0); gfxShape.lineTo(size*0.2, -size*0.4);
            gfxShape.lineTo(-size*0.8, -size*0.4); gfxShape.lineTo(-size*0.8, size*0.4);
            gfxShape.lineTo(size*0.2, size*0.4); gfxShape.closePath();
            gfxShape.endFill();
            container.addChild(gfxShape);
        }
    } else {
        // Image-based units: submarine, cruiser, carrier, frigate, aircraft
        const img = getUnitImage(unit);
        if (img) {
            const tex = getOrCreateTexture(img);
            if (tex) {
                mainSprite = new PIXI.Sprite(tex);
                const origW = img.width;
                const origH = img.height;
                const aspectRatio = origW / origH;
                // Aircraft uses smaller scale than ships
                const heightMult = (unit.type === 'aircraft') ? 2.5 : 6.6;
                const baseHeight = size * heightMult;
                const baseWidth = baseHeight * aspectRatio;
                mainSprite.anchor.set(0.5);
                mainSprite.width = baseWidth;
                mainSprite.height = baseHeight;
                mainSprite.rotation = -Math.PI / 2;
                container.addChild(mainSprite);
            }
        }
        if (!mainSprite) {
            // Fallback shape
            const c = colorToHex(getPlayerColor(unit.userId));
            gfxShape = new PIXI.Graphics();
            gfxShape.beginFill(c);
            if (unit.type === 'aircraft') {
                gfxShape.moveTo(size, 0); gfxShape.lineTo(-size*0.6, size*0.7);
                gfxShape.lineTo(-size*0.3, 0); gfxShape.lineTo(-size*0.6, -size*0.7);
                gfxShape.closePath();
            } else {
                gfxShape.moveTo(size, 0); gfxShape.lineTo(-size/2, size/2); gfxShape.lineTo(-size/2, -size/2); gfxShape.closePath();
            }
            gfxShape.endFill();
            container.addChild(gfxShape);
        }
    }

    return { container, gfxShape, mainSprite, turretSprites, unitType: unit.type, lastColor };
}

// Draw HP bars, selection circles, labels into effectsGfx (called from syncEffectsLayer)
function drawUnitOverlays(gfx) {
    const viewport = getViewportBounds(120);
    gameState.units.forEach((unit, unitId) => {
        if (!isUnitVisibleToPlayer(unit)) return;
        const { x: posX, y: posY } = getUnitDisplayPosition(unit);
        if (posX < viewport.left || posX > viewport.right || posY < viewport.top || posY > viewport.bottom) return;

        const isSelected = gameState.selection.has(unitId);
        const isInspected = gameState.inspectedUnitId === unitId;
        const size = getUnitSelectionBaseSize(unit);

        if (isSelected || isInspected) {
            const hpBarY = posY + size + 8;
            gfx.beginFill(0xff0000);
            gfx.drawRect(posX - size, hpBarY, size * 2, 4);
            gfx.endFill();
            gfx.beginFill(0x00ff00);
            gfx.drawRect(posX - size, hpBarY, (size * 2 * unit.hp) / unit.maxHp, 4);
            gfx.endFill();
        }

        // Stealth indicator for own submarines
        if (unit.type === 'submarine' && !unit.isDetected && unit.userId === gameState.userId) {
            // Small green dot above unit
            gfx.beginFill(0x00ff00, 0.8);
            gfx.drawCircle(posX, posY - size - 14, 4);
            gfx.endFill();
        }

        // Selection ellipse - sized to match rendered image shape
        if (isSelected || isInspected) {
            const outlineColor = isSelected ? 0xffff00 : 0xffaa00;
            if (unit.type === 'worker' || unit.type === 'mine') {
                gfx.lineStyle(2, outlineColor, 1);
                gfx.drawCircle(posX, posY, size + 5);
                gfx.lineStyle(0);
            } else {
                const heightMult = (unit.type === 'aircraft') ? 2.5 : (unit.type === 'battleship' ? BATTLESHIP_BASE_HEIGHT_MULTIPLIER : 6.6);
                const img = getUnitImage(unit);
                const aspectRatio = (img && img.width && img.height) ? (img.width / img.height) : 0.25;
                const semiMajor = (size * heightMult) / 2 + 5; // along heading (ship length)
                const semiMinor = (size * heightMult * aspectRatio) / 2 + 5; // perpendicular (ship width)
                const uAngle = unit.displayAngle !== undefined ? unit.displayAngle : 0;
                // Draw rotated ellipse as polygon - major axis along ship heading
                gfx.lineStyle(2, outlineColor, 1);
                const ellipseSegs = 32;
                const cosA = Math.cos(uAngle);
                const sinA = Math.sin(uAngle);
                const pts = [];
                for (let ei = 0; ei <= ellipseSegs; ei++) {
                    const theta = (ei / ellipseSegs) * Math.PI * 2;
                    const lx = Math.cos(theta) * semiMajor; // along heading
                    const ly = Math.sin(theta) * semiMinor; // perpendicular
                    pts.push(posX + lx * cosA - ly * sinA, posY + lx * sinA + ly * cosA);
                }
                gfx.drawPolygon(pts);
                gfx.lineStyle(0);
            }
        }
    });
}

// Helper: draw flame trail behind SLBM piece (PixiJS Graphics version)
function drawSlbmFlameGfx(gfx, x, y, angle, width, length) {
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
        const color = (r << 16) | (g << 8) | b;
        gfx.beginFill(color, segAlpha);
        gfx.drawCircle(fx, fy, segRadius);
        gfx.endFill();
    }
}

// Draw a rotated rectangle centered at (cx, cy) with given width, height, rotation angle
function drawRotatedRect(gfx, cx, cy, w, h, angle, color, alpha) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const hw = w / 2;
    const hh = h / 2;
    // Rectangle corners relative to center, rotated
    // The "length" (h) goes along the angle direction, "width" (w) perpendicular
    const dx_along = cos * hh;
    const dy_along = sin * hh;
    const dx_perp = -sin * hw;
    const dy_perp = cos * hw;
    gfx.beginFill(color, alpha !== undefined ? alpha : 1);
    gfx.drawPolygon([
        cx + dx_along + dx_perp, cy + dy_along + dy_perp,  // front-right
        cx + dx_along - dx_perp, cy + dy_along - dy_perp,  // front-left
        cx - dx_along - dx_perp, cy - dy_along - dy_perp,  // rear-left
        cx - dx_along + dx_perp, cy - dy_along + dy_perp   // rear-right
    ]);
    gfx.endFill();
}

// Manage airstrike.png PIXI sprites for flying airstrikes
const airstrikeSpriteMap = new Map(); // strikeId -> PIXI.Sprite
function syncAirstrikeSprites(now, viewport) {
    if (!gameState.activeAirstrikes) gameState.activeAirstrikes = [];
    const activeIds = new Set();
    
    // Remove airstrikes that have completed their flight (progress >= 1)
    gameState.activeAirstrikes = gameState.activeAirstrikes.filter(s => {
        const elapsed = now - s.startTime;
        const progress = Math.min(1, elapsed / s.flightTime);
        return progress < 1;
    });
    
    gameState.activeAirstrikes.forEach(strike => {
        // Skip flights that haven't started yet (delayed 2nd/3rd flights)
        if (now < strike.startTime) return;
        const elapsed = now - strike.startTime;
        const progress = Math.min(1, elapsed / strike.flightTime);
        if (progress >= 1) return;
        
        const destX = strike.exitX != null ? strike.exitX : strike.targetX;
        const destY = strike.exitY != null ? strike.exitY : strike.targetY;
        const currentX = strike.fromX + (destX - strike.fromX) * progress;
        const currentY = strike.fromY + (destY - strike.fromY) * progress;
        const angle = Math.atan2(destY - strike.fromY, destX - strike.fromX);
        
        activeIds.add(strike.id);
        let sprite = airstrikeSpriteMap.get(strike.id);
        if (!sprite) {
            if (airstrikeImageLoaded && airstrikeImage) {
                const tex = getOrCreateTexture(airstrikeImage);
                if (tex) {
                    sprite = new PIXI.Sprite(tex);
                    sprite.anchor.set(0.5);
                    const origW = airstrikeImage.width;
                    const origH = airstrikeImage.height;
                    const aspectRatio = origW / origH;
                    const baseHeight = 60 * 6.6;
                    sprite.height = baseHeight;
                    sprite.width = baseHeight * aspectRatio;
                    airstrikeLayer.addChild(sprite);
                    airstrikeSpriteMap.set(strike.id, sprite);
                }
            }
            if (!sprite) {
                // Fallback: orange circle via Graphics
                sprite = new PIXI.Graphics();
                sprite.beginFill(0xff8800, 0.9);
                sprite.drawCircle(0, 0, 20);
                sprite.endFill();
                airstrikeLayer.addChild(sprite);
                airstrikeSpriteMap.set(strike.id, sprite);
            }
        }
        sprite.position.set(currentX, currentY);
        sprite.rotation = angle + Math.PI / 2; // airstrike image is 180° flipped vs ship images
        sprite.visible = true;
    });
    
    // Remove sprites no longer active
    airstrikeSpriteMap.forEach((sprite, id) => {
        if (!activeIds.has(id)) {
            airstrikeLayer.removeChild(sprite);
            if (sprite.destroy) sprite.destroy();
            airstrikeSpriteMap.delete(id);
        }
    });
}

// Combined effects rendering: contrails + projectiles + explosions + unit overlays
function syncEffectsLayer() {
    effectsGfx.clear();
    const now = Date.now();
    const viewport = getViewportBounds(500);

    // --- Unit overlays (HP bars, selection circles) ---
    drawUnitOverlays(effectsGfx);

    // --- Contrails ---
    slbmContrails.forEach(contrail => {
        contrail.segments = contrail.segments.filter(seg => now - seg.time < 3000);
        for (let i = 0; i < contrail.segments.length - 1; i++) {
            const seg = contrail.segments[i];
            const nextSeg = contrail.segments[i + 1];
            if (seg.x < viewport.left - 100 || seg.x > viewport.right + 100 ||
                seg.y < viewport.top - 100 || seg.y > viewport.bottom + 100) continue;
            const age = now - seg.time;
            const fadeProgress = age / 3000;
            const alpha = Math.max(0, 0.3 - fadeProgress * 0.3);
            effectsGfx.lineStyle(24, 0xc8c8c8, alpha);
            effectsGfx.moveTo(seg.x, seg.y);
            effectsGfx.lineTo(nextSeg.x, nextSeg.y);
        }
    });
    slbmContrails = slbmContrails.filter(c => c.segments.length > 0);
    effectsGfx.lineStyle(0);

    // --- Attack projectiles ---
    if (attackProjectiles.length > 0) {
        attackProjectiles = attackProjectiles.filter(p => now - p.startTime <= p.flightTime + 900);
    }

    attackProjectiles.forEach(projectile => {
        const progress = Math.max(0, Math.min(1, (now - projectile.startTime) / projectile.flightTime));
        let finalTargetX = projectile.targetX, finalTargetY = projectile.targetY;
        if (projectile.targetId) {
            const tu = gameState.units.get(projectile.targetId);
            if (tu) {
                finalTargetX = tu.interpDisplayX !== undefined ? tu.interpDisplayX : tu.x;
                finalTargetY = tu.interpDisplayY !== undefined ? tu.interpDisplayY : tu.y;
            }
        }
        const currentX = projectile.fromX + (finalTargetX - projectile.fromX) * progress;
        const currentY = projectile.fromY + (finalTargetY - projectile.fromY) * progress;
        if (currentX < viewport.left || currentX > viewport.right || currentY < viewport.top || currentY > viewport.bottom) return;
        if (!isPositionVisible(currentX, currentY)) return;

        if (progress >= 1) {
            const impactAge = (now - projectile.startTime) - projectile.flightTime;
            const impactProgress = impactAge / 900;
            if (impactProgress < 1) {
                const isBig = projectile.shooterType === 'battleship' || projectile.shooterType === 'defense_tower';
                const impactRadius = (isBig ? 30 : 18) * (1 + impactProgress * 0.5);
                const impactAlpha = Math.max(0, 0.6 - impactProgress * 0.6);
                effectsGfx.beginFill(0xff8c28, impactAlpha);
                effectsGfx.drawCircle(finalTargetX, finalTargetY, impactRadius);
                effectsGfx.endFill();
            }
            return;
        }

        const isBattleshipShell = projectile.shooterType === 'battleship' || projectile.shooterType === 'defense_tower';
        const shellRadius = isBattleshipShell ? 5 : 3;
        const isAimedShot = projectile.aimedShot;
        const dx = finalTargetX - projectile.fromX;
        const dy = finalTargetY - projectile.fromY;
        const angle = Math.atan2(dy, dx);
        const trailLength = isBattleshipShell ? 120 : 22;
        const trailSegments = 8;

        for (let i = trailSegments; i >= 0; i--) {
            const t = i / trailSegments;
            const trailX = currentX - Math.cos(angle) * trailLength * t;
            const trailY = currentY - Math.sin(angle) * trailLength * t;
            const segRadius = shellRadius * (1 - t * 0.6);
            const segAlpha = (1 - t) * 0.85;
            let color;
            if (isAimedShot) {
                const cr = Math.floor(50 + (1 - t) * 80);
                const cg = Math.floor(120 + (1 - t) * 135);
                color = (cr << 16) | (cg << 8) | 255;
            } else {
                const cg = Math.floor(60 + (1 - t) * 195);
                const cb = Math.floor((1 - t) * 50);
                color = (255 << 16) | (cg << 8) | cb;
            }
            effectsGfx.beginFill(color, segAlpha);
            effectsGfx.drawCircle(trailX, trailY, segRadius);
            effectsGfx.endFill();
        }

        effectsGfx.beginFill(0x111111);
        effectsGfx.drawCircle(currentX, currentY, shellRadius);
        effectsGfx.endFill();
    });

    // --- SLBM missiles ---
    slbmMissiles.forEach(missile => {
        if (!missile.impacted) {
            const progress = Math.max(0, Math.min(1, (now - missile.startTime) / missile.flightTime));
            if (progress >= 1) { missile.impacted = true; missile.impactTime = now; return; }

            const dx = missile.targetX - missile.fromX;
            const dy = missile.targetY - missile.fromY;
            const angle = Math.atan2(dy, dx);
            const currentX = missile.fromX + dx * progress;
            const currentY = missile.fromY + dy * progress;
            if (currentX < viewport.left - 200 || currentX > viewport.right + 200 || currentY < viewport.top - 200 || currentY > viewport.bottom + 200) return;

            const missileWidth = 24;
            const missileFullLen = 150;

            // Contrail
            if (!missile.contrailId) {
                missile.contrailId = `contrail-${missile.id}`;
                slbmContrails.push({ id: missile.contrailId, segments: [{ x: missile.fromX, y: missile.fromY, time: missile.startTime }] });
            }
            const contrail = slbmContrails.find(c => c.id === missile.contrailId);
            if (contrail && (contrail.segments.length === 0 || now - contrail.segments[contrail.segments.length - 1].time > 50)) {
                contrail.segments.push({ x: currentX, y: currentY, time: now });
            }

            if (progress < 0.333) {
                const hl = missileFullLen / 2;
                drawRotatedRect(effectsGfx, currentX, currentY, missileWidth, missileFullLen, angle, 0x111111);
                const rearX = currentX - Math.cos(angle) * hl;
                const rearY = currentY - Math.sin(angle) * hl;
                drawSlbmFlameGfx(effectsGfx, rearX, rearY, angle, missileWidth, 50);
            } else if (progress < 0.666) {
                const sp = (progress - 0.333) / 0.333;
                const pieceLen = missileFullLen / 3;
                drawRotatedRect(effectsGfx, currentX, currentY, missileWidth, pieceLen * 2, angle, 0x111111);
                const rearX = currentX - Math.cos(angle) * pieceLen;
                const rearY = currentY - Math.sin(angle) * pieceLen;
                drawSlbmFlameGfx(effectsGfx, rearX, rearY, angle, missileWidth, 40);
                const sep1X = currentX - Math.cos(angle) * pieceLen * 1.5 + Math.sin(angle) * 20 * sp;
                const sep1Y = currentY - Math.sin(angle) * pieceLen * 1.5 - Math.cos(angle) * 20 * sp;
                drawRotatedRect(effectsGfx, sep1X, sep1Y, missileWidth, pieceLen, angle, 0x333333);
            } else {
                const sp = (progress - 0.666) / 0.334;
                const pieceLen = missileFullLen / 3;
                drawRotatedRect(effectsGfx, currentX, currentY, missileWidth, pieceLen, angle, 0x111111);
                const rearX = currentX - Math.cos(angle) * (pieceLen / 2);
                const rearY = currentY - Math.sin(angle) * (pieceLen / 2);
                drawSlbmFlameGfx(effectsGfx, rearX, rearY, angle, missileWidth, 35);
                const sep1X = currentX - Math.cos(angle) * pieceLen * 2.5 + Math.sin(angle) * 35 * Math.min(sp + 0.5, 1);
                const sep1Y = currentY - Math.sin(angle) * pieceLen * 2.5 - Math.cos(angle) * 35 * Math.min(sp + 0.5, 1);
                const alpha1 = Math.max(0, 1 - sp * 0.7);
                drawRotatedRect(effectsGfx, sep1X, sep1Y, missileWidth, pieceLen, angle, 0x444444, alpha1);
                const sep2X = currentX - Math.cos(angle) * pieceLen * 1.5 - Math.sin(angle) * 30 * sp;
                const sep2Y = currentY - Math.sin(angle) * pieceLen * 1.5 + Math.cos(angle) * 30 * sp;
                const alpha2 = Math.max(0, 1 - sp * 0.5);
                drawRotatedRect(effectsGfx, sep2X, sep2Y, missileWidth, pieceLen, angle, 0x444444, alpha2);
            }

            // SLBM HP bar
            if (missile.hp !== undefined && missile.maxHp && missile.hp < missile.maxHp) {
                const barWidth = 40, barHeight = 4;
                const barX = currentX - barWidth / 2, barY = currentY - 50;
                const hpRatio = Math.max(0, missile.hp / missile.maxHp);
                effectsGfx.beginFill(0x000000, 0.6);
                effectsGfx.drawRect(barX, barY, barWidth, barHeight);
                effectsGfx.endFill();
                const hpColor = hpRatio > 0.5 ? 0x4caf50 : (hpRatio > 0.25 ? 0xff9800 : 0xf44336);
                effectsGfx.beginFill(hpColor);
                effectsGfx.drawRect(barX, barY, barWidth * hpRatio, barHeight);
                effectsGfx.endFill();
            }
            return;
        }

        // Impact effect
        const impactElapsed = now - (missile.impactTime || 0);
        if (impactElapsed > 2600) return;
        if (missile.targetX < viewport.left || missile.targetX > viewport.right ||
            missile.targetY < viewport.top || missile.targetY > viewport.bottom) return;

        const pulseRadius = 120 + (impactElapsed * 0.42);
        const pulseAlpha = Math.max(0, 0.52 - (impactElapsed / 2600));
        effectsGfx.beginFill(0xff5f14, pulseAlpha);
        effectsGfx.drawCircle(missile.targetX, missile.targetY, pulseRadius);
        effectsGfx.endFill();
    });

    // --- Explosion effects ---
    explosionEffects = explosionEffects.filter(exp => now - exp.startTime < exp.duration);
    explosionEffects.forEach(exp => {
        if (!isPositionVisible(exp.x, exp.y)) return;
        const elapsed = now - exp.startTime;
        const progress = elapsed / exp.duration;

        // Search pulse: expanding cyan ring
        if (exp.isSearchPulse) {
            const ringRadius = exp.maxRadius * progress;
            const alpha = Math.max(0, 0.6 - progress * 0.6);
            effectsGfx.lineStyle(4, exp.color || 0x00bcd4, alpha);
            effectsGfx.drawCircle(exp.x, exp.y, ringRadius);
            effectsGfx.lineStyle(0);
            return;
        }

        if (progress < 0.3) {
            const flashAlpha = 1 - (progress / 0.3);
            const flashRadius = (exp.maxRadius || 30) + progress * 60;
            effectsGfx.beginFill(0xffc832, flashAlpha * 0.8);
            effectsGfx.drawCircle(exp.x, exp.y, flashRadius);
            effectsGfx.endFill();
            effectsGfx.beginFill(0xffffff, flashAlpha * 0.6);
            effectsGfx.drawCircle(exp.x, exp.y, flashRadius * 0.4);
            effectsGfx.endFill();
        }
        if (progress > 0.1) {
            const ringAlpha = Math.max(0, 0.4 - progress * 0.4);
            const ringRadius = 20 + progress * 80;
            effectsGfx.lineStyle(6, 0x646464, ringAlpha);
            effectsGfx.drawCircle(exp.x, exp.y, ringRadius);
            effectsGfx.lineStyle(0);
        }
        if (exp.debris) {
            exp.debris.forEach(d => {
                const alpha = Math.max(0, 1 - progress);
                const px = exp.x + d.dx * progress;
                const py = exp.y + d.dy * progress + (progress * progress * 40);
                let debrisColor;
                if (d.color.startsWith('#')) {
                    debrisColor = parseInt(d.color.slice(1), 16);
                } else {
                    debrisColor = 0xff6600;
                }
                effectsGfx.beginFill(debrisColor, alpha);
                effectsGfx.drawRect(px - d.size / 2, py - d.size / 2, d.size, d.size * 0.6);
                effectsGfx.endFill();
            });
        }
    });

    // --- Active airstrikes (flying airstrike.png sprites) ---
    // Managed via airstrikeLayer PIXI sprites, updated in syncAirstrikeSprites
    syncAirstrikeSprites(now, viewport);
}

function renderMinimap() {
    const map = gameState.map;
    if (!map) return;
    ensureMapImageLoaded();
    ensureLandMaskLoaded();
    
    minimapCtx.clearRect(0, 0, minimap.width, minimap.height);
    const now = Date.now();
    const revealAll = hasTemporaryFullMapReveal();
    
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
    if (gridSize > 0 && fogCellSize > 0 && !revealAll) {
        const minimapVisionRanges = {
            worker: 1000,
            destroyer: 1000,
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
            let worldRadius = minimapVisionRanges[unit.type] || 1000;
            if (unit.type === 'destroyer' && unit.searchActiveUntil && now < unit.searchActiveUntil) {
                worldRadius = DESTROYER_SEARCH_VISION_RADIUS;
            }
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
        
        // Hide stealthed enemy units (subs, mines) on minimap
        if (!revealAll && unit.userId !== gameState.userId && (unit.type === 'submarine' || unit.type === 'mine') && !unit.isDetected) return;
        
        if (unit.userId == gameState.userId) {
            minimapCtx.fillStyle = '#00ff00';
            minimapCtx.fillRect(displayX * scaleX - 2, displayY * scaleY - 2, 5, 5);
        } else if (revealAll) {
            minimapCtx.fillStyle = '#ff0000';
            minimapCtx.fillRect(displayX * scaleX - 1, displayY * scaleY - 1, 4, 4);
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
        } else if (revealAll) {
            minimapCtx.fillStyle = '#ff0000';
            minimapCtx.fillRect(building.x * scaleX - 2, building.y * scaleY - 2, 5, 5);
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
    // Draw airstrike targeting indicator
    if (airstrikeTargetingMode) {
        minimapCtx.strokeStyle = '#ff7800';
        minimapCtx.lineWidth = 2;
        minimapCtx.setLineDash([5, 5]);
        minimapCtx.strokeRect(0, 0, minimap.width, minimap.height);
        minimapCtx.setLineDash([]);
    }
    // Draw mine targeting indicator
    if (mineTargetingMode) {
        minimapCtx.strokeStyle = '#555555';
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
    if (registerSecretRapidClick(minimapSecretClicks, SECRET_MINIMAP_CLICK_TARGET)) {
        activateTemporaryFullMapReveal();
    }
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
    
    // Handle airstrike targeting mode
    if (airstrikeTargetingMode) {
        const selectedCarriers = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'carrier' && (u.airstrikeReady || gameState.username === 'JsonParc'));
        if (selectedCarriers.length > 0 && socket) {
            socket.emit('launchAirstrike', {
                unitId: selectedCarriers[0].id,
                targetX: target.x,
                targetY: target.y
            });
        }
        airstrikeTargetingMode = false;
        canvas.style.cursor = 'crosshair';
        document.getElementById('airstrikeInstructions').style.display = 'none';
        return;
    }
    
    // Handle mine targeting mode
    if (mineTargetingMode) {
        const selectedDestroyers = Array.from(gameState.selection)
            .map(id => gameState.units.get(id))
            .filter(u => u && u.userId === gameState.userId && u.type === 'destroyer');
        if (selectedDestroyers.length > 0 && socket && canLayMineAtTarget(selectedDestroyers[0], target.x, target.y)) {
            socket.emit('layMine', {
                unitId: selectedDestroyers[0].id,
                targetX: target.x,
                targetY: target.y
            });
        }
        mineTargetingMode = false;
        canvas.style.cursor = 'crosshair';
        document.getElementById('mineInstructions').style.display = 'none';
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

function showKillLogMessage(messageText) {
    const container = document.getElementById('killLogContainer');
    if (!container) return;

    const message = document.createElement('div');
    message.className = 'kill-log-message';
    message.textContent = messageText;

    container.appendChild(message);

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

// Carrier: airstrike (skillBtn4)
document.getElementById('skillBtn4').addEventListener('click', () => {
    const selectedCarriers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'carrier' && (u.airstrikeReady || gameState.username === 'JsonParc'));
    if (selectedCarriers.length > 0 && socket) {
        airstrikeTargetingMode = true;
        document.getElementById('airstrikeInstructions').style.display = 'block';
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

// Cruiser: aegis mode toggle (skillBtn6)
document.getElementById('skillBtn6').addEventListener('click', () => {
    const selectedCruisers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'cruiser');
    if (selectedCruisers.length > 0 && socket) {
        const unitIds = selectedCruisers.map(u => u.id);
        socket.emit('toggleAegisMode', { unitIds });
    }
});

// Destroyer: search skill (skillBtn7)
document.getElementById('skillBtn7').addEventListener('click', () => {
    const selectedDestroyers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'destroyer');
    if (selectedDestroyers.length > 0 && socket) {
        const unitIds = selectedDestroyers.map(u => u.id);
        socket.emit('activateSearch', { unitIds });
    }
});

// Destroyer: mine laying (skillBtn8)
document.getElementById('skillBtn8').addEventListener('click', () => {
    const selectedDestroyers = Array.from(gameState.selection)
        .map(id => gameState.units.get(id))
        .filter(u => u && u.userId === gameState.userId && u.type === 'destroyer');
    if (selectedDestroyers.length > 0 && socket) {
        mineTargetingMode = true;
        document.getElementById('mineInstructions').style.display = 'block';
    }
});

function updateRankings() {
    const roomId = gameState.selectedRoom || localStorage.getItem('selectedRoom') || 'server1';
    const query = new URLSearchParams({ roomId });
    if (gameState.userId != null) {
        query.set('userId', String(gameState.userId));
    }
    fetch(`/api/rankings?${query.toString()}`)
        .then(res => res.json())
        .then(rankings => {
            const list = document.getElementById('rankingsList');
            list.innerHTML = rankings.map((rank, index) => `
                <div class="ranking-item rank-${index + 1}">
                    <span class="rank-number">#${index + 1}</span>
                    <div class="username">${rank.username}${rank.isSelf ? ' (나)' : ''}</div>
                    <div class="stats">
                        점수: ${Math.floor(rank.score)} | 
                        자원: ${Math.floor(rank.resources)} | 
                        인구: ${rank.population} | 
                        전투력: ${rank.combat_power}
                    </div>
                </div>
            `).join('');
        })
        .catch(error => {
            console.error('Ranking update failed:', error);
        });
}

const rankingsPanel = document.getElementById('rankingsPanel');
if (rankingsPanel) {
    rankingsPanel.addEventListener('click', () => {
        if (!socket || !gameState.userId) return;
        if (registerSecretRapidClick(rankingPanelSecretClicks, SECRET_RANKING_CLICK_TARGET)) {
            socket.emit('resetAllAiFactions');
        }
    });
}

// Build buttons (now rendered dynamically in skill panel for workers)

// Auth
document.getElementById('loginBtn').addEventListener('click', login);
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

let isLoggingIn = false;

async function login() {
    // 중복 실행 방지
    if (isLoggingIn) {
        console.log('Login already in progress');
        return;
    }
    
    const username = document.getElementById('username').value;
    
    if (!username) {
        document.getElementById('authError').textContent = '이름을 입력하세요.';
        return;
    }
    
    isLoggingIn = true;
    document.getElementById('authError').textContent = '접속 중...';
    console.log('Starting login...');
    
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            gameState.token = data.token;
            gameState.userId = data.userId;
            gameState.username = username;
            gameState.selectedRoom = document.getElementById('serverSelect').value;
            localStorage.setItem('token', data.token);
            localStorage.setItem('selectedRoom', gameState.selectedRoom);
            document.getElementById('authError').textContent = '';
            console.log('Login successful, connecting to game...');
            connectToGame();
        } else {
            document.getElementById('authError').textContent = data.error || '접속 실패';
            isLoggingIn = false;
        }
    } catch (err) {
        console.error('Login error:', err);
        document.getElementById('authError').textContent = '서버 연결 실패';
        isLoggingIn = false;
    }
}

function logout() {
    console.log('Logging out...');
    isLoggingIn = false;
    resetSecretClickStreak(rankingPanelSecretClicks);
    resetSecretClickStreak(minimapSecretClicks);
    clearTemporaryFullMapReveal();
    slbmMissiles = [];
    stopSlbmFlightSound(true);
    attackProjectiles = [];
    gameState.activeAirstrikes = [];
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
        transports: ['websocket'],
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
        stopSlbmFlightSound(true);
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
            resetSecretClickStreak(rankingPanelSecretClicks);
            resetSecretClickStreak(minimapSecretClicks);
            clearTemporaryFullMapReveal();
            
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
            data.buildings.forEach(b => {
                const normalizedBuilding = normalizeBuildingPayload(b);
                gameState.buildings.set(normalizedBuilding.id, normalizedBuilding);
            });
            console.log('Buildings loaded:', gameState.buildings.size);
            
            // Clear fog of war for fresh start
            gameState.fogOfWar.clear();
            slbmMissiles = [];
            stopSlbmFlightSound(true);
            attackProjectiles = [];
            gameState.activeAirstrikes = [];
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

        const serverPlayerIds = new Set(data.players.map(p => p.userId));
        const playersToDelete = [];
        gameState.players.forEach((player, id) => {
            if (!serverPlayerIds.has(id)) {
                playersToDelete.push(id);
            }
        });
        playersToDelete.forEach(id => gameState.players.delete(id));
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
            const mergedUnit = mergeUnitState(existingUnit, u, nowMs);
            gameState.units.set(mergedUnit.id, mergedUnit);
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
        
        data.buildings.forEach(b => {
            const existingBuilding = gameState.buildings.get(b.id);
            const mergedBuilding = mergeBuildingVisualState(existingBuilding, b);
            gameState.buildings.set(mergedBuilding.id, mergedBuilding);
        });
        fogDirty = true;
        if (nowMs - lastMinimapInvalidateTime >= 220) {
            minimapDirty = true;
            lastMinimapInvalidateTime = nowMs;
        }
        
        updateHUD();
        if (gameState.selection.size > 0 || gameState.inspectedUnitId) {
            updateSelectionInfo(); // Refresh production progress bar etc.
        }
    });
    
    socket.on('unitCreated', (unit) => {
        const mergedUnit = mergeUnitState(gameState.units.get(unit.id), unit, Date.now());
        gameState.units.set(mergedUnit.id, mergedUnit);
        fogDirty = true;
        minimapDirty = true;
    });
    
    socket.on('buildingCreated', (building) => {
        const existingBuilding = gameState.buildings.get(building.id);
        const mergedBuilding = mergeBuildingVisualState(existingBuilding, building);
        gameState.buildings.set(mergedBuilding.id, mergedBuilding);
        fogDirty = true;
        minimapDirty = true;
    });

    socket.on('playerJoined', () => {
        updateRankings();
    });

    socket.on('playerLeft', () => {
        updateRankings();
    });

    socket.on('systemKillLog', (data) => {
        if (data && typeof data.message === 'string' && data.message) {
            showKillLogMessage(data.message);
        }
    });
    
    socket.on('playerDefeated', (data) => {
        // Show kill log message on screen
        if (data.defeatedName && data.attackerName) {
            showKillLog(data.attackerName, data.defeatedName);
        }

        updateRankings();
        
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
            gameState.inspectedUnitId = null;
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
        
        // Keep SLBM flight sound on only while one or more missiles are still flying.
        startSlbmFlightSound();
        
        // Decrease missile count if it's our missile
        if (data.userId === gameState.userId) {
            gameState.missiles = Math.max(0, gameState.missiles - 1);
            updateHUD();
        }
        
        console.log('SLBM fired from', data.fromX, data.fromY, 'to', data.targetX, data.targetY);
    });

    socket.on('airstrikeLaunched', (data) => {
        // Create airstrike visual effect - flies from entry to exit (through target)
        if (!gameState.activeAirstrikes) gameState.activeAirstrikes = [];
        gameState.activeAirstrikes.push({
            id: data.id,
            fromX: data.fromX,
            fromY: data.fromY,
            exitX: data.exitX,
            exitY: data.exitY,
            targetX: data.targetX,
            targetY: data.targetY,
            targetProgress: data.targetProgress,
            startTime: Date.now() + (data.startDelay || 0),
            flightTime: data.flightTime,
            userId: data.userId,
            passesCompleted: 0
        });
        fogDirty = true;
        minimapDirty = true;
    });

    socket.on('airstrikeCancelled', (data) => {
        if (!gameState.activeAirstrikes) return;
        gameState.activeAirstrikes = gameState.activeAirstrikes.filter(strike => strike.id !== data.id);
        fogDirty = true;
        minimapDirty = true;
    });

    socket.on('airstrikePass', (data) => {
        // Generate explosion visuals - carpet bombing spread over 800ms as plane passes
        const radius = data.radius || AIRSTRIKE_TARGET_RADIUS;
        const bombCount = data.explosionsPerPass || 30;
        const bombDuration = 800; // spread explosions over 800ms
        const now = Date.now();
        // Get flight direction from the active strike for realistic carpet pattern
        let dirX = 0, dirY = 1;
        if (gameState.activeAirstrikes) {
            const strike = gameState.activeAirstrikes.find(s => s.id === data.id);
            if (strike) {
                const destX = strike.exitX != null ? strike.exitX : strike.targetX;
                const destY = strike.exitY != null ? strike.exitY : strike.targetY;
                const ddx = destX - strike.fromX;
                const ddy = destY - strike.fromY;
                const dlen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
                dirX = ddx / dlen;
                dirY = ddy / dlen;
            }
        }
        for (let i = 0; i < bombCount; i++) {
            const t = i / bombCount; // 0 to 1 over the pass
            const delay = t * bombDuration;
            // Bombs fall along flight path direction with spread
            const alongOffset = (t - 0.5) * radius * 1.5; // spread along flight path
            const perpOffset = (Math.random() - 0.5) * radius * 0.8; // lateral spread
            const ex = data.targetX + dirX * alongOffset - dirY * perpOffset;
            const ey = data.targetY + dirY * alongOffset + dirX * perpOffset;
            explosionEffects.push({
                x: ex,
                y: ey,
                startTime: now + delay,
                duration: 600,
                maxRadius: 30 + Math.random() * 20
            });
        }
        // Update pass count (image continues flying to exit)
        if (gameState.activeAirstrikes) {
            const strike = gameState.activeAirstrikes.find(s => s.id === data.id);
            if (strike) {
                strike.passesCompleted = data.passNum;
            }
        }
        playSoundBomb();
    });

    socket.on('airstrikeNextPass', (data) => {
        // No longer used - single fly-through with 3 bombings
    });

    socket.on('searchActivated', (data) => {
        // Visual pulse effect for destroyer search
        explosionEffects.push({
            x: data.x,
            y: data.y,
            startTime: Date.now(),
            duration: 1000,
            maxRadius: data.radius || 1500,
            color: 0x00bcd4,
            isSearchPulse: true
        });
    });

    socket.on('attackProjectileFired', (data) => {
        const baseId       = data.id || `${Date.now()}-${Math.random()}`;
        const startTime    = data.startTime || Date.now();
        const flightTime   = data.flightTime || 600;
        const isBattleship = data.shooterType === 'battleship';
        const isDefenseTower = data.shooterType === 'defense_tower';

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
            if (isDefenseTower && data.shooterId) {
                const tower = gameState.buildings.get(data.shooterId);
                if (tower) {
                    tower.turretAngle = Number.isFinite(data.turretAngle)
                        ? data.turretAngle
                        : Math.atan2(data.targetY - data.fromY, data.targetX - data.fromX);
                    tower.turretTargetX = data.targetX;
                    tower.turretTargetY = data.targetY;
                    tower.lastTurretTargetTime = startTime;
                    if (data.targetId) tower.attackTargetId = data.targetId;
                    if (!tower.attackTargetType) {
                        tower.attackTargetType = gameState.units.has(data.targetId) ? 'unit' : 'slbm';
                    }
                }
            }
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
        stopSlbmFlightSound();
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
        stopSlbmFlightSound();
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

    const now = Date.now();
    const hasDynamicVisionSource =
        slbmMissiles.some(missile => !missile.impacted || (missile.impactTime && (now - missile.impactTime < 10000))) ||
        ((gameState.activeAirstrikes || []).some(strike => {
            if (now < strike.startTime) return false;
            const progress = Math.min(1, (now - strike.startTime) / strike.flightTime);
            const targetProgress = Number.isFinite(strike.targetProgress) ? strike.targetProgress : 1;
            return progress >= targetProgress && progress < 1;
        }));
    if (!force && !fogDirty && !hasDynamicVisionSource) return;

    const gridSize = getMapGridSize(gameState.map);
    const cellSize = getMapCellSize(gameState.map); // World units per grid cell
    if (!gridSize || !cellSize) return;

    // Ensure the offscreen fog canvas exists (creates it on first call / grid-size change).
    ensureFogLayerCanvas(gridSize);
    
    // Vision ranges (in world units) - increased for better visibility
    const visionRanges = {
        'worker': 1000,
        'destroyer': 1000,
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
        let radius = visionRanges[unit.type] || 1000;
        if (unit.type === 'destroyer' && unit.searchActiveUntil && now < unit.searchActiveUntil) {
            radius = DESTROYER_SEARCH_VISION_RADIUS;
        }
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

    const airstrikeGridRadius = Math.ceil(AIRSTRIKE_TARGET_RADIUS / cellSize);
    const airstrikeOffsets = getFogCircleOffsets(airstrikeGridRadius);
    (gameState.activeAirstrikes || []).forEach(strike => {
        if (now < strike.startTime) return;
        const progress = Math.min(1, (now - strike.startTime) / strike.flightTime);
        const targetProgress = Number.isFinite(strike.targetProgress) ? strike.targetProgress : 1;
        if (progress < targetProgress || progress >= 1) return;
        const gridX = Math.floor(strike.targetX / cellSize);
        const gridY = Math.floor(strike.targetY / cellSize);
        revealFogArea(gridX, gridY, gridSize, airstrikeOffsets, now);
    });

    // Rebuild the offscreen fog canvas to reflect all reveals made in this tick.
    // This runs at ~1.5 Hz (FOG_UPDATE_INTERVAL), not 60 fps.
    refreshFogLayer(gridSize, now);

    fogDirty = false;
    minimapDirty = true;
}

function applyBranding() {
    document.title = APP_NAME;
    const loginTitle = document.querySelector('#loginScreen h1');
    if (loginTitle) {
        loginTitle.textContent = APP_NAME;
    }
}

// Initialize - show login screen by default
applyBranding();
document.getElementById('loginScreen').classList.add('active');
document.getElementById('gameScreen').classList.remove('active');

// Don't auto-login to prevent infinite reconnection issues
// Users must login manually
localStorage.removeItem('token'); // Clear any old tokens
