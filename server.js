const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  transports: ['websocket']
});

const APP_NAME = 'MW Craft';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this-in-production';
const GAME_TICK_RATE = 30; // 30 ticks per second
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'game.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
const COMBAT_SPATIAL_CELL_SIZE = 700;
const COLLISION_SPATIAL_CELL_SIZE = 400;
const NETWORK_UPDATE_BASE_MS = 100;
const AIRSTRIKE_DAMAGE_RADIUS = 400;
const AIRSTRIKE_VISUAL_RADIUS = 400;
const AIRSTRIKE_PASS_COUNT = 3;
const AIRSTRIKE_TOTAL_DAMAGE = 720;
const AIRSTRIKE_DAMAGE_PER_PASS = AIRSTRIKE_TOTAL_DAMAGE / AIRSTRIKE_PASS_COUNT;
const AIRSTRIKE_PASS_INTERVAL_MS = 667;
const BUILDING_BASE_DISPLAY_HEIGHT = 60 * 6.6;
const COASTAL_BUILDING_SIZE_SCALE = 0.6;
const POWER_PLANT_SIZE_SCALE = COASTAL_BUILDING_SIZE_SCALE * 0.7;
const FIXED_BUILDING_IMAGE_MAX_DIMENSION = 200;
const MISSILE_SILO_COST = 1600;
const BUILDING_PLACEMENT_BUFFER = 50;
const BUILDING_PLACEMENT_SEARCH_RADIUS = 4000;
const SLBM_MAX_HP = 500;
const DEFENSE_TOWER_CANNON_START = Object.freeze({ x: 5, y: 8 });
const DEFENSE_TOWER_CANNON_MUZZLE = Object.freeze({ x: 21, y: 12 });
const DESTROYER_SEARCH_VISION_RADIUS = 4800;
const DESTROYER_MAX_MINES = 5;
const SEARCH_REVEAL_DURATION_MS = 10000;
const SHIP_HEIGHT_MULT = 6.6;
const SHIP_ASPECT_RATIO = 0.25;
const NAVAL_UNIT_TYPES = new Set(['destroyer', 'cruiser', 'battleship', 'carrier', 'submarine', 'frigate']);
let nextAirstrikeId = 1;

function readPngDimensions(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  } catch (error) {
    return { width: 56, height: 43 };
  }
}

function computeBuildingBaseCollisionSize() {
  const hqImagePath = path.join(__dirname, 'public', 'assets', 'images', 'buildings', 'hq.png');
  const dims = readPngDimensions(hqImagePath);
  const baseWidth = BUILDING_BASE_DISPLAY_HEIGHT * (dims.width / dims.height);
  return Math.round(Math.max(baseWidth, BUILDING_BASE_DISPLAY_HEIGHT));
}

const IMAGE_BUILDING_BASE_COLLISION_SIZE = computeBuildingBaseCollisionSize();

function computeFixedImageDisplayMetrics(filePath, maxDimension = FIXED_BUILDING_IMAGE_MAX_DIMENSION) {
  const dims = readPngDimensions(filePath);
  const safeWidth = Math.max(1, dims.width || 1);
  const safeHeight = Math.max(1, dims.height || 1);
  const scale = maxDimension / Math.max(safeWidth, safeHeight);
  return {
    originalWidth: safeWidth,
    originalHeight: safeHeight,
    scale,
    width: safeWidth * scale,
    height: safeHeight * scale
  };
}

const DEFENSE_TOWER_IMAGE_METRICS = computeFixedImageDisplayMetrics(
  path.join(__dirname, 'public', 'assets', 'images', 'buildings', 'turret.png')
);

function getDefenseTowerMuzzleWorldPosition(centerX, centerY, targetX, targetY) {
  const scale = DEFENSE_TOWER_IMAGE_METRICS.scale;
  const pivotX = centerX - (DEFENSE_TOWER_IMAGE_METRICS.width / 2) + (DEFENSE_TOWER_CANNON_START.x * scale);
  const pivotY = centerY - (DEFENSE_TOWER_IMAGE_METRICS.height / 2) + (DEFENSE_TOWER_CANNON_START.y * scale);
  const angle = Math.atan2(targetY - pivotY, targetX - pivotX);
  const muzzleLocalX = (DEFENSE_TOWER_CANNON_MUZZLE.x - DEFENSE_TOWER_CANNON_START.x) * scale;
  const muzzleLocalY = (DEFENSE_TOWER_CANNON_MUZZLE.y - DEFENSE_TOWER_CANNON_START.y) * scale;
  const cosAngle = Math.cos(angle);
  const sinAngle = Math.sin(angle);
  return {
    angle,
    pivotX,
    pivotY,
    originX: pivotX + (muzzleLocalX * cosAngle) - (muzzleLocalY * sinAngle),
    originY: pivotY + (muzzleLocalX * sinAngle) + (muzzleLocalY * cosAngle)
  };
}

function getBuildingCollisionSize(type) {
  if (type === 'headquarters') return IMAGE_BUILDING_BASE_COLLISION_SIZE;
  if (type === 'power_plant') return Math.round(IMAGE_BUILDING_BASE_COLLISION_SIZE * POWER_PLANT_SIZE_SCALE);
  if (type === 'shipyard' || type === 'naval_academy') return Math.round(IMAGE_BUILDING_BASE_COLLISION_SIZE * COASTAL_BUILDING_SIZE_SCALE);
  return 200;
}

function getUnitAreaHitRadius(unit) {
  if (!unit) return 0;
  if (unit.type === 'worker' || unit.type === 'mine') return 20;
  const baseSize = unit.type === 'frigate' ? 35 : (unit.type === 'aircraft' ? 25 : 60);
  const heightMult = unit.type === 'aircraft' ? 2.5 : SHIP_HEIGHT_MULT;
  return (baseSize * heightMult) / 2;
}

function targetIntersectsDamageCircle(centerX, centerY, damageRadius, targetX, targetY, targetRadius) {
  const dx = targetX - centerX;
  const dy = targetY - centerY;
  const totalRadius = damageRadius + targetRadius;
  return (dx * dx) + (dy * dy) <= totalRadius * totalRadius;
}
const UNIT_DEFINITIONS = {
  worker: {
    cost: 50,
    pop: 1,
    hp: 100,
    damage: 5,
    speed: 12,
    size: 40,
    attackRange: 80,
    attackCooldownMs: 1200,
    visionRadius: 1000,
    buildTime: 3000
  },
  destroyer: {
    cost: 150,
    pop: 2,
    hp: 300,
    damage: 25,
    speed: 15,
    size: 60,
    attackRange: 1250,
    attackCooldownMs: 1000,
    visionRadius: 1000,
    buildTime: 8000
  },
  cruiser: {
    cost: 300,
    pop: 3,
    hp: 500,
    damage: 45,
    speed: 12,
    size: 60,
    attackRange: 2000,
    attackCooldownMs: 1300,
    visionRadius: 1200,
    buildTime: 15000
  },
  battleship: {
    cost: 600,
    pop: 5,
    hp: 1200,
    damage: 260,
    speed: 6,
    size: 60,
    attackRange: 2500,
    attackCooldownMs: 4800,
    visionRadius: 3200,
    buildTime: 35000
  },
  carrier: {
    cost: 800,
    pop: 6,
    hp: 900,
    damage: 0,
    speed: 8,
    size: 60,
    attackRange: 3750,
    attackCooldownMs: 99999,
    visionRadius: 4800,
    buildTime: 40000
  },
  submarine: {
    cost: 900,
    pop: 4,
    hp: 260,
    damage: 110,
    speed: 8,
    size: 60,
    attackRange: 360,
    attackCooldownMs: 2600,
    visionRadius: 800,
    buildTime: 30000
  },
  frigate: {
    cost: 120,
    pop: 1,
    hp: 90,
    damage: 85,
    speed: 18,
    size: 35,
    attackRange: 750,
    attackCooldownMs: 800,
    visionRadius: 900,
    buildTime: 5000
  },
  aircraft: {
    cost: 100,
    pop: 0,
    hp: 200,
    damage: 24,
    speed: 25,
    size: 25,
    attackRange: 160,
    attackCooldownMs: 250,
    visionRadius: 1000,
    buildTime: 0
  },
  mine: {
    cost: 0,
    pop: 0,
    hp: 100,
    damage: 9999,
    speed: 0,
    size: 40,
    attackRange: 80,
    attackCooldownMs: 99999,
    visionRadius: 0,
    buildTime: 0
  }
};
const DEFAULT_UNIT_DEFINITION = {
  cost: 100,
  pop: 1,
  hp: 100,
  damage: 10,
  speed: 10,
  size: 60,
  attackRange: 220,
  attackCooldownMs: 1000,
  visionRadius: 1000
};

// HP Regeneration settings
const HP_REGEN_CONFIG = {
  delayMs: 8000,       // Time without damage before regen starts (8 seconds)
  regenPerSecond: 5,   // HP regenerated per second
  regenIntervalMs: 1000 // How often to regenerate (every 1 second)
};

function getUnitDefinition(unitType) {
  return UNIT_DEFINITIONS[unitType] || DEFAULT_UNIT_DEFINITION;
}

function isNavalUnitType(unitType) {
  return NAVAL_UNIT_TYPES.has(unitType);
}

function addToSpatialMap(spatialMap, entity, cellSize = COMBAT_SPATIAL_CELL_SIZE) {
  const cellX = Math.floor(entity.x / cellSize);
  const cellY = Math.floor(entity.y / cellSize);
  const key = `${cellX}_${cellY}`;
  let bucket = spatialMap.get(key);
  if (!bucket) {
    bucket = [];
    spatialMap.set(key, bucket);
  }
  bucket.push(entity);
}

function forEachNearbyEntity(spatialMap, x, y, range, callback, cellSize = COMBAT_SPATIAL_CELL_SIZE) {
  const centerCellX = Math.floor(x / cellSize);
  const centerCellY = Math.floor(y / cellSize);
  const cellRadius = Math.ceil(range / cellSize);

  for (let dy = -cellRadius; dy <= cellRadius; dy++) {
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      const key = `${centerCellX + dx}_${centerCellY + dy}`;
      const bucket = spatialMap.get(key);
      if (!bucket) continue;
      for (let i = 0; i < bucket.length; i++) {
        callback(bucket[i]);
      }
    }
  }
}

// Load map configuration
let mapConfig = {
  mapSize: 4000,
  gridSize: 40,
  islands: { count: 12, minRadius: 2, maxRadius: 5 },
  resources: { perIsland: { min: 3, max: 6 }, radius: 60, amount: { min: 5000, max: 10000 } },
  spawnZones: { minDistanceFromEdge: 200, minDistanceFromOtherBases: 800 },
  vision: { workerVisionRadius: 150, unitVisionRadius: 200, buildingVisionRadius: 250, fogFadeTime: 30000 }
};

try {
  const configData = fs.readFileSync('mapConfig.json', 'utf8');
  mapConfig = JSON.parse(configData);
  console.log('Map configuration loaded from mapConfig.json');
} catch (error) {
  console.log('Using default map configuration');
}

const MAP_ASSETS_DIR = path.join(__dirname, 'public', 'assets', 'maps');
const TERRAIN_GRID_PATH = path.join(MAP_ASSETS_DIR, 'terrain-grid.json');
const LAND_CELLS_PATH = path.join(MAP_ASSETS_DIR, 'land-cells.json');
const DEFAULT_MAP_IMAGE_PATH = '/assets/maps/world-map.png';

function ensureMapAssetsDir() {
  try {
    fs.mkdirSync(MAP_ASSETS_DIR, { recursive: true });
  } catch (error) {
    console.warn('Could not create map assets directory:', error.message);
  }
}

function normalizeMapImagePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return DEFAULT_MAP_IMAGE_PATH;
  }
  if (rawPath.startsWith('/')) {
    return rawPath;
  }
  return `/${rawPath}`;
}

function generateTerrainGrid(gridSize) {
  const terrain = Array(gridSize).fill(null).map(() => Array(gridSize).fill(0));
  const numIslands = mapConfig.islands.count;

  for (let i = 0; i < numIslands; i++) {
    const centerX = Math.floor(Math.random() * gridSize);
    const centerY = Math.floor(Math.random() * gridSize);
    const radius = mapConfig.islands.minRadius + Math.floor(Math.random() * (mapConfig.islands.maxRadius - mapConfig.islands.minRadius + 1));

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (dx * dx + dy * dy <= radius * radius) {
          const x = centerX + dx;
          const y = centerY + dy;
          if (x >= 0 && x < gridSize && y >= 0 && y < gridSize) {
            terrain[y][x] = 1; // Land
          }
        }
      }
    }
  }

  return terrain;
}

function isValidTerrainGrid(terrain, gridSize) {
  if (!Array.isArray(terrain) || terrain.length !== gridSize) return false;
  for (let y = 0; y < gridSize; y++) {
    if (!Array.isArray(terrain[y]) || terrain[y].length !== gridSize) return false;
  }
  return true;
}

function loadTerrainGrid(gridSize) {
  try {
    if (!fs.existsSync(TERRAIN_GRID_PATH)) return null;
    const raw = fs.readFileSync(TERRAIN_GRID_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const terrain = parsed.terrain;
    if (!isValidTerrainGrid(terrain, gridSize)) {
      console.warn('terrain-grid.json exists but has invalid dimensions; regenerating terrain');
      return null;
    }
    return terrain;
  } catch (error) {
    console.warn('Failed to load terrain-grid.json; regenerating terrain:', error.message);
    return null;
  }
}

function saveTerrainGrid(terrain, mapWidth, mapHeight) {
  try {
    ensureMapAssetsDir();
    const payload = {
      generatedAt: new Date().toISOString(),
      mapWidth,
      mapHeight,
      gridSize: terrain.length,
      terrain
    };
    fs.writeFileSync(TERRAIN_GRID_PATH, JSON.stringify(payload), 'utf8');
  } catch (error) {
    console.warn('Failed to save terrain-grid.json:', error.message);
  }
}

function buildLandDataFromTerrain(terrain) {
  const gridSize = terrain.length;
  const landCells = [];
  const landCellSet = new Set();

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      if (terrain[y][x] === 1) {
        landCells.push([x, y]);
        landCellSet.add((y * gridSize) + x);
      }
    }
  }

  return { landCells, landCellSet };
}

function buildLandCellsSnapshot(map) {
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const landCells = Array.isArray(map.landCells) ? map.landCells.map(([x, y]) => [x, y]) : [];

  return {
    generatedAt: new Date().toISOString(),
    mapWidth: map.width,
    mapHeight: map.height,
    gridSize,
    cellSize,
    imagePath: map.imagePath,
    landCells
  };
}

function saveLandCellsSnapshot(snapshot) {
  try {
    ensureMapAssetsDir();
    fs.writeFileSync(LAND_CELLS_PATH, JSON.stringify(snapshot), 'utf8');
  } catch (error) {
    console.warn('Failed to save land-cells.json:', error.message);
  }
}

function buildClientMapPayload() {
  const map = gameState.map;
  if (!map) return null;

  return {
    width: map.width,
    height: map.height,
    imagePath: map.imagePath,
    gridSize: map.gridSize,
    cellSize: map.cellSize,
    landCells: map.landCells || [],
    resources: map.resources || [],
    obstacles: map.obstacles || [],
    hostileMobs: map.hostileMobs || []
  };
}

function buildClientPlayersPayload() {
  const players = [];
  gameState.players.forEach(player => {
    players.push({
      userId: player.userId,
      username: player.username,
      resources: player.resources,
      population: player.population,
      maxPopulation: player.maxPopulation,
      combatPower: player.combatPower,
      score: player.score,
      baseX: player.baseX,
      baseY: player.baseY,
      hasBase: !!player.hasBase,
      online: !!player.online,
      researchedSLBM: !!player.researchedSLBM,
      missiles: player.missiles || 0,
      isAI: !!player.isAI
    });
  });
  return players;
}

function buildClientUnitsPayload() {
  const units = [];
  gameState.units.forEach(unit => {
    units.push({
      id: unit.id,
      userId: unit.userId,
      type: unit.type,
      x: unit.x,
      y: unit.y,
      hp: unit.hp,
      maxHp: unit.maxHp,
      speed: unit.speed,
      damage: unit.damage,
      attackRange: unit.attackRange,
      targetX: unit.targetX,
      targetY: unit.targetY,
      gatheringResourceId: unit.gatheringResourceId ?? null,
      buildingType: unit.buildingType ?? null,
      buildTargetX: unit.buildTargetX ?? null,
      buildTargetY: unit.buildTargetY ?? null,
      sourceDestroyerId: unit.sourceDestroyerId ?? null,
      isDetected: !!unit.isDetected,
      kills: unit.kills ?? 0,
      aimedShot: !!unit.aimedShot,
      aimedShotCooldownUntil: unit.aimedShotCooldownUntil ?? null,
      aegisMode: !!unit.aegisMode,
      isIsolated: !!unit.isIsolated,
      aircraft: unit.aircraft ?? null,
      aircraftDeployed: unit.aircraftDeployed ?? null,
      aircraftQueue: unit.aircraftQueue ?? [],
      producingAircraft: unit.producingAircraft ?? null,
      attackMove: !!unit.attackMove,
      attackTargetId: unit.attackTargetId ?? null,
      attackTargetType: unit.attackTargetType ?? null,
      holdPosition: !!unit.holdPosition,
      searchCooldownUntil: unit.searchCooldownUntil ?? null,
      searchActiveUntil: unit.searchActiveUntil ?? null,
      airstrikeReady: !!unit.airstrikeReady,
      airstrikeCooldownUntil: unit.airstrikeCooldownUntil ?? null,
      isMine: unit.type === 'mine'
    });
  });
  return units;
}

function buildClientBuildingsPayload() {
  const buildings = [];
  gameState.buildings.forEach(building => {
    buildings.push({
      id: building.id,
      userId: building.userId,
      type: building.type,
      x: building.x,
      y: building.y,
      hp: building.hp,
      maxHp: building.maxHp,
      buildProgress: building.buildProgress,
      slbmCount: building.slbmCount ?? 0,
      producing: building.producing ?? null,
      missileProducing: building.missileProducing ?? null,
      missileQueue: building.missileQueue ?? [],
      attackTargetId: building.attackTargetId ?? null,
      attackTargetType: building.attackTargetType ?? null,
      turretAngle: building.turretAngle ?? null,
      turretTargetX: building.turretTargetX ?? null,
      turretTargetY: building.turretTargetY ?? null,
      lastTurretTargetTime: building.lastTurretTargetTime ?? null
    });
  });
  return buildings;
}

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS player_data (
    user_id INTEGER PRIMARY KEY,
    resources INTEGER DEFAULT 1000,
    population INTEGER DEFAULT 0,
    max_population INTEGER DEFAULT 10,
    combat_power INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    base_x REAL DEFAULT 0,
    base_y REAL DEFAULT 0,
    has_base INTEGER DEFAULT 1,
    researched_slbm INTEGER DEFAULT 0,
    last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    hp INTEGER NOT NULL,
    max_hp INTEGER NOT NULL,
    target_x REAL,
    target_y REAL,
    gathering_resource_id INTEGER,
    building_type TEXT,
    build_target_x REAL,
    build_target_y REAL,
    source_destroyer_id INTEGER,
    is_detected INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS buildings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    hp INTEGER NOT NULL,
    max_hp INTEGER NOT NULL,
    build_progress INTEGER DEFAULT 100,
    slbm_count INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Migration: add kills column if missing
try {
  db.prepare('SELECT kills FROM units LIMIT 1').get();
} catch (e) {
  db.prepare('ALTER TABLE units ADD COLUMN kills INTEGER DEFAULT 0').run();
  console.log('Migrated units table: added kills column');
}

// Migration: add source_destroyer_id column if missing
try {
  db.prepare('SELECT source_destroyer_id FROM units LIMIT 1').get();
} catch (e) {
  db.prepare('ALTER TABLE units ADD COLUMN source_destroyer_id INTEGER').run();
  console.log('Migrated units table: added source_destroyer_id column');
}

// Migration: add missiles column if missing
try {
  db.prepare('SELECT missiles FROM player_data LIMIT 1').get();
} catch (e) {
  db.prepare('ALTER TABLE player_data ADD COLUMN missiles INTEGER DEFAULT 0').run();
  console.log('Migrated player_data table: added missiles column');
}

app.use(express.json());
app.use(express.static('public'));

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, app: APP_NAME });
});

// Room configuration
const ROOM_CONFIG = [
  { id: 'server1', name: '\uC11C\uBC84 1', maxPlayers: 6 },
  { id: 'server2', name: '\uC11C\uBC84 2', maxPlayers: 6 }
];

// Room list API
app.get('/api/rooms', (req, res) => {
  const roomList = ROOM_CONFIG.map(rc => {
    const room = gameRooms.get(rc.id);
    const playerCount = room ? Array.from(room.players.values()).filter(p => p.online && !p.isAI).length : 0;
    const aiCount = room ? Array.from(room.players.values()).filter(p => p.isAI).length : 0;
    return { id: rc.id, name: rc.name, maxPlayers: rc.maxPlayers, playerCount, aiCount };
  });
  res.json(roomList);
});

function createRoomState() {
  return {
    players: new Map(),
    units: new Map(),
    buildings: new Map(),
    activeSlbms: new Map(),
    activeAirstrikes: new Map(),
    nextSlbmId: 1,
    map: null,
    landCellsSnapshot: null,
    lastUpdate: Date.now(),
    fogOfWar: new Map(),
    aiRespawnTimers: new Map()
  };
}

// Game rooms storage
const gameRooms = new Map();

// Active room context (swapped before processing)
let gameState = null;
let currentRoomId = null;
let nextSlbmId = 1;

// Room-scoped emit helper
function roomEmit(event, data) {
  if (currentRoomId) {
    io.to(currentRoomId).emit(event, data);
  } else {
    io.emit(event, data);
  }
}

function getRoomHumanCount(roomId) {
  const room = gameRooms.get(roomId);
  if (!room) return 0;

  let humanCount = 0;
  room.players.forEach(player => {
    if (player && !player.isAI && player.online !== false) {
      humanCount++;
    }
  });
  return humanCount;
}

function roomHasHumanPlayers(roomId) {
  return getRoomHumanCount(roomId) > 0;
}

// Switch context to a specific room
function switchRoom(roomId) {
  const room = gameRooms.get(roomId);
  if (!room) return false;
  gameState = room;
  currentRoomId = roomId;
  nextSlbmId = room.nextSlbmId;
  return true;
}

function removePlayerEntities(userId) {
  const unitsToDelete = [];
  gameState.units.forEach((unit, unitId) => {
    if (unit.userId === userId) {
      unitsToDelete.push(unitId);
    }
  });
  unitsToDelete.forEach(unitId => gameState.units.delete(unitId));

  const buildingsToDelete = [];
  gameState.buildings.forEach((building, buildingId) => {
    if (building.userId === userId) {
      buildingsToDelete.push(buildingId);
    }
  });
  buildingsToDelete.forEach(buildingId => gameState.buildings.delete(buildingId));
}

function removePlayerFromCurrentRoom(userId, options = {}) {
  const { emitPlayerLeft = false } = options;
  removePlayerEntities(userId);
  gameState.players.delete(userId);
  gameState.fogOfWar.delete(userId);
  if (emitPlayerLeft && currentRoomId) {
    io.to(currentRoomId).emit('playerLeft', userId);
  }
}

// Save slbmId back to room
function syncSlbmId() {
  if (gameState) {
    gameState.nextSlbmId = nextSlbmId;
  }
}

function clearCurrentRoomTransientState() {
  if (!gameState) return;
  gameState.activeSlbms.clear();
  if (gameState.activeAirstrikes) {
    gameState.activeAirstrikes.clear();
  }
}

function calculatePlayerScore(player) {
  if (!player) return 0;

  const resources = Number.isFinite(player.resources) ? player.resources : 0;
  const population = Number.isFinite(player.population) ? player.population : 0;
  const combatPower = Number.isFinite(player.combatPower) ? player.combatPower : 0;

  return Math.floor(resources + population * 100 + combatPower * 50);
}

// Initialize map
function initializeMap() {
  const MAP_SIZE = mapConfig.mapSize;
  const gridSize = mapConfig.gridSize;
  const cellSize = MAP_SIZE / gridSize;
  const map = {
    width: MAP_SIZE,
    height: MAP_SIZE,
    gridSize,
    cellSize,
    terrain: [], // 0 = water, 1 = land
    imagePath: normalizeMapImagePath(mapConfig.images && mapConfig.images.map),
    landCells: [],
    landCellSet: new Set(),
    obstacles: [],
    resources: [],
    hostileMobs: []
  };

  const existingTerrain = loadTerrainGrid(gridSize);
  if (existingTerrain) {
    map.terrain = existingTerrain;
    console.log(`Loaded persisted terrain grid from ${TERRAIN_GRID_PATH}`);
  } else {
    map.terrain = generateTerrainGrid(gridSize);
    saveTerrainGrid(map.terrain, MAP_SIZE, MAP_SIZE);
    console.log(`Generated new terrain grid and saved to ${TERRAIN_GRID_PATH}`);
  }

  const landData = buildLandDataFromTerrain(map.terrain);
  map.landCells = landData.landCells;
  map.landCellSet = landData.landCellSet;

  // Add resources on land (with overlap prevention)
  for (const [x, y] of map.landCells) {
    if (Math.random() < 0.15) {
      const newX = x * cellSize + (cellSize / 2);
      const newY = y * cellSize + (cellSize / 2);

      // Check if too close to existing resources
      const minDistance = mapConfig.resources.radius * 2.5;
      let tooClose = false;
      for (const resource of map.resources) {
        const dx = newX - resource.x;
        const dy = newY - resource.y;
        if (Math.sqrt(dx * dx + dy * dy) < minDistance) {
          tooClose = true;
          break;
        }
      }

      if (!tooClose) {
        const resourceId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
        map.resources.push({
          id: resourceId,
          x: newX,
          y: newY,
          amount: mapConfig.resources.amount.min + Math.floor(Math.random() * (mapConfig.resources.amount.max - mapConfig.resources.amount.min)),
          maxAmount: mapConfig.resources.amount.max,
          radius: mapConfig.resources.radius
        });
      }
    }
  }

  // AI players now replace hostile mobs
  // Hostile mobs array kept empty for compatibility
  map.hostileMobs = [];

  gameState.map = map;
  gameState.landCellsSnapshot = buildLandCellsSnapshot(map);
  saveLandCellsSnapshot(gameState.landCellsSnapshot);
  console.log(`Land cell snapshot saved to ${LAND_CELLS_PATH} (${gameState.landCellsSnapshot.landCells.length} cells)`);
}

// Initialize all game rooms
function initializeRooms() {
  // Create a temporary gameState for map initialization
  gameState = createRoomState();
  initializeMap();
  const sharedMap = gameState.map;
  const sharedLandCells = gameState.landCellsSnapshot;

  // Create each room with its own copy of the map (shared terrain, separate resources)
  ROOM_CONFIG.forEach(rc => {
    const room = createRoomState();
    // Deep copy map for each room (resources need to be independent)
    room.map = {
      ...sharedMap,
      resources: sharedMap.resources.map(r => ({ ...r })),
      landCells: sharedMap.landCells,
      landCellSet: sharedMap.landCellSet
    };
    room.landCellsSnapshot = sharedLandCells;
    gameRooms.set(rc.id, room);
    console.log(`Room '${rc.name}' (${rc.id}) initialized`);
  });
}

initializeRooms();

// Helper function to check if a position is on land
function isOnLand(x, y) {
  const map = gameState.map;
  if (!map || !map.landCellSet) return false;
  
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const gridX = Math.floor(x / cellSize);
  const gridY = Math.floor(y / cellSize);
  
  if (gridX < 0 || gridX >= gridSize || gridY < 0 || gridY >= gridSize) {
    return false;
  }
  
  return map.landCellSet.has((gridY * gridSize) + gridX);
}

function isWithinMapBounds(x, y) {
  const map = gameState.map;
  if (!map) return false;
  return x >= 0 && x <= map.width && y >= 0 && y <= map.height;
}

function clampToMapBounds(x, y) {
  const map = gameState.map;
  if (!map) return { x, y };
  return {
    x: Math.max(0, Math.min(map.width, x)),
    y: Math.max(0, Math.min(map.height, y))
  };
}

function revealFogCircleForPlayer(playerFog, worldX, worldY, radius, now) {
  const map = gameState.map;
  if (!map || !playerFog) return;

  const cellSize = map.cellSize || 50;
  const gridX = Math.floor(worldX / cellSize);
  const gridY = Math.floor(worldY / cellSize);
  const gridRadius = Math.ceil(radius / cellSize);

  for (let dx = -gridRadius; dx <= gridRadius; dx++) {
    for (let dy = -gridRadius; dy <= gridRadius; dy++) {
      if (dx * dx + dy * dy <= gridRadius * gridRadius) {
        const key = `${gridX + dx}_${gridY + dy}`;
        playerFog.set(key, { lastSeen: now, explored: true });
      }
    }
  }
}

function revealFogCircleForAllPlayers(worldX, worldY, radius, now) {
  gameState.players.forEach((player, playerId) => {
    if (!gameState.fogOfWar.has(playerId)) {
      gameState.fogOfWar.set(playerId, new Map());
    }
    revealFogCircleForPlayer(gameState.fogOfWar.get(playerId), worldX, worldY, radius, now);
  });
}

function hasAdjacentWaterTileForBuilding(x, y, size) {
  const map = gameState.map;
  if (!map || !map.landCellSet) return false;

  const cellSize = map.cellSize;
  const gridSize = map.gridSize;
  const halfSize = size / 2;
  const minGX = Math.max(0, Math.floor((x - halfSize) / cellSize));
  const maxGX = Math.min(gridSize - 1, Math.floor((x + halfSize) / cellSize));
  const minGY = Math.max(0, Math.floor((y - halfSize) / cellSize));
  const maxGY = Math.min(gridSize - 1, Math.floor((y + halfSize) / cellSize));
  const footprintCells = new Set();
  const cardinalOffsets = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let gy = minGY; gy <= maxGY; gy++) {
    for (let gx = minGX; gx <= maxGX; gx++) {
      footprintCells.add(`${gx}_${gy}`);
    }
  }

  for (let gy = minGY; gy <= maxGY; gy++) {
    for (let gx = minGX; gx <= maxGX; gx++) {
      for (const [dx, dy] of cardinalOffsets) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
        if (footprintCells.has(`${nx}_${ny}`)) continue;
        if (!map.landCellSet.has((ny * gridSize) + nx)) {
          return true;
        }
      }
    }
  }

  return false;
}

function findNearestCoastalBuildingPosition(x, y, size, maxSearchRadius = 2000) {
  const map = gameState.map;
  if (!map) return clampToMapBounds(x, y);

  const clamped = clampToMapBounds(x, y);
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const centerGridX = Math.floor(clamped.x / cellSize);
  const centerGridY = Math.floor(clamped.y / cellSize);
  const maxCellRadius = Math.ceil(maxSearchRadius / cellSize);

  function getCandidate(gridX, gridY) {
    if (gridX < 0 || gridX >= gridSize || gridY < 0 || gridY >= gridSize) return null;
    const pos = getCellCenter(gridX, gridY);
    if (!pos) return null;
    if (!isOnLand(pos.x, pos.y)) return null;
    if (!hasAdjacentWaterTileForBuilding(pos.x, pos.y, size)) return null;
    return pos;
  }

  const directCandidate = getCandidate(centerGridX, centerGridY);
  if (directCandidate) return directCandidate;

  for (let radius = 1; radius <= maxCellRadius; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;
        const candidate = getCandidate(gridX, gridY);
        if (candidate) return candidate;
      }
    }
  }

  return findNearestLandPosition(x, y);
}

function getCellCenter(gridX, gridY) {
  const map = gameState.map;
  if (!map) return null;
  return {
    x: (gridX * map.cellSize) + (map.cellSize / 2),
    y: (gridY * map.cellSize) + (map.cellSize / 2)
  };
}

// Find nearest land position from a given position
function findNearestLandPosition(x, y) {
  const clamped = clampToMapBounds(x, y);
  if (isOnLand(clamped.x, clamped.y)) return clamped;
  
  const map = gameState.map;
  if (!map) return clamped;
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const centerGridX = Math.floor(clamped.x / cellSize);
  const centerGridY = Math.floor(clamped.y / cellSize);
  
  // Search in expanding circles
  for (let radius = 1; radius < gridSize; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;
        if (!map.landCellSet.has((gridY * gridSize) + gridX)) continue;
        return getCellCenter(gridX, gridY);
      }
    }
  }
  
  // Fallback to findStartPosition
  return findStartPosition();
}

function isCoastalBuildingType(type) {
  return type === 'shipyard' || type === 'naval_academy';
}

function getBuildingPlacementSearchRadius() {
  const map = gameState && gameState.map;
  if (!map) return BUILDING_PLACEMENT_SEARCH_RADIUS;
  return Math.max(BUILDING_PLACEMENT_SEARCH_RADIUS, map.width, map.height);
}

function isBuildingPlacementValid(type, x, y, options = {}) {
  if (!gameState || !gameState.map) return false;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;

  const clamped = clampToMapBounds(x, y);
  if (Math.abs(clamped.x - x) > 0.5 || Math.abs(clamped.y - y) > 0.5) {
    return false;
  }

  const candidateSize = options.size || getBuildingCollisionSize(type);
  if (!isOnLand(x, y)) return false;
  if (isCoastalBuildingType(type) && !hasAdjacentWaterTileForBuilding(x, y, candidateSize)) {
    return false;
  }

  const ignoreBuildingIds = options.ignoreBuildingIds instanceof Set ? options.ignoreBuildingIds : null;
  const ignoreBuildingId = options.ignoreBuildingId ?? null;
  let blocked = false;

  gameState.buildings.forEach(building => {
    if (blocked || !building) return;
    if (building.id === ignoreBuildingId) return;
    if (ignoreBuildingIds && ignoreBuildingIds.has(building.id)) return;

    const dx = building.x - x;
    const dy = building.y - y;
    const existingBuildingSize = getBuildingCollisionSize(building.type);
    const minDistance = (candidateSize / 2) + (existingBuildingSize / 2) + BUILDING_PLACEMENT_BUFFER;

    if ((dx * dx) + (dy * dy) < minDistance * minDistance) {
      blocked = true;
    }
  });

  return !blocked;
}

function findNearestValidBuildingPosition(type, x, y, options = {}) {
  if (!gameState || !gameState.map) return null;

  const map = gameState.map;
  const clamped = clampToMapBounds(x, y);
  if (isBuildingPlacementValid(type, clamped.x, clamped.y, options)) {
    return clamped;
  }

  const cellSize = Math.max(1, map.cellSize || 50);
  const gridSize = map.gridSize;
  const centerGridX = Math.max(0, Math.min(gridSize - 1, Math.floor(clamped.x / cellSize)));
  const centerGridY = Math.max(0, Math.min(gridSize - 1, Math.floor(clamped.y / cellSize)));
  const centerCandidate = getCellCenter(centerGridX, centerGridY);
  if (centerCandidate && isBuildingPlacementValid(type, centerCandidate.x, centerCandidate.y, options)) {
    return centerCandidate;
  }

  const maxSearchRadius = options.maxSearchRadius ?? getBuildingPlacementSearchRadius();
  const maxCellRadius = Math.max(1, Math.ceil(maxSearchRadius / cellSize));

  for (let radius = 1; radius <= maxCellRadius; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);
    let bestCandidate = null;
    let bestDistanceSq = Infinity;

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;

        const candidate = getCellCenter(gridX, gridY);
        if (!candidate) continue;
        if (!isBuildingPlacementValid(type, candidate.x, candidate.y, options)) continue;

        const dx = candidate.x - clamped.x;
        const dy = candidate.y - clamped.y;
        const distanceSq = (dx * dx) + (dy * dy);
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestCandidate = candidate;
        }
      }
    }

    if (bestCandidate) {
      return bestCandidate;
    }
  }

  return null;
}

function findNearestWaterPosition(x, y, maxSearchRadius = 220) {
  const map = gameState.map;
  if (!map) return null;

  const clamped = clampToMapBounds(x, y);
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const centerGridX = Math.floor(clamped.x / cellSize);
  const centerGridY = Math.floor(clamped.y / cellSize);

  if (centerGridX >= 0 && centerGridX < gridSize && centerGridY >= 0 && centerGridY < gridSize) {
    if (!map.landCellSet.has((centerGridY * gridSize) + centerGridX)) {
      return getCellCenter(centerGridX, centerGridY);
    }
  }

  const clampedRadius = Math.max(1, Math.min(maxSearchRadius, gridSize));

  for (let radius = 1; radius <= clampedRadius; radius++) {
    const minY = Math.max(0, centerGridY - radius);
    const maxY = Math.min(gridSize - 1, centerGridY + radius);
    const minX = Math.max(0, centerGridX - radius);
    const maxX = Math.min(gridSize - 1, centerGridX + radius);

    for (let gridY = minY; gridY <= maxY; gridY++) {
      for (let gridX = minX; gridX <= maxX; gridX++) {
        const isEdge = gridY === minY || gridY === maxY || gridX === minX || gridX === maxX;
        if (!isEdge) continue;
        if (map.landCellSet.has((gridY * gridSize) + gridX)) continue;
        return getCellCenter(gridX, gridY);
      }
    }
  }

  return null;
}

function assignMoveTarget(unit, targetX, targetY) {
  if (!unit) return false;
  const clampedTarget = clampToMapBounds(targetX, targetY);

  if (unit.type === 'worker' || unit.type === 'aircraft') {
    // Workers and aircraft can move anywhere (land + water)
    const path = findPath(unit.x, unit.y, clampedTarget.x, clampedTarget.y, 'worker');
    if (path && path.length > 1) {
      unit.pathWaypoints = path.slice(1); // skip current position
      const next = unit.pathWaypoints.shift();
      unit.targetX = next.x;
      unit.targetY = next.y;
    } else {
      unit.pathWaypoints = null;
      unit.targetX = clampedTarget.x;
      unit.targetY = clampedTarget.y;
    }
    return true;
  }

  // Ships can only move on water.
  let moveTarget = clampedTarget;
  if (isOnLand(clampedTarget.x, clampedTarget.y)) {
    const nearestWater = findNearestWaterPosition(clampedTarget.x, clampedTarget.y);
    if (!nearestWater) {
      return false;
    }
    moveTarget = nearestWater;
  }

  // Use A* pathfinding for ships to navigate around islands
  const path = findPath(unit.x, unit.y, moveTarget.x, moveTarget.y, 'ship');
  if (path && path.length > 1) {
    unit.pathWaypoints = path.slice(1);
    const next = unit.pathWaypoints.shift();
    unit.targetX = next.x;
    unit.targetY = next.y;
  } else {
    unit.pathWaypoints = null;
    unit.targetX = moveTarget.x;
    unit.targetY = moveTarget.y;
  }
  return true;
}

// ==================== A* PATHFINDING ====================
// Uses a coarse grid for performance on large 40000x40000 maps.
// STEP=2 means each path cell = 2x2 terrain cells (100x100 world units).

function findPath(fromX, fromY, toX, toY, unitKind) {
  const map = gameState.map;
  if (!map) return null;

  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const STEP = 2; // Finer grid for more accurate pathing
  const pathGridSize = Math.ceil(gridSize / STEP);

  const startGX = Math.floor(fromX / cellSize / STEP);
  const startGY = Math.floor(fromY / cellSize / STEP);
  const endGX = Math.floor(toX / cellSize / STEP);
  const endGY = Math.floor(toY / cellSize / STEP);

  const clamp = (v, max) => Math.max(0, Math.min(max - 1, v));
  const sgx = clamp(startGX, pathGridSize);
  const sgy = clamp(startGY, pathGridSize);
  const egx = clamp(endGX, pathGridSize);
  const egy = clamp(endGY, pathGridSize);

  if (sgx === egx && sgy === egy) return null;

  // Check if a coarse cell is passable by checking ALL terrain cells in it
  // (for ships, ALL sub-cells must be water; for workers, always passable)
  function isPassable(gx, gy) {
    if (unitKind !== 'ship') return true; // workers go anywhere
    for (let dy = 0; dy < STEP; dy++) {
      for (let dx = 0; dx < STEP; dx++) {
        const cx = gx * STEP + dx;
        const cy = gy * STEP + dy;
        if (cx >= gridSize || cy >= gridSize) return false;
        if (map.landCellSet.has(cy * gridSize + cx)) return false;
      }
    }
    return true;
  }

  // Pre-check: if destination not passable, find nearest passable cell
  let destGX = egx, destGY = egy;
  if (!isPassable(destGX, destGY)) {
    // Search expanding ring for nearest passable cell
    let found = false;
    for (let r = 1; r <= 20 && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
          const nx = egx + dx, ny = egy + dy;
          if (nx >= 0 && nx < pathGridSize && ny >= 0 && ny < pathGridSize && isPassable(nx, ny)) {
            destGX = nx;
            destGY = ny;
            found = true;
          }
        }
      }
    }
    if (!found) return null; // no reachable destination
  }

  // A* with binary heap for performance
  const keyOf = (x, y) => y * pathGridSize + x;
  const endKey = keyOf(destGX, destGY);

  function heuristic(ax, ay) {
    const dx = Math.abs(ax - destGX);
    const dy = Math.abs(ay - destGY);
    return (dx + dy) + (1.414 - 2) * Math.min(dx, dy); // octile distance
  }

  // Simple binary min-heap on f values
  const gScore = new Float32Array(pathGridSize * pathGridSize).fill(Infinity);
  const fScore = new Float32Array(pathGridSize * pathGridSize).fill(Infinity);
  const cameFrom = new Int32Array(pathGridSize * pathGridSize).fill(-1);
  const inClosed = new Uint8Array(pathGridSize * pathGridSize);

  const startKey = keyOf(sgx, sgy);
  gScore[startKey] = 0;
  fScore[startKey] = heuristic(sgx, sgy);

  // Open set as an array-based min-heap of keys
  const heap = [startKey];
  const inOpen = new Uint8Array(pathGridSize * pathGridSize);
  inOpen[startKey] = 1;

  function heapPush(key) {
    heap.push(key);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (fScore[heap[parent]] <= fScore[heap[i]]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  }

  function heapPop() {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < heap.length && fScore[heap[l]] < fScore[heap[smallest]]) smallest = l;
        if (r < heap.length && fScore[heap[r]] < fScore[heap[smallest]]) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
        i = smallest;
      }
    }
    return top;
  }

  const dirs = [[-1,0,1],[1,0,1],[0,-1,1],[0,1,1],[-1,-1,1.414],[-1,1,1.414],[1,-1,1.414],[1,1,1.414]];
  const MAX_ITERATIONS = 8000;
  let iterations = 0;

  while (heap.length > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    const currentKey = heapPop();
    inOpen[currentKey] = 0;

    if (currentKey === endKey) {
      // Reconstruct path
      const pathCells = [];
      let k = currentKey;
      while (k !== -1) {
        const py = Math.floor(k / pathGridSize);
        const px = k % pathGridSize;
        pathCells.unshift({ gx: px, gy: py });
        k = cameFrom[k];
      }
      // Convert to world coordinates (center of coarse cell)
      const halfStep = Math.floor(STEP / 2);
      return pathCells.map(n => ({
        x: (n.gx * STEP + halfStep) * cellSize + cellSize / 2,
        y: (n.gy * STEP + halfStep) * cellSize + cellSize / 2
      }));
    }

    inClosed[currentKey] = 1;
    const cy = Math.floor(currentKey / pathGridSize);
    const cx = currentKey % pathGridSize;

    for (const [ddx, ddy, cost] of dirs) {
      const nx = cx + ddx;
      const ny = cy + ddy;
      if (nx < 0 || nx >= pathGridSize || ny < 0 || ny >= pathGridSize) continue;
      const nKey = keyOf(nx, ny);
      if (inClosed[nKey]) continue;
      if (!isPassable(nx, ny)) continue;

      // For diagonal moves, both adjacent straight cells must be passable
      if (ddx !== 0 && ddy !== 0) {
        if (!isPassable(cx + ddx, cy) || !isPassable(cx, cy + ddy)) continue;
      }

      const tentativeG = gScore[currentKey] + cost;
      if (tentativeG >= gScore[nKey]) continue;

      cameFrom[nKey] = currentKey;
      gScore[nKey] = tentativeG;
      fScore[nKey] = tentativeG + heuristic(nx, ny);

      if (!inOpen[nKey]) {
        inOpen[nKey] = 1;
        heapPush(nKey);
      }
    }
  }

  // No path found
  return null;
}
// ==================== END A* PATHFINDING ====================

function emitAttackProjectile(attacker, target) {
  if (!attacker || !target) return;

  const projectileId = (Date.now() * 1000) + Math.floor(Math.random() * 1000);
  const startTime = Date.now();
  let fromX = attacker.x;
  let fromY = attacker.y;
  let turretAngle = null;

  if (attacker.type === 'defense_tower') {
    const muzzle = getDefenseTowerMuzzleWorldPosition(attacker.x, attacker.y, target.x, target.y);
    fromX = muzzle.originX;
    fromY = muzzle.originY;
    turretAngle = muzzle.angle;
    attacker.turretAngle = muzzle.angle;
    attacker.turretTargetX = target.x;
    attacker.turretTargetY = target.y;
    attacker.lastTurretTargetTime = startTime;
  }

  const dx = target.x - fromX;
  const dy = target.y - fromY;
  const distance = Math.sqrt((dx * dx) + (dy * dy));
  const projectileSpeed = (attacker.type === 'battleship' || attacker.type === 'defense_tower') ? 3000 : 2300;
  const flightTimeMs = Math.max(200, Math.min(2200, Math.round((distance / projectileSpeed) * 1000)));

  roomEmit('attackProjectileFired', {
    id: projectileId,
    fromX,
    fromY,
    targetX: target.x,
    targetY: target.y,
    targetId: target.id,
    shooterId: attacker.id,
    shooterType: attacker.type,
    aimedShot: (attacker.type === 'battleship' && attacker.aimedShot) ? true : false,
    turretAngle,
    startTime,
    flightTime: flightTimeMs
  });
}

function findNonOverlappingPosition(x, y, size) {
  let bestX = x;
  let bestY = y;
  const radius = size * 0.45;
  
  for (let attempt = 0; attempt < 8; attempt++) {
    let hasOverlap = false;
    gameState.units.forEach(unit => {
      const dx = unit.x - bestX;
      const dy = unit.y - bestY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const unitRadius = (unit.type === 'worker' ? 40 : 60) * 0.45;
      if (dist < radius + unitRadius) {
        hasOverlap = true;
      }
    });
    if (!hasOverlap) break;
    const angle = (attempt / 8) * Math.PI * 2;
    bestX = x + Math.cos(angle) * size * (1 + attempt * 0.5);
    bestY = y + Math.sin(angle) * size * (1 + attempt * 0.5);
    const clamped = clampToMapBounds(bestX, bestY);
    bestX = clamped.x;
    bestY = clamped.y;
  }
  return { x: bestX, y: bestY };
}

// Export land-cell coordinates for manual map painting
app.get('/api/map/land-cells', (req, res) => {
  // Use first room's land cells (shared terrain)
  const firstRoom = gameRooms.get(ROOM_CONFIG[0].id);
  if (!firstRoom || !firstRoom.landCellsSnapshot) {
    return res.status(503).json({ error: 'Map is not initialized yet' });
  }
  res.json(firstRoom.landCellsSnapshot);
});

// Auth endpoints (simplified: no password, no registration)
let nextTempUserId = 10000;

app.post('/api/login', (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  // Assign a temporary userId (no DB persistence)
  const userId = nextTempUserId++;
  const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '1d' });
  
  res.json({ token, userId, username });
});

// Reset player game data (keeps account, resets progress) - respawn at random location
app.post('/api/reset', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const userId = decoded.userId;
    
    // Delete all units and buildings for this player (DB ops may fail for temp users, that's OK)
    try {
      db.prepare('DELETE FROM units WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM buildings WHERE user_id = ?').run(userId);
    } catch(e) { /* no-op for temp users */ }
    
    // Find a new random starting position
    const newStartPos = findStartPosition();
    // Ensure the new base is on land
    let finalX = newStartPos.x;
    let finalY = newStartPos.y;
    if (!isOnLand(finalX, finalY)) {
      const landPos = findNearestLandPosition(finalX, finalY);
      finalX = landPos.x;
      finalY = landPos.y;
    }
    
    // Also clear from all room game states and create new HQ
    let persistedBasePos = null;
    gameRooms.forEach((room, roomId) => {
      switchRoom(roomId);
      const gs = room;
      const unitsToDelete = [];
      gs.units.forEach((unit, unitId) => {
        if (unit.userId === userId) {
          unitsToDelete.push(unitId);
        }
      });
      unitsToDelete.forEach(id => gs.units.delete(id));
      
      const buildingsToDelete = [];
      gs.buildings.forEach((building, buildingId) => {
        if (building.userId === userId) {
          buildingsToDelete.push(buildingId);
        }
      });
      buildingsToDelete.forEach(id => gs.buildings.delete(id));

      const resolvedResetPos = findNearestValidBuildingPosition('headquarters', finalX, finalY);
      const roomFinalX = resolvedResetPos ? resolvedResetPos.x : finalX;
      const roomFinalY = resolvedResetPos ? resolvedResetPos.y : finalY;
      if (!persistedBasePos) {
        persistedBasePos = { x: roomFinalX, y: roomFinalY };
      }
      
      // Reset player in memory with new base position
      const player = gs.players.get(userId);
      if (player) {
        player.resources = 1000;
        player.population = 0;
        player.maxPopulation = 10;
        player.combatPower = 0;
        player.score = 0;
        player.baseX = roomFinalX;
        player.baseY = roomFinalY;
        player.hasBase = true;
        player.researchedSLBM = false;
        player.missiles = 0;
      }
      
      // Create new headquarters for the player
      const hqId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      gs.buildings.set(hqId, {
        id: hqId,
        userId: userId,
        type: 'headquarters',
        x: roomFinalX,
        y: roomFinalY,
        hp: 1500,
        maxHp: 1500,
        buildProgress: 100
      });
      
      // Notify all clients about the reset
      io.to(roomId).emit('buildingPlaced', {
        id: hqId,
        userId: userId,
        type: 'headquarters',
        x: roomFinalX,
        y: roomFinalY,
        hp: 1500,
        maxHp: 1500,
        buildProgress: 100
      });
    });

    const basePosForPersistence = persistedBasePos || { x: finalX, y: finalY };
    try {
      db.prepare(`UPDATE player_data SET 
        resources = 1000, population = 0, max_population = 10,
        combat_power = 0, score = 0, base_x = ?, base_y = ?,
        has_base = 1, researched_slbm = 0, missiles = 0
        WHERE user_id = ?`).run(basePosForPersistence.x, basePosForPersistence.y, userId);
    } catch(e) { /* no-op for temp users */ }
    
    console.log(`Reset game data for user ${userId} - new base at (${basePosForPersistence.x.toFixed(0)}, ${basePosForPersistence.y.toFixed(0)})`);
    res.json({ success: true, message: 'Game data reset successfully', baseX: basePosForPersistence.x, baseY: basePosForPersistence.y });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Find starting position on land near resources
function findStartPosition() {
  const map = gameState.map;
  const gridSize = map.gridSize;
  const cellSize = map.cellSize;
  const minDistance = mapConfig.spawnZones.minDistanceFromEdge;
  const minBasePath = mapConfig.spawnZones.minDistanceFromOtherBases;
  const landCells = map.landCells || [];

  console.log(`findStartPosition: landCells.length=${landCells.length}, gridSize=${gridSize}, cellSize=${cellSize}`);
  
  // First pass: find land cell near resources, far from edges and other bases
  for (let attempts = 0; attempts < 200; attempts++) {
    if (landCells.length === 0) break;
    const [gridX, gridY] = landCells[Math.floor(Math.random() * landCells.length)];
    const worldX = gridX * cellSize + cellSize / 2;
    const worldY = gridY * cellSize + cellSize / 2;
    
    // Check distance from edges
    if (worldX < minDistance || worldX > map.width - minDistance ||
        worldY < minDistance || worldY > map.height - minDistance) {
      continue;
    }
    
    // Check distance from other bases
    let tooClose = false;
    gameState.buildings.forEach(building => {
      if (building.type === 'headquarters') {
        const dx = building.x - worldX;
        const dy = building.y - worldY;
        if (Math.sqrt(dx * dx + dy * dy) < minBasePath) {
          tooClose = true;
        }
      }
    });
    
    if (!tooClose) {
      // Verify this cell is ACTUALLY on land
      if (!isOnLand(worldX, worldY)) {
        console.warn(`findStartPosition: landCells entry [${gridX},${gridY}] returned NON-LAND world pos (${worldX}, ${worldY}). Skipping.`);
        continue;
      }
      
      // Also require enough surrounding land cells (at least 3x3 area of land)
      let surroundingLand = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const checkX = gridX + dx;
          const checkY = gridY + dy;
          if (checkX >= 0 && checkX < gridSize && checkY >= 0 && checkY < gridSize) {
            if (map.landCellSet.has(checkY * gridSize + checkX)) {
              surroundingLand++;
            }
          }
        }
      }
      if (surroundingLand < 5) {
        continue; // Skip edge-of-island cells
      }

      if (!isBuildingPlacementValid('headquarters', worldX, worldY)) {
        continue;
      }
      
      // Prefer near resources, but don't require it
      const nearResource = map.resources.some(resource => {
        const dx = resource.x - worldX;
        const dy = resource.y - worldY;
        return Math.sqrt(dx * dx + dy * dy) < 800;
      });
      
      if (nearResource || attempts > 100) {
        console.log(`findStartPosition: selected land at (${worldX}, ${worldY}), grid=[${gridX},${gridY}], isOnLand=${isOnLand(worldX, worldY)}, surroundingLand=${surroundingLand}`);
        return { x: worldX, y: worldY };
      }
    }
  }
  
  // Fallback: pick ANY land cell that is deep enough inland
  if (landCells.length > 0) {
    // Shuffle and find first cell with enough surrounding land
    for (let i = 0; i < Math.min(landCells.length, 500); i++) {
      const idx = Math.floor(Math.random() * landCells.length);
      const [gx, gy] = landCells[idx];
      const wx = gx * cellSize + cellSize / 2;
      const wy = gy * cellSize + cellSize / 2;
      if (!isOnLand(wx, wy)) continue;
      
      // Check it's not on the very edge of an island
      let landCount = 0;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          const cx = gx + dx;
          const cy = gy + dy;
          if (cx >= 0 && cx < gridSize && cy >= 0 && cy < gridSize) {
            if (map.landCellSet.has(cy * gridSize + cx)) landCount++;
          }
        }
      }
      if (landCount >= 10) {
        if (!isBuildingPlacementValid('headquarters', wx, wy)) {
          continue;
        }
        console.log(`findStartPosition: fallback selected land at (${wx}, ${wy}), grid=[${gx},${gy}]`);
        return { x: wx, y: wy };
      }
    }
    
    // Last resort: any land cell
    const [fallbackGridX, fallbackGridY] = landCells[Math.floor(Math.random() * landCells.length)];
    const fx = (fallbackGridX * cellSize) + (cellSize / 2);
    const fy = (fallbackGridY * cellSize) + (cellSize / 2);
    const fallbackPos = findNearestValidBuildingPosition('headquarters', fx, fy);
    if (fallbackPos) {
      console.log(`findStartPosition: LAST RESORT relocated to (${fallbackPos.x}, ${fallbackPos.y}), grid=[${fallbackGridX},${fallbackGridY}], isOnLand=${isOnLand(fallbackPos.x, fallbackPos.y)}`);
      return fallbackPos;
    }
    console.log(`findStartPosition: LAST RESORT at (${fx}, ${fy}), grid=[${fallbackGridX},${fallbackGridY}], isOnLand=${isOnLand(fx, fy)}`);
    return { x: fx, y: fy };
  }

  console.error('findStartPosition: NO LAND CELLS AVAILABLE');
  return { x: map.width / 2, y: map.height / 2 };
}

// Spawn base with workers for a player
function spawnPlayerBase(userId) {
  removePlayerEntities(userId);
  
  // Find a good starting position
  const startPos = findStartPosition();
  
  // HARD GUARANTEE: verify position is on land, relocate if not
  if (!isOnLand(startPos.x, startPos.y)) {
    console.warn(`spawnPlayerBase: findStartPosition returned water pos (${startPos.x}, ${startPos.y}), relocating to nearest land`);
    const landPos = findNearestLandPosition(startPos.x, startPos.y);
    startPos.x = landPos.x;
    startPos.y = landPos.y;
    console.log(`spawnPlayerBase: relocated to (${startPos.x}, ${startPos.y}), isOnLand=${isOnLand(startPos.x, startPos.y)}`);
  }

  const resolvedStartPos = findNearestValidBuildingPosition('headquarters', startPos.x, startPos.y);
  if (resolvedStartPos) {
    startPos.x = resolvedStartPos.x;
    startPos.y = resolvedStartPos.y;
  }
  
  // Create headquarters
  const hqId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  gameState.buildings.set(hqId, {
    id: hqId,
    userId: userId,
    type: 'headquarters',
    x: startPos.x,
    y: startPos.y,
    hp: 1500,
    maxHp: 1500,
    buildProgress: 100
  });
  
  // Create 4 worker units around the base
  const workerConfig = getUnitDefinition('worker');
  for (let i = 0; i < 4; i++) {
    const angle = (Math.PI * 2 * i) / 4;
    const distance = 150;
    const workerId = Date.now() * 1000 + Math.floor(Math.random() * 1000) + i;
    gameState.units.set(workerId, {
      id: workerId,
      userId: userId,
      type: 'worker',
      x: startPos.x + Math.cos(angle) * distance,
      y: startPos.y + Math.sin(angle) * distance,
      hp: workerConfig.hp,
      maxHp: workerConfig.hp,
      damage: workerConfig.damage,
      speed: workerConfig.speed,
      attackRange: workerConfig.attackRange,
      attackCooldownMs: workerConfig.attackCooldownMs,
      targetX: null,
      targetY: null,
      gatheringResourceId: null,
      buildingType: null,
      buildTargetX: null,
      buildTargetY: null,
      kills: 0
    });
  }
  
  // Update player data
  const player = gameState.players.get(userId);
  if (player) {
    player.baseX = startPos.x;
    player.baseY = startPos.y;
    player.hasBase = true;
    player.population = 4; // 4 workers
  }
  
  // Update database (skip for AI players)
  const isAI = player && player.isAI;
  if (!isAI) {
    try {
      db.prepare('UPDATE player_data SET base_x = ?, base_y = ?, has_base = 1, population = 4 WHERE user_id = ?').run(startPos.x, startPos.y, userId);
    } catch(e) { /* no-op: temp user has no DB row */ }
  }
  
  return startPos;
}

// Admin spawn for "JsonParc" - all buildings + all units + 100k energy + 300 pop
function spawnAdminBase(userId) {
  // First do normal spawn to get base position
  const startPos = spawnPlayerBase(userId);
  const player = gameState.players.get(userId);
  if (!player) return;

  // Set admin resources
  player.resources = 100000;
  player.maxPopulation = 300;
  player.researchedSLBM = true;
  player.missiles = 10;

  const baseX = startPos.x;
  const baseY = startPos.y;

  // Spawn all building types around HQ (skip headquarters - already placed)
  const adminBuildings = ['shipyard', 'power_plant', 'defense_tower', 'naval_academy', 'missile_silo'];
  const buildingTypes = {
    'shipyard': { hp: 800, size: getBuildingCollisionSize('shipyard') },
    'power_plant': { hp: 600, size: getBuildingCollisionSize('power_plant') },
    'defense_tower': { hp: 700, size: getBuildingCollisionSize('defense_tower') },
    'naval_academy': { hp: 700, size: getBuildingCollisionSize('naval_academy') },
    'missile_silo': { hp: 1000, size: getBuildingCollisionSize('missile_silo') }
  };
  adminBuildings.forEach((type, i) => {
    const angle = (Math.PI * 2 * i) / adminBuildings.length;
    const dist = 500;
    const bx = baseX + Math.cos(angle) * dist;
    const by = baseY + Math.sin(angle) * dist;
    const cfg = buildingTypes[type];
    const resolvedPos = findNearestValidBuildingPosition(type, bx, by, { size: cfg.size });
    if (!resolvedPos) {
      console.warn(`Admin spawn skipped ${type}: no non-overlapping position near (${bx.toFixed(0)}, ${by.toFixed(0)})`);
      return;
    }
    const bid = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 100 + i;
    gameState.buildings.set(bid, {
      id: bid, userId, type, x: resolvedPos.x, y: resolvedPos.y,
      hp: cfg.hp, maxHp: cfg.hp, buildProgress: 100
    });
  });

  // Spawn one of each unit type near water
  const waterPos = findNearestWaterPosition(baseX, baseY, 2000);
  const spawnX = waterPos ? waterPos.x : baseX;
  const spawnY = waterPos ? waterPos.y : baseY;

  const adminUnits = ['destroyer', 'cruiser', 'battleship', 'carrier', 'submarine', 'frigate'];
  let totalPop = player.population; // already 4 from workers
  adminUnits.forEach((type, i) => {
    const unitConfig = getUnitDefinition(type);
    const angle = (Math.PI * 2 * i) / adminUnits.length;
    const dist = 300;
    const ux = spawnX + Math.cos(angle) * dist;
    const uy = spawnY + Math.sin(angle) * dist;
    const uid = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 200 + i;
    gameState.units.set(uid, {
      id: uid, userId, type,
      x: ux, y: uy,
      hp: unitConfig.hp, maxHp: unitConfig.hp,
      damage: unitConfig.damage, speed: unitConfig.speed,
      attackRange: unitConfig.attackRange, attackCooldownMs: unitConfig.attackCooldownMs,
      targetX: null, targetY: null,
      gatheringResourceId: null, buildingType: null,
      buildTargetX: null, buildTargetY: null,
      kills: 0
    });
    totalPop += unitConfig.pop;
  });

  // Pre-fill carrier with 10 aircraft (ready for airstrike)
  const carrierUnit = [...gameState.units.values()].find(u => u.userId === userId && u.type === 'carrier');
  if (carrierUnit) {
    if (!carrierUnit.aircraft) carrierUnit.aircraft = [];
    const acConfig = getUnitDefinition('aircraft');
    for (let i = 0; i < 10; i++) {
      carrierUnit.aircraft.push({ hp: acConfig.hp });
    }
    carrierUnit.airstrikeReady = true;
  }

  player.population = totalPop;
  console.log(`Admin spawn for JsonParc: ${player.resources} energy, ${player.maxPopulation} pop cap, all buildings+units`);
}

// Check for player defeat (all buildings destroyed)
function checkPlayerDefeat(userId, attackerId = null) {
  let hasBuildings = false;
  gameState.buildings.forEach(building => {
    if (building.userId === userId) {
      hasBuildings = true;
    }
  });
  
  if (!hasBuildings) {
    // Get player and attacker names for kill log
    const defeatedPlayer = gameState.players.get(userId);
    if (!defeatedPlayer) {
      console.warn(`checkPlayerDefeat: player ${userId} missing in room ${currentRoomId}`);
      return;
    }
    const attackerPlayer = attackerId ? gameState.players.get(attackerId) : null;
    const defeatedName = defeatedPlayer ? defeatedPlayer.username : `Player ${userId}`;
    const attackerName = attackerPlayer ? attackerPlayer.username : '알 수 없음';

    if (defeatedPlayer.isAI) {
      roomEmit('playerDefeated', {
        userId,
        respawned: false,
        defeatedName,
        attackerName,
        attackerId: attackerId || null,
        isAI: true,
        respawnDelayMs: AI_CONFIG.respawnDelayMs
      });
      removePlayerFromCurrentRoom(userId, { emitPlayerLeft: true });
      scheduleAIRespawn(userId);
      console.log(`${defeatedName} was defeated by ${attackerName} and will respawn in ${AI_CONFIG.respawnDelayMs}ms`);
      return;
    }

    removePlayerEntities(userId);

    defeatedPlayer.hasBase = false;
    defeatedPlayer.population = 0;
    defeatedPlayer.resources = 1000;
    defeatedPlayer.combatPower = 0;
    defeatedPlayer.score = 0;
    defeatedPlayer.maxPopulation = 10;
    defeatedPlayer.researchedSLBM = false;
    defeatedPlayer.missiles = 0;

    try {
      db.prepare(`UPDATE player_data SET 
        has_base = 0, population = 0, resources = 1000, 
        combat_power = 0, score = 0, max_population = 10,
        researched_slbm = 0, missiles = 0
        WHERE user_id = ?`).run(userId);
    } catch(e) { /* no-op for temp users */ }

    // Respawn base at new location (findStartPosition avoids existing bases)
    spawnPlayerBase(userId);

    // Emit defeat event with kill log info
    roomEmit('playerDefeated', { 
      userId, 
      respawned: true, 
      defeatedName, 
      attackerName,
      attackerId: attackerId || null
    });

    console.log(`${defeatedName} was defeated by ${attackerName} and respawned`);
  }
}

// Socket.io authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.userId;
    socket.username = decoded.username;
    // Room selection from client (default: server1)
    socket.roomId = socket.handshake.auth.roomId || 'server1';
    if (!gameRooms.has(socket.roomId)) {
      socket.roomId = 'server1';
    }
    next();
  } catch (err) {
    next(new Error('Authentication error'));
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  const wasRoomIdle = !roomHasHumanPlayers(socket.roomId);

  // Join the selected room
  socket.join(socket.roomId);
  switchRoom(socket.roomId);
  
  console.log(`Player connected: ${socket.username} (${socket.userId}) to room ${socket.roomId}`);
  
  try {
    // Always fresh start: create player and spawn base
    gameState.players.set(socket.userId, {
      userId: socket.userId,
      username: socket.username,
      resources: 1000,
      population: 0,
      maxPopulation: 10,
      combatPower: 0,
      score: 0,
      baseX: 0,
      baseY: 0,
      hasBase: false,
      researchedSLBM: false,
      missiles: 0,
      online: true
    });
    if (!gameState.fogOfWar.has(socket.userId)) {
      gameState.fogOfWar.set(socket.userId, new Map());
    }

    // Check for admin mode (JsonParc)
    if (socket.username === 'JsonParc') {
      spawnAdminBase(socket.userId);
    } else {
      spawnPlayerBase(socket.userId);
    }

    if (wasRoomIdle) {
      gameState.lastUpdate = Date.now();
      const spawnedAiCount = initializeAIPlayers();
      syncSlbmId();
      console.log(`Room ${socket.roomId} activated by ${socket.username}; spawned ${spawnedAiCount} AI player(s)`);
    }
    
    console.log(`Player ${socket.username} spawned fresh`);
    
    // Send initial game state
    const player = gameState.players.get(socket.userId);
    const initData = {
      userId: socket.userId,
      map: buildClientMapPayload(),
      players: buildClientPlayersPayload(),
      units: buildClientUnitsPayload(),
      buildings: buildClientBuildingsPayload(),
      missiles: player ? (player.missiles || 0) : 0
    };
    
    console.log(`Sending init data: ${initData.players.length} players, ${initData.units.length} units, ${initData.buildings.length} buildings`);
    
    socket.emit('init', initData);
    
    // Notify others in same room
    socket.to(socket.roomId).emit('playerJoined', gameState.players.get(socket.userId));
  } catch (error) {
    console.error('Error during connection:', error);
    socket.disconnect();
    return;
  }
  
  // Handle unit commands
  socket.on('moveUnits', (data) => {
    switchRoom(socket.roomId);
    const { unitIds, targetX, targetY } = data;
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId) {
        if (assignMoveTarget(unit, targetX, targetY)) {
          unit.holdPosition = false;
          unit.attackMove = false;
          unit.attackTargetId = null;
          unit.attackTargetType = null;
        }
      }
    });
  });
  
  socket.on('attackTarget', (data) => {
    switchRoom(socket.roomId);
    const { unitIds, targetId, targetType } = data;
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId) {
        unit.holdPosition = false;
        unit.attackMove = false;
        unit.attackTargetId = targetId;
        unit.attackTargetType = targetType;
      }
    });
  });
  
  socket.on('buildUnit', (data) => {
    switchRoom(socket.roomId);
    const { buildingId, unitType } = data;
    buildUnit(socket.userId, buildingId, unitType);
  });
  
  socket.on('buildBuilding', (data) => {
    switchRoom(socket.roomId);
    const { type, x, y } = data;
    buildBuilding(socket.userId, type, x, y);
  });
  
  socket.on('workerGather', (data) => {
    switchRoom(socket.roomId);
    const { workerId, resourceId } = data;
    const unit = gameState.units.get(workerId);
    const resource = gameState.map.resources.find(r => r.id === resourceId);
    
    if (unit && unit.userId === socket.userId && unit.type === 'worker' && resource) {
      unit.holdPosition = false;
      unit.gatheringResourceId = resourceId;
      unit.targetX = resource.x;
      unit.targetY = resource.y;
      unit.buildingType = null;
      unit.buildTargetX = null;
      unit.buildTargetY = null;
    }
  });
  
  socket.on('workerBuild', (data) => {
    switchRoom(socket.roomId);
    const { workerIds, buildingType, x, y } = data;
    if (!isOnLand(x, y)) {
      return;
    }
    workerIds.forEach(workerId => {
      const unit = gameState.units.get(workerId);
      if (unit && unit.userId === socket.userId && unit.type === 'worker') {
        unit.holdPosition = false;
        unit.buildingType = buildingType;
        unit.buildTargetX = x;
        unit.buildTargetY = y;
        unit.targetX = x;
        unit.targetY = y;
        unit.gatheringResourceId = null;
      }
    });
  });
  
  socket.on('submarineSLBM', (data) => {
    switchRoom(socket.roomId);
    const { submarineId, targetX, targetY } = data;
    const unit = gameState.units.get(submarineId);
    const player = gameState.players.get(socket.userId);
    const clampedTarget = clampToMapBounds(targetX, targetY);
    
    if (unit && unit.userId === socket.userId && unit.type === 'submarine' && player && player.missiles > 0) {
      // Use player's missile
      player.missiles--;
      
      // Fire SLBM - tracked entity
      unit.isDetected = true; // Firing reveals submarine
      const slbmId = nextSlbmId++;
      const slbm = {
        id: slbmId,
        fromX: unit.x, fromY: unit.y,
        targetX: clampedTarget.x, targetY: clampedTarget.y,
        currentX: unit.x, currentY: unit.y,
        startTime: Date.now(),
        flightTime: 5000,
        hp: SLBM_MAX_HP, maxHp: SLBM_MAX_HP,
        userId: socket.userId,
        firingSubId: submarineId,
        damageAccumulator: 0,
        damageWindowStart: Date.now()
      };
      gameState.activeSlbms.set(slbmId, slbm);
      
      roomEmit('slbmFired', {
        id: slbmId,
        fromX: unit.x,
        fromY: unit.y,
        targetX: clampedTarget.x,
        targetY: clampedTarget.y,
        userId: socket.userId
      });
    }
  });
  
  socket.on('researchSLBM', (data) => {
    switchRoom(socket.roomId);
    const { buildingId } = data;
    const building = gameState.buildings.get(buildingId);
    const player = gameState.players.get(socket.userId);
    
    if (
      building &&
      building.userId === socket.userId &&
      (building.type === 'missile_silo' || building.type === 'research_lab') &&
      player &&
      !player.researchedSLBM &&
      building.buildProgress >= 100
    ) {
      player.researchedSLBM = true;
      roomEmit('researchCompleted', { userId: socket.userId, research: 'SLBM' });
    }
  });
  
  // Produce missile (global player missiles) - queue-based
  socket.on('produceMissile', (data) => {
    switchRoom(socket.roomId);
    const { buildingId } = data;
    const building = gameState.buildings.get(buildingId);
    const player = gameState.players.get(socket.userId);
    
    if (building && building.userId === socket.userId && building.type === 'missile_silo' && player) {
      if (building.buildProgress < 100) return;
      if (!building.missileQueue) building.missileQueue = [];
      if (building.missileQueue.length >= 10) return;
      const missileCost = 1500;
      if (player.resources >= missileCost) {
        player.resources -= missileCost;
        building.missileQueue.push({
          type: 'missile',
          buildTime: 45000,
          userId: socket.userId,
          socketId: socket.id
        });
        if (!building.missileProducing) {
          const next = building.missileQueue[0];
          building.missileProducing = {
            type: next.type,
            startTime: Date.now(),
            buildTime: next.buildTime,
            userId: next.userId,
            socketId: next.socketId
          };
        }
      }
    }
  });
  
  // Carrier: produce aircraft (queue-based)
  socket.on('produceAircraft', (data) => {
    switchRoom(socket.roomId);
    const { unitId } = data;
    const carrier = gameState.units.get(unitId);
    const player = gameState.players.get(socket.userId);
    if (!carrier || carrier.userId !== socket.userId || carrier.type !== 'carrier' || !player) return;
    if (!carrier.aircraft) carrier.aircraft = [];
    if (!carrier.aircraftDeployed) carrier.aircraftDeployed = [];
    if (!carrier.aircraftQueue) carrier.aircraftQueue = [];
    const totalAircraft = carrier.aircraft.length + carrier.aircraftDeployed.length + carrier.aircraftQueue.length;
    if (totalAircraft >= 10) return; // Max 10 per carrier
    if (carrier.aircraftQueue.length >= 10) return;
    const acCost = 100;
    if (player.resources >= acCost) {
      player.resources -= acCost;
      carrier.aircraftQueue.push({
        type: 'aircraft',
        buildTime: 15000,
        userId: socket.userId
      });
      if (!carrier.producingAircraft) {
        const next = carrier.aircraftQueue[0];
        carrier.producingAircraft = {
          type: next.type,
          startTime: Date.now(),
          buildTime: next.buildTime,
          userId: next.userId
        };
      }
    }
  });
  
  // Carrier: deploy aircraft
  socket.on('deployAircraft', (data) => {
    switchRoom(socket.roomId);
    const { unitId } = data;
    const carrier = gameState.units.get(unitId);
    if (!carrier || carrier.userId !== socket.userId || carrier.type !== 'carrier') return;
    carrier.deployAircraft = true;
  });
  
  // Battleship: activate aimed shot (16s cooldown)
  socket.on('activateAimedShot', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!unitIds || !Array.isArray(unitIds)) return;
    const now = Date.now();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId && unit.type === 'battleship') {
        // Check cooldown (16 seconds)
        if (unit.aimedShotCooldownUntil && now < unit.aimedShotCooldownUntil) return;
        unit.aimedShot = true;
      }
    });
  });
  
  // Attack move command
  socket.on('attackMove', (data) => {
    switchRoom(socket.roomId);
    const { unitIds, targetX, targetY } = data;
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId) {
        if (assignMoveTarget(unit, targetX, targetY)) {
          unit.holdPosition = false;
          unit.attackMove = true; // Flag for attack-move behavior
        }
      }
    });
  });

  socket.on('holdPosition', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!Array.isArray(unitIds)) return;
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (!unit || unit.userId !== socket.userId) return;
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
  });

  // Cruiser: toggle Aegis mode
  socket.on('toggleAegisMode', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!unitIds || !Array.isArray(unitIds)) return;
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId && unit.type === 'cruiser') {
        unit.aegisMode = !unit.aegisMode;
        // Clear current attack target when toggling modes
        unit.attackTargetId = null;
        unit.attackTargetType = null;
      }
    });
  });

  // Destroyer: activate search (extends vision to a wide pulse for a short duration, 16s cooldown)
  socket.on('activateSearch', (data) => {
    switchRoom(socket.roomId);
    const { unitIds } = data;
    if (!unitIds || !Array.isArray(unitIds)) return;
    const now = Date.now();
    unitIds.forEach(unitId => {
      const unit = gameState.units.get(unitId);
      if (unit && unit.userId === socket.userId && unit.type === 'destroyer') {
        if (unit.searchCooldownUntil && now < unit.searchCooldownUntil) return;
        unit.searchCooldownUntil = now + 16000;
        unit.searchActiveUntil = now + SEARCH_REVEAL_DURATION_MS;
        const vr = DESTROYER_SEARCH_VISION_RADIUS;
        if (!gameState.fogOfWar.has(unit.userId)) {
          gameState.fogOfWar.set(unit.userId, new Map());
        }
        revealFogCircleForPlayer(gameState.fogOfWar.get(unit.userId), unit.x, unit.y, vr, now);
        roomEmit('searchActivated', { unitId: unit.id, x: unit.x, y: unit.y, radius: vr });
      }
    });
  });

  // Destroyer: lay mine at target location
  socket.on('layMine', (data) => {
    switchRoom(socket.roomId);
    const { unitId, targetX, targetY } = data;
    const unit = gameState.units.get(unitId);
    if (!unit || unit.userId !== socket.userId || unit.type !== 'destroyer') return;
    const clamped = clampToMapBounds(targetX, targetY);
    if (isOnLand(clamped.x, clamped.y)) return;
    const destroyerVisionRadius = unit.visionRadius || UNIT_DEFINITIONS.destroyer.visionRadius;
    const dx = clamped.x - unit.x;
    const dy = clamped.y - unit.y;
    if ((dx * dx) + (dy * dy) > destroyerVisionRadius * destroyerVisionRadius) return;
    let activeMineCount = 0;
    gameState.units.forEach(other => {
      if (other.type === 'mine' && other.userId === unit.userId && other.hp > 0 && (other.sourceDestroyerId == null || other.sourceDestroyerId === unit.id)) {
        activeMineCount++;
      }
    });
    if (activeMineCount >= DESTROYER_MAX_MINES) return;
    const mineId = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 500;
    const mineDef = getUnitDefinition('mine');
    const mine = {
      id: mineId,
      userId: unit.userId,
      type: 'mine',
      x: clamped.x,
      y: clamped.y,
      hp: mineDef.hp,
      maxHp: mineDef.hp,
      damage: mineDef.damage,
      speed: 0,
      size: mineDef.size,
      attackRange: mineDef.attackRange,
      attackCooldownMs: mineDef.attackCooldownMs,
      visionRadius: 0,
      targetX: null,
      targetY: null,
      isDetected: false, // Mines are hidden by default
      sourceDestroyerId: unit.id,
      kills: 0
    };
    gameState.units.set(mineId, mine);
    roomEmit('unitCreated', mine);
  });

  // Carrier: launch airstrike (requires 10 aircraft, consumes all, 20s cooldown after refill)
  socket.on('launchAirstrike', (data) => {
    switchRoom(socket.roomId);
    const { unitId, targetX, targetY } = data;
    const carrier = gameState.units.get(unitId);
    if (!carrier || carrier.userId !== socket.userId || carrier.type !== 'carrier') return;
    const isAdmin = socket.username === 'JsonParc';
    const acCount = (carrier.aircraft || []).length;
    if (!isAdmin && acCount < 10) return;
    const now = Date.now();
    if (!isAdmin && carrier.airstrikeCooldownUntil && now < carrier.airstrikeCooldownUntil) return;
    
    // Consume all aircraft (admin keeps them)
    if (!isAdmin) {
      carrier.aircraft = [];
      carrier.airstrikeReady = false;
      carrier.pendingAirstrikeCooldown = true;
      carrier.airstrikeCooldownUntil = null;
    }
    
    const clamped = clampToMapBounds(targetX, targetY);
    const airstrikeSpeed = 6000; // 2x battleship projectile speed (3000)
    const baseAngle = Math.atan2(clamped.y - carrier.y, clamped.x - carrier.x);
    const mapW = gameState.map ? gameState.map.width : 20000;
    const mapH = gameState.map ? gameState.map.height : 20000;
    const margin = 500;
    if (!gameState.activeAirstrikes) gameState.activeAirstrikes = new Map();

    // Helper: compute entry→exit flight through target along a given angle
    function createAirstrikeEntry(entryX, entryY, angle, delayMs, passNumber) {
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      // Exit point: extend past target along flight angle to map edge + margin
      let maxT = 99999;
      if (cosA > 0.001) maxT = Math.min(maxT, (mapW + margin - entryX) / cosA);
      else if (cosA < -0.001) maxT = Math.min(maxT, (-margin - entryX) / cosA);
      if (sinA > 0.001) maxT = Math.min(maxT, (mapH + margin - entryY) / sinA);
      else if (sinA < -0.001) maxT = Math.min(maxT, (-margin - entryY) / sinA);
      maxT = Math.max(maxT, 500);
      const exitX = entryX + cosA * maxT;
      const exitY = entryY + sinA * maxT;
      const totalDist = Math.sqrt((exitX - entryX) ** 2 + (exitY - entryY) ** 2);
      const targetDist = Math.sqrt((clamped.x - entryX) ** 2 + (clamped.y - entryY) ** 2);
      const targetProgress = targetDist / totalDist;
      const flightTimeMs = Math.max(300, Math.round((totalDist / airstrikeSpeed) * 1000));
      const impactTime = now + delayMs + Math.round(flightTimeMs * targetProgress);

      const id = nextAirstrikeId++;
      const strike = {
        id, userId: carrier.userId, carrierId: unitId,
        fromX: entryX, fromY: entryY,
        exitX, exitY,
        targetX: clamped.x, targetY: clamped.y,
        targetProgress,
        currentX: entryX, currentY: entryY,
        startTime: now + delayMs,
        impactTime,
        flightTime: flightTimeMs,
        passNumber,
        damageApplied: false,
        damageRadius: AIRSTRIKE_DAMAGE_RADIUS,
        damagePerPass: AIRSTRIKE_DAMAGE_PER_PASS,
        visualRadius: AIRSTRIKE_VISUAL_RADIUS,
        explosionsPerPass: 30
      };
      gameState.activeAirstrikes.set(id, strike);
      roomEmit('airstrikeLaunched', {
        id, fromX: entryX, fromY: entryY,
        exitX, exitY,
        targetX: clamped.x, targetY: clamped.y,
        targetProgress,
        userId: carrier.userId,
        flightTime: flightTimeMs,
        startDelay: delayMs
      });
    }

    // Strike 1: from carrier direction
    createAirstrikeEntry(carrier.x, carrier.y, baseAngle, 0, 1);

    // Remaining passes: delayed follow-up flights from random directions
    for (let p = 1; p < AIRSTRIKE_PASS_COUNT; p++) {
      const randAngle = baseAngle + (Math.random() * Math.PI * 1.2 + Math.PI * 0.4) * (Math.random() < 0.5 ? 1 : -1);
      const entryDist = 1500 + Math.random() * 1000;
      const entryX = clamped.x - Math.cos(randAngle) * entryDist;
      const entryY = clamped.y - Math.sin(randAngle) * entryDist;
      createAirstrikeEntry(entryX, entryY, randAngle, p * AIRSTRIKE_PASS_INTERVAL_MS, p + 1);
    }
  });
  
  socket.on('resetAllAiFactions', () => {
    switchRoom(socket.roomId);
    resetAllAiFactionsInCurrentRoom();
  });

  socket.on('disconnect', () => {
    switchRoom(socket.roomId);
    console.log(`Player disconnected: ${socket.username}`);
    try {
      removePlayerFromCurrentRoom(socket.userId, { emitPlayerLeft: true });
      if (!roomHasHumanPlayers(socket.roomId)) {
        const removedAiCount = removeAllAiFactionsFromCurrentRoom();
        clearCurrentRoomTransientState();
        gameState.lastUpdate = Date.now();
        syncSlbmId();
        console.log(`Room ${socket.roomId} is now idle; stopped simulation and removed ${removedAiCount} AI player(s)`);
      }
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  });
  
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Load player data from database
function loadPlayerData(userId) {
  try {
    const playerData = db.prepare('SELECT * FROM player_data WHERE user_id = ?').get(userId);
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    
    console.log(`Loading data for user ${userId}:`, playerData ? 'found' : 'not found');
    
    if (playerData && user) {
      gameState.players.set(userId, {
        userId: userId,
        username: user.username,
        resources: playerData.resources,
        population: playerData.population,
        maxPopulation: playerData.max_population,
        combatPower: playerData.combat_power,
        score: playerData.score,
        baseX: playerData.base_x,
        baseY: playerData.base_y,
        hasBase: playerData.has_base === 1,
        researchedSLBM: playerData.researched_slbm === 1,
        missiles: playerData.missiles || 0,
        online: true
      });
      
      // If player doesn't have a base, spawn one
      if (playerData.has_base === 0) {
        spawnPlayerBase(userId);
      }
    } else {
      console.error(`No data found for user ${userId}`);
    }
    
    // Initialize fog of war for player
    if (!gameState.fogOfWar.has(userId)) {
      gameState.fogOfWar.set(userId, new Map());
    }
    
    // Load units
    const units = db.prepare('SELECT * FROM units WHERE user_id = ?').all(userId);
    console.log(`Loaded ${units.length} units for user ${userId}`);

    units.forEach(unit => {
      const unitConfig = getUnitDefinition(unit.type);

      // Validate/sanitize positions against the current map.
      let unitX = unit.x;
      let unitY = unit.y;
      if (!isWithinMapBounds(unitX, unitY)) {
        const clamped = clampToMapBounds(unitX, unitY);
        unitX = clamped.x;
        unitY = clamped.y;
      }

      // Ships should always be on water.
      if (isNavalUnitType(unit.type) && isOnLand(unitX, unitY)) {
        const waterPos = findNearestWaterPosition(unitX, unitY);
        if (waterPos) {
          unitX = waterPos.x;
          unitY = waterPos.y;
          console.log(`Relocating naval unit ${unit.id} from land to water (${unitX}, ${unitY})`);
        } else {
          const fallback = clampToMapBounds(unitX, unitY);
          unitX = fallback.x;
          unitY = fallback.y;
        }
      }
      
      const hydratedUnit = {
        id: unit.id,
        userId: unit.user_id,
        type: unit.type,
        x: unitX,
        y: unitY,
        hp: unit.hp,
        maxHp: unit.max_hp,
        targetX: unit.target_x,
        targetY: unit.target_y,
        speed: unitConfig.speed,
        damage: unitConfig.damage,
        attackRange: unitConfig.attackRange,
        attackCooldownMs: unitConfig.attackCooldownMs,
        gatheringResourceId: unit.gathering_resource_id,
        buildingType: unit.building_type,
        buildTargetX: unit.build_target_x,
        buildTargetY: unit.build_target_y,
        sourceDestroyerId: unit.source_destroyer_id,
        isDetected: unit.is_detected === 1,
        kills: unit.kills || 0
      };

      if (hydratedUnit.targetX !== null && hydratedUnit.targetY !== null) {
        assignMoveTarget(hydratedUnit, hydratedUnit.targetX, hydratedUnit.targetY);
      }

      gameState.units.set(unit.id, hydratedUnit);
    });
    
    // Load buildings
    const buildings = db.prepare('SELECT * FROM buildings WHERE user_id = ?').all(userId);
    console.log(`Loaded ${buildings.length} buildings for user ${userId}`);
    
    // Calculate population bonus from completed buildings
    const populationBonuses = {
      'naval_academy': 10,
      'shipyard': 5,
      'power_plant': 3
    };
    let totalPopBonus = 0;
    let headquartersPos = null;
    let hasCompletedSilo = false;
    
    const sortedBuildings = [...buildings].sort((a, b) => {
      const aPriority = a.type === 'headquarters' ? 0 : 1;
      const bPriority = b.type === 'headquarters' ? 0 : 1;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return (b.build_progress || 0) - (a.build_progress || 0);
    });

    sortedBuildings.forEach(building => {
      const normalizedType = building.type === 'research_lab' ? 'missile_silo' : building.type;
      const isComplete = building.build_progress >= 100;
      const targetMaxHp = normalizedType === 'missile_silo' ? 1000 : building.max_hp;
      const hpRatio = building.max_hp > 0 ? (building.hp / building.max_hp) : 1;
      const targetHp = Math.max(1, Math.round(targetMaxHp * Math.max(0, Math.min(1, hpRatio))));
      
      // Validate building position - buildings should be on land
      let buildingX = building.x;
      let buildingY = building.y;
      if (!isOnLand(building.x, building.y)) {
        const landPos = findNearestLandPosition(building.x, building.y);
        buildingX = landPos.x;
        buildingY = landPos.y;
        console.log(`Relocating building ${building.id} from water to land (${buildingX}, ${buildingY})`);
      }

      const resolvedBuildingPos = findNearestValidBuildingPosition(normalizedType, buildingX, buildingY, {
        ignoreBuildingId: building.id
      });
      if (resolvedBuildingPos) {
        if (resolvedBuildingPos.x !== buildingX || resolvedBuildingPos.y !== buildingY) {
          console.log(`Relocating building ${building.id} to avoid overlap (${buildingX}, ${buildingY}) -> (${resolvedBuildingPos.x}, ${resolvedBuildingPos.y})`);
        }
        buildingX = resolvedBuildingPos.x;
        buildingY = resolvedBuildingPos.y;
      }
      
      gameState.buildings.set(building.id, {
        id: building.id,
        userId: building.user_id,
        type: normalizedType,
        x: buildingX,
        y: buildingY,
        hp: targetHp,
        maxHp: targetMaxHp,
        buildProgress: building.build_progress,
        slbmCount: building.slbm_count || 0,
        populationBonusApplied: isComplete // Mark as applied if already complete
      });
      
      // Track headquarters position
      if (normalizedType === 'headquarters') {
        headquartersPos = { x: buildingX, y: buildingY };
      }
      
      // Add population bonus for completed buildings
      if (isComplete && populationBonuses[normalizedType]) {
        totalPopBonus += populationBonuses[normalizedType];
      }
      if (isComplete && normalizedType === 'missile_silo') {
        hasCompletedSilo = true;
      }
    });
    
    // Apply total population bonus to player and fix baseX/baseY
    const player = gameState.players.get(userId);
    if (player) {
      // Start with base 10 + bonuses from buildings
      player.maxPopulation = 10 + totalPopBonus;
      if (hasCompletedSilo) player.researchedSLBM = true;
      console.log(`Player ${userId} maxPopulation set to ${player.maxPopulation}`);
      
      // Update baseX/baseY to headquarters position if available
      if (headquartersPos) {
        player.baseX = headquartersPos.x;
        player.baseY = headquartersPos.y;
        db.prepare('UPDATE player_data SET base_x = ?, base_y = ? WHERE user_id = ?')
          .run(headquartersPos.x, headquartersPos.y, userId);
      }
    }
  } catch (error) {
    console.error('Error loading player data:', error);
    throw error;
  }
}

// Save player data to database
function savePlayerData(userId) {
  const player = gameState.players.get(userId);
  if (!player) return;
  
  db.prepare(`UPDATE player_data SET 
    resources = ?, population = ?, max_population = ?, 
    combat_power = ?, score = ?, has_base = ?, researched_slbm = ?, 
    missiles = ?, last_active = CURRENT_TIMESTAMP 
    WHERE user_id = ?`).run(
    player.resources, player.population, player.maxPopulation,
    player.combatPower, player.score, player.hasBase ? 1 : 0, 
    player.researchedSLBM ? 1 : 0, player.missiles || 0, userId
  );
  
  // Save units
  db.prepare('DELETE FROM units WHERE user_id = ?').run(userId);
  const unitInsert = db.prepare(`INSERT INTO units 
    (id, user_id, type, x, y, hp, max_hp, target_x, target_y, 
     gathering_resource_id, building_type, build_target_x, build_target_y, source_destroyer_id, is_detected, kills) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`); 
  gameState.units.forEach(unit => {
    if (unit.userId === userId) {
      unitInsert.run(unit.id, unit.userId, unit.type, unit.x, unit.y, unit.hp, unit.maxHp, 
        unit.targetX, unit.targetY, unit.gatheringResourceId, unit.buildingType, 
        unit.buildTargetX, unit.buildTargetY, unit.sourceDestroyerId ?? null, unit.isDetected ? 1 : 0, unit.kills || 0);
    }
  });

  db.prepare('DELETE FROM buildings WHERE user_id = ?').run(userId);
  const buildingInsert = db.prepare(`INSERT INTO buildings 
    (id, user_id, type, x, y, hp, max_hp, build_progress, slbm_count) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  gameState.buildings.forEach(building => {
    if (building.userId === userId) {
      buildingInsert.run(building.id, building.userId, building.type, building.x, building.y, 
        building.hp, building.maxHp, building.buildProgress, building.slbmCount || 0);
    }
  });
}

// Build unit
function buildUnit(userId, buildingId, unitType) {
  const building = gameState.buildings.get(buildingId);
  const player = gameState.players.get(userId);
  
  if (!building || building.userId !== userId || !player) return;
  if (!Object.prototype.hasOwnProperty.call(UNIT_DEFINITIONS, unitType)) return;
  if (unitType === 'aircraft') return; // Aircraft can't be built directly
  
  const unitConfig = getUnitDefinition(unitType);
  
  // Check building type restrictions
  if (unitType === 'worker' && building.type !== 'headquarters') return;
  if (['destroyer', 'cruiser', 'frigate'].includes(unitType) && building.type !== 'shipyard') return;
  if (['battleship', 'carrier', 'submarine'].includes(unitType) && building.type !== 'naval_academy') return;
  
  // Building must be complete
  if (building.buildProgress < 100) return;
  
  // Initialize production queue if needed
  if (!building.productionQueue) building.productionQueue = [];
  
  // Max 10 items in queue
  if (building.productionQueue.length >= 10) return;
  
  if (player.resources >= unitConfig.cost && player.population + unitConfig.pop <= player.maxPopulation) {
    player.resources -= unitConfig.cost;
    player.population += unitConfig.pop;
    
    // Add to production queue
    building.productionQueue.push({
      unitType: unitType,
      buildTime: unitConfig.buildTime || 10000,
      userId: userId
    });
    
    // If nothing currently producing, start it
    if (!building.producing) {
      const next = building.productionQueue[0];
      building.producing = {
        unitType: next.unitType,
        startTime: Date.now(),
        buildTime: next.buildTime,
        userId: next.userId
      };
    }
  }
}

// Build building
function buildBuilding(userId, type, x, y) {
  const player = gameState.players.get(userId);
  if (!player) return;
  
  const buildingTypes = {
    'headquarters': { cost: 0, hp: 1500, size: getBuildingCollisionSize('headquarters') },
    'shipyard': { cost: 200, hp: 800, size: getBuildingCollisionSize('shipyard'), popBonus: 5 },
    'power_plant': { cost: 150, hp: 600, size: getBuildingCollisionSize('power_plant'), popBonus: 3 },
    'defense_tower': { cost: 250, hp: 700, size: getBuildingCollisionSize('defense_tower') },
    'naval_academy': { cost: 300, hp: 700, size: getBuildingCollisionSize('naval_academy'), popBonus: 10 },
    'missile_silo': { cost: MISSILE_SILO_COST, hp: 1000, size: getBuildingCollisionSize('missile_silo') }
  };
  
  const buildingConfig = buildingTypes[type];
  if (!buildingConfig) return;

  const clampedBuildPos = clampToMapBounds(x, y);
  x = clampedBuildPos.x;
  y = clampedBuildPos.y;

  // Check if a worker is nearby (within 500 units)
  let workerNearby = false;
  gameState.units.forEach(unit => {
    if (unit.userId === userId && unit.type === 'worker') {
      const dx = unit.x - x;
      const dy = unit.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < 500) {
        workerNearby = true;
      }
    }
  });
  
  if (!workerNearby && type !== 'headquarters') {
    return; // Workers must be nearby to build
  }
  
  if (!isBuildingPlacementValid(type, x, y, { size: buildingConfig.size })) {
    return;
  }
  
  // No additional tech prerequisite for missile silo.
  
  if (player.resources >= buildingConfig.cost) {
    player.resources -= buildingConfig.cost;
    
    const buildingId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
    gameState.buildings.set(buildingId, {
      id: buildingId,
      userId: userId,
      type: type,
      x: x,
      y: y,
      hp: buildingConfig.hp,
      maxHp: buildingConfig.hp,
      buildProgress: 0,
      slbmCount: 0
    });
    
    roomEmit('buildingCreated', gameState.buildings.get(buildingId));
  }
}

// Game loop - iterates all rooms
setInterval(() => {
  const now = Date.now();
  gameRooms.forEach((room, roomId) => {
    if (!roomHasHumanPlayers(roomId)) {
      room.lastUpdate = now;
      return;
    }
    switchRoom(roomId);
    const deltaTime = (now - gameState.lastUpdate) / 1000;
    gameState.lastUpdate = now;
    updateGame(deltaTime);
    syncSlbmId();
  });
}, 1000 / GAME_TICK_RATE);

// Separate fog of war update (less frequent) - all rooms
setInterval(() => {
  gameRooms.forEach((room, roomId) => {
    if (!roomHasHumanPlayers(roomId)) return;
    switchRoom(roomId);
    updateFogOfWar();
  });
}, 2000);

// Broadcast game state updates (optimized) - per room
let updateCounter = 0;
setInterval(() => {
  updateCounter++;
  gameRooms.forEach((room, roomId) => {
    if (!roomHasHumanPlayers(roomId)) return;

    switchRoom(roomId);
    const entityCount = gameState.units.size + gameState.buildings.size;
    let stride = 1;
    if (entityCount > 800) stride = 3;
    else if (entityCount > 350) stride = 2;

    if (updateCounter % stride !== 0) return;

    io.to(roomId).emit('gameUpdate', {
      players: buildClientPlayersPayload(),
      units: buildClientUnitsPayload(),
      buildings: buildClientBuildingsPayload()
    });
  });
}, NETWORK_UPDATE_BASE_MS);

// Separate fog of war update function
function updateFogOfWar() {
  const now = Date.now();
  
  gameState.players.forEach((player, playerId) => {
    if (!gameState.fogOfWar.has(playerId)) {
      gameState.fogOfWar.set(playerId, new Map());
    }
    const playerFog = gameState.fogOfWar.get(playerId);
    
    // Reveal fog based on unit positions
      gameState.units.forEach(unit => {
        if (unit.userId === playerId) {
          const unitDef = getUnitDefinition(unit.type);
          let visionRadius = unitDef.visionRadius || mapConfig.vision.unitVisionRadius;
          // Battleship aimed shot doubles vision
          if (unit.type === 'battleship' && unit.aimedShot) {
            visionRadius *= 2;
          }
          if (unit.type === 'destroyer' && unit.searchActiveUntil && now < unit.searchActiveUntil) {
            visionRadius = Math.max(visionRadius, DESTROYER_SEARCH_VISION_RADIUS);
          }
          const cellSize = gameState.map.cellSize || 50;
          const gridX = Math.floor(unit.x / cellSize);
          const gridY = Math.floor(unit.y / cellSize);
          const gridRadius = Math.ceil(visionRadius / cellSize);
        
        for (let dx = -gridRadius; dx <= gridRadius; dx++) {
          for (let dy = -gridRadius; dy <= gridRadius; dy++) {
            if (dx * dx + dy * dy <= gridRadius * gridRadius) {
              const key = `${gridX + dx}_${gridY + dy}`;
              playerFog.set(key, { lastSeen: now, explored: true });
            }
          }
        }
      }
    });
    
    // Reveal fog based on building positions
    gameState.buildings.forEach(building => {
      if (building.userId === playerId && building.buildProgress >= 100) {
        const visionRadius = mapConfig.vision.buildingVisionRadius;
        const cellSize = gameState.map.cellSize || 50;
        const gridX = Math.floor(building.x / cellSize);
        const gridY = Math.floor(building.y / cellSize);
        const gridRadius = Math.ceil(visionRadius / cellSize);
        
        for (let dx = -gridRadius; dx <= gridRadius; dx++) {
          for (let dy = -gridRadius; dy <= gridRadius; dy++) {
            if (dx * dx + dy * dy <= gridRadius * gridRadius) {
              const key = `${gridX + dx}_${gridY + dy}`;
              playerFog.set(key, { lastSeen: now, explored: true });
            }
          }
        }
      }
    });

    gameState.units.forEach(unit => {
      if ((unit.type === 'submarine' || unit.type === 'mine') && unit.isDetected && unit.searchRevealedUntil && now < unit.searchRevealedUntil) {
        revealFogCircleForPlayer(playerFog, unit.x, unit.y, Math.max(250, getUnitAreaHitRadius(unit) + 40), now);
      }
    });
    
    // Reveal fog around active SLBMs for ALL players
    gameState.activeSlbms.forEach(slbm => {
      if (!slbm.currentX || !slbm.currentY) return;
      const slbmVisionRadius = 2000;
      const cellSize = gameState.map.cellSize || 50;
      const gridX = Math.floor(slbm.currentX / cellSize);
      const gridY = Math.floor(slbm.currentY / cellSize);
      const gridRadius = Math.ceil(slbmVisionRadius / cellSize);
      
      for (let dx = -gridRadius; dx <= gridRadius; dx++) {
        for (let dy = -gridRadius; dy <= gridRadius; dy++) {
          if (dx * dx + dy * dy <= gridRadius * gridRadius) {
            const key = `${gridX + dx}_${gridY + dy}`;
            playerFog.set(key, { lastSeen: now, explored: true });
          }
        }
      }
    });
  });
}

// Apply SLBM impact damage
function applySlbmDamage(slbm) {
  const damageRadius = 800;
  const firingPlayer = gameState.players.get(slbm.userId);
  const firingSub = gameState.units.get(slbm.firingSubId);
  
  gameState.units.forEach(target => {
    const dx = target.x - slbm.targetX;
    const dy = target.y - slbm.targetY;
    if (Math.sqrt(dx * dx + dy * dy) <= damageRadius) {
      target.hp = Math.max(0, target.hp - 500);
      if (target.hp <= 0) {
        const targetOwner = gameState.players.get(target.userId);
        if (targetOwner) {
          const popCost = getUnitDefinition(target.type).pop;
          targetOwner.population = Math.max(0, targetOwner.population - popCost);
        }
        if (isNavalUnitType(target.type)) {
          roomEmit('unitDestroyed', { id: target.id, x: target.x, y: target.y, type: target.type });
        }
        if (firingSub) firingSub.kills = (firingSub.kills || 0) + 1;
        if (firingPlayer) firingPlayer.combatPower += 10;
        gameState.units.delete(target.id);
      }
    }
  });
  
  gameState.buildings.forEach(target => {
    const dx = target.x - slbm.targetX;
    const dy = target.y - slbm.targetY;
    if (Math.sqrt(dx * dx + dy * dy) <= damageRadius) {
      target.hp = Math.max(0, target.hp - 800);
      if (target.hp <= 0) {
        roomEmit('buildingDestroyed', { id: target.id, x: target.x, y: target.y, type: target.type });
        if (firingPlayer) firingPlayer.combatPower += 20;
        gameState.buildings.delete(target.id);
        checkPlayerDefeat(target.userId, slbm.userId);
      }
    }
  });
}

function updateGame(deltaTime) {
  const now = Date.now();
  
  // Update units
  gameState.units.forEach((unit, unitId) => {
    if (isNavalUnitType(unit.type) && isOnLand(unit.x, unit.y)) {
      const waterPos = findNearestWaterPosition(unit.x, unit.y);
      if (waterPos) {
        unit.x = waterPos.x;
        unit.y = waterPos.y;
      }
    }

    // HP Regeneration: heal if not damaged recently
    if (unit.hp < unit.maxHp) {
      const timeSinceLastDamage = unit.lastDamageTime ? (now - unit.lastDamageTime) : Infinity;
      if (timeSinceLastDamage >= HP_REGEN_CONFIG.delayMs) {
        // Check if it's time to regen
        const lastRegenTime = unit.lastRegenTime || 0;
        if (now - lastRegenTime >= HP_REGEN_CONFIG.regenIntervalMs) {
          unit.lastRegenTime = now;
          unit.hp = Math.min(unit.maxHp, unit.hp + HP_REGEN_CONFIG.regenPerSecond);
        }
      }
    }

    // Movement
    if (unit.targetX !== null && unit.targetY !== null) {
      const dx = unit.targetX - unit.x;
      const dy = unit.targetY - unit.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance > 5) {
        const moveStep = Math.min(distance, unit.speed * deltaTime * 60);
        const nextX = unit.x + ((dx / distance) * moveStep);
        const nextY = unit.y + ((dy / distance) * moveStep);
        const clampedNext = clampToMapBounds(nextX, nextY);

        if (unit.type === 'worker' || unit.type === 'aircraft') {
          // Workers and aircraft can fly over any terrain
          unit.x = clampedNext.x;
          unit.y = clampedNext.y;
        } else {
          // Ships are restricted to water cells.
          if (!isOnLand(clampedNext.x, clampedNext.y)) {
            unit.x = clampedNext.x;
            unit.y = clampedNext.y;
          } else {
            const slideX = clampToMapBounds(clampedNext.x, unit.y);
            const slideY = clampToMapBounds(unit.x, clampedNext.y);
            const canSlideX = !isOnLand(slideX.x, slideX.y);
            const canSlideY = !isOnLand(slideY.x, slideY.y);

            if (canSlideX && canSlideY) {
              const targetDx = unit.targetX - unit.x;
              const targetDy = unit.targetY - unit.y;
              if (Math.abs(targetDx) >= Math.abs(targetDy)) {
                unit.x = slideX.x;
                unit.y = slideX.y;
              } else {
                unit.x = slideY.x;
                unit.y = slideY.y;
              }
            } else if (canSlideX) {
              unit.x = slideX.x;
              unit.y = slideX.y;
            } else if (canSlideY) {
              unit.x = slideY.x;
              unit.y = slideY.y;
            } else {
              // Completely stuck - try to re-route with A* from current position
              const finalTarget = (unit.pathWaypoints && unit.pathWaypoints.length > 0)
                ? unit.pathWaypoints[unit.pathWaypoints.length - 1]
                : { x: unit.targetX, y: unit.targetY };
              
              const repath = findPath(unit.x, unit.y, finalTarget.x, finalTarget.y, 'ship');
              if (repath && repath.length > 1) {
                unit.pathWaypoints = repath.slice(1);
                const next = unit.pathWaypoints.shift();
                unit.targetX = next.x;
                unit.targetY = next.y;
                if (unit.pathWaypoints.length === 0) unit.pathWaypoints = null;
              } else {
                // Truly unreachable, stop
                unit.targetX = null;
                unit.targetY = null;
                unit.pathWaypoints = null;
              }
            }
          }
        }
      } else {
        // Arrived at current waypoint target
        // For ships, snap to target only if it's on water
        if (isNavalUnitType(unit.type) && isOnLand(unit.targetX, unit.targetY)) {
          // Don't move to a land waypoint, skip it
        } else {
          unit.x = unit.targetX;
          unit.y = unit.targetY;
        }
        unit.targetX = null;
        unit.targetY = null;
        
        // Follow waypoints if available
        if (unit.pathWaypoints && unit.pathWaypoints.length > 0) {
          const next = unit.pathWaypoints.shift();
          // For ships, skip land waypoints
          if (isNavalUnitType(unit.type) && isOnLand(next.x, next.y)) {
            // Re-route to final destination
            const finalTarget = (unit.pathWaypoints.length > 0)
              ? unit.pathWaypoints[unit.pathWaypoints.length - 1]
              : next;
            const repath = findPath(unit.x, unit.y, finalTarget.x, finalTarget.y, 'ship');
            if (repath && repath.length > 1) {
              unit.pathWaypoints = repath.slice(1);
              const wp = unit.pathWaypoints.shift();
              unit.targetX = wp.x;
              unit.targetY = wp.y;
              if (unit.pathWaypoints.length === 0) unit.pathWaypoints = null;
            } else {
              unit.pathWaypoints = null;
            }
          } else {
            unit.targetX = next.x;
            unit.targetY = next.y;
          }
          if (unit.pathWaypoints && unit.pathWaypoints.length === 0) {
            unit.pathWaypoints = null;
          }
        } else {
          unit.pathWaypoints = null;
        }
        
        // Worker reached final destination (no more waypoints)
        if (unit.type === 'worker' && unit.targetX === null) {
          // Check if gathering resource
          if (unit.gatheringResourceId) {
            const resource = gameState.map.resources.find(r => r.id === unit.gatheringResourceId);
            if (resource && resource.amount > 0) {
              const gatherAmount = Math.min(10, resource.amount);
              resource.amount -= gatherAmount;
              const player = gameState.players.get(unit.userId);
              if (player) {
                player.resources += gatherAmount;
              }
              // Return to gather more (simplified)
              if (resource.amount > 0) {
                unit.targetX = resource.x;
                unit.targetY = resource.y;
              } else {
                unit.gatheringResourceId = null;
              }
            }
          }
          
          // Check if building
          if (unit.buildingType && unit.buildTargetX !== null && unit.buildTargetY !== null) {
            const player = gameState.players.get(unit.userId);
            if (player) {
              // Check if there's already a building being constructed here
              let existingConstruction = null;
              gameState.buildings.forEach(b => {
                const dx = b.x - unit.buildTargetX;
                const dy = b.y - unit.buildTargetY;
                if (Math.sqrt(dx * dx + dy * dy) < 50 && b.buildProgress < 100) {
                  existingConstruction = b;
                }
              });
              
              if (!existingConstruction) {
                // Start new building construction
                buildBuilding(unit.userId, unit.buildingType, unit.buildTargetX, unit.buildTargetY);
                unit.buildingType = null;
                unit.buildTargetX = null;
                unit.buildTargetY = null;
              } else {
                // Help construct existing building
                existingConstruction.buildProgress += deltaTime * 5;
                if (existingConstruction.buildProgress >= 100) {
                  existingConstruction.buildProgress = 100;
                  unit.buildingType = null;
                  unit.buildTargetX = null;
                  unit.buildTargetY = null;
                }
              }
            }
          }
        }
      }
    }
    
  });
  
  // Update buildings construction
  gameState.buildings.forEach(building => {
    if (building.buildProgress < 100) {
      const prevProgress = building.buildProgress;
      building.buildProgress += deltaTime * 10;
      if (building.buildProgress >= 100) {
        building.buildProgress = 100;
        
        // Increase population limit when certain buildings are completed
        const player = gameState.players.get(building.userId);
        if (player && !building.populationBonusApplied) {
          const populationBonuses = {
            'naval_academy': 10,
            'shipyard': 5,
            'power_plant': 3
          };
          const bonus = populationBonuses[building.type] || 0;
          if (bonus > 0) {
            player.maxPopulation += bonus;
            building.populationBonusApplied = true;
          }
          if (building.type === 'missile_silo' && !player.researchedSLBM) {
            player.researchedSLBM = true;
            roomEmit('researchCompleted', { userId: building.userId, research: 'SLBM' });
          }
        }
      }
    }
  });
  
  // Energy generation from power plants (every 10 seconds, 10x the per-second amount = 50 energy)
  gameState.buildings.forEach(building => {
    if (building.type === 'power_plant' && building.buildProgress >= 100) {
      if (!building.lastEnergyTime) building.lastEnergyTime = now;
      if (now - building.lastEnergyTime >= 10000) {
        const player = gameState.players.get(building.userId);
        if (player) {
          player.resources += 50; // 5 per second * 10 seconds
        }
        building.lastEnergyTime = now;
      }
    }
  });
  
  gameState.players.forEach(player => {
    // Update score
    player.score = calculatePlayerScore(player);
  });
  
  // Process building production queues
  gameState.buildings.forEach(building => {
    if (building.producing) {
      const elapsed = now - building.producing.startTime;
      if (elapsed >= building.producing.buildTime) {
        // Production complete - spawn unit
        const unitType = building.producing.unitType;
        const unitConfig = getUnitDefinition(unitType);
        const userId = building.producing.userId;
        
        let spawnPoint = clampToMapBounds(building.x + 50, building.y + 50);
        if (isNavalUnitType(unitType)) {
          const nearestWater = findNearestWaterPosition(building.x, building.y);
          if (!nearestWater) {
            const player = gameState.players.get(userId);
            if (player) {
              player.resources += unitConfig.cost;
              player.population -= unitConfig.pop;
            }
            building.producing = null;
            if (building.productionQueue) building.productionQueue.shift();
            // Start next in queue
            if (building.productionQueue && building.productionQueue.length > 0) {
              const next = building.productionQueue[0];
              building.producing = { unitType: next.unitType, startTime: Date.now(), buildTime: next.buildTime, userId: next.userId };
            }
            return;
          }
          spawnPoint = nearestWater;
        }
        
        // Find non-overlapping spawn position
        spawnPoint = findNonOverlappingPosition(spawnPoint.x, spawnPoint.y, unitConfig.size || 60);
        
        const unitId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
        const createdUnit = {
          id: unitId,
          userId: userId,
          type: unitType,
          x: spawnPoint.x,
          y: spawnPoint.y,
          hp: unitConfig.hp,
          maxHp: unitConfig.hp,
          damage: unitConfig.damage,
          speed: unitConfig.speed,
          attackRange: unitConfig.attackRange,
          attackCooldownMs: unitConfig.attackCooldownMs,
          targetX: null,
          targetY: null,
          gatheringResourceId: null,
          buildingType: null,
          buildTargetX: null,
          buildTargetY: null,
          isDetected: false,
          kills: 0
        };
        
        gameState.units.set(unitId, createdUnit);
        roomEmit('unitCreated', createdUnit);
        
        // Frigate spawns 2 units at once
        if (unitType === 'frigate') {
          const spawnPoint2 = findNonOverlappingPosition(spawnPoint.x + 40, spawnPoint.y + 40, unitConfig.size || 60);
          const unitId2 = Date.now() * 1000 + Math.floor(Math.random() * 1000) + 1;
          const createdUnit2 = { ...createdUnit, id: unitId2, x: spawnPoint2.x, y: spawnPoint2.y };
          gameState.units.set(unitId2, createdUnit2);
          roomEmit('unitCreated', createdUnit2);
        }
        
        building.producing = null;
        
        // Remove completed item from queue, start next
        if (building.productionQueue) building.productionQueue.shift();
        if (building.productionQueue && building.productionQueue.length > 0) {
          const next = building.productionQueue[0];
          building.producing = { unitType: next.unitType, startTime: Date.now(), buildTime: next.buildTime, userId: next.userId };
        }
      }
    }
  });

  // Missile production processing (queue-based) for missile_silo
  gameState.buildings.forEach(building => {
    if (building.type !== 'missile_silo' || building.buildProgress < 100) return;
    if (!building.missileQueue) building.missileQueue = [];
    if (building.missileProducing) {
      const elapsed = now - building.missileProducing.startTime;
      if (elapsed >= building.missileProducing.buildTime) {
        const player = gameState.players.get(building.missileProducing.userId);
        if (player && building.missileProducing.type === 'missile') {
          player.missiles = (player.missiles || 0) + 1;
          if (building.missileProducing.socketId) {
            io.to(building.missileProducing.socketId).emit('missileProduced', { userId: player.userId, count: player.missiles });
          }
        }
        // Dequeue and start next
        building.missileQueue.shift();
        building.missileProducing = null;
        if (building.missileQueue.length > 0) {
          const next = building.missileQueue[0];
          building.missileProducing = {
            type: next.type,
            startTime: Date.now(),
            buildTime: next.buildTime,
            userId: next.userId,
            socketId: next.socketId
          };
        }
      }
    }
  });

  // Update active SLBM missiles - position, arrival, interception
  gameState.activeSlbms.forEach((slbm, slbmId) => {
    const elapsed = now - slbm.startTime;
    const progress = Math.min(1, elapsed / slbm.flightTime);
    
    // Update current position
    slbm.currentX = slbm.fromX + (slbm.targetX - slbm.fromX) * progress;
    slbm.currentY = slbm.fromY + (slbm.targetY - slbm.fromY) * progress;
    
    // DPS threshold check - SLBM only takes damage if 500+ DPS accumulated per 1-second window
    if (!slbm.damageWindowStart) slbm.damageWindowStart = now;
    const windowElapsed = now - slbm.damageWindowStart;
    if (windowElapsed >= 1000) {
      const dps = (slbm.damageAccumulator || 0);
      if (dps >= 500) {
        // Threshold met - apply accumulated damage
        slbm.hp -= dps;
        roomEmit('slbmDamaged', { id: slbm.id, hp: slbm.hp, maxHp: slbm.maxHp });
        
        if (slbm.hp <= 0) {
          // SLBM intercepted by defense towers!
          roomEmit('slbmDestroyed', { id: slbm.id, x: slbm.currentX, y: slbm.currentY });
          gameState.activeSlbms.delete(slbmId);
          return;
        }
      }
      // Reset window
      slbm.damageAccumulator = 0;
      slbm.damageWindowStart = now;
    }
    
    // Check if arrived at target
    if (progress >= 1) {
      applySlbmDamage(slbm);
      roomEmit('slbmImpact', { id: slbmId, x: slbm.targetX, y: slbm.targetY });
      
      // Reveal impact area fog for ALL players temporarily
      const cellSize = gameState.map ? (gameState.map.cellSize || 50) : 50;
      const impactVisionRadius = 2000;
      const gridX = Math.floor(slbm.targetX / cellSize);
      const gridY = Math.floor(slbm.targetY / cellSize);
      const gridRadius = Math.ceil(impactVisionRadius / cellSize);
      gameState.players.forEach((player, playerId) => {
        const playerFog = gameState.fogOfWar.get(playerId);
        if (playerFog) {
          for (let dx = -gridRadius; dx <= gridRadius; dx++) {
            for (let dy = -gridRadius; dy <= gridRadius; dy++) {
              if (dx * dx + dy * dy <= gridRadius * gridRadius) {
                const key = `${gridX + dx}_${gridY + dy}`;
                playerFog.set(key, { lastSeen: now, explored: true });
              }
            }
          }
        }
      });
      
      gameState.activeSlbms.delete(slbmId);
    }
  });

  // Mine detonation processing
  gameState.units.forEach((mine, mineId) => {
    if (mine.type !== 'mine' || mine.hp <= 0) return;
    const mineRange = mine.attackRange || 80; // Blast radius = 2x visual radius (visual radius = size/2 = 20, range = 80)
    gameState.units.forEach((target, targetId) => {
      if (target.userId === mine.userId || target.type === 'mine' || target.type === 'aircraft' || target.hp <= 0) return;
      const dx = target.x - mine.x;
      const dy = target.y - mine.y;
      if (Math.sqrt(dx * dx + dy * dy) <= mineRange) {
        // Instant kill regardless of stealth, vision etc.
        target.hp = 0;
        const targetOwner = gameState.players.get(target.userId);
        if (targetOwner) {
          const popCost = getUnitDefinition(target.type).pop;
          targetOwner.population = Math.max(0, targetOwner.population - popCost);
        }
        if (isNavalUnitType(target.type)) {
          roomEmit('unitDestroyed', { id: target.id, x: target.x, y: target.y, type: target.type });
        }
        const mineOwner = gameState.players.get(mine.userId);
        if (mineOwner) mineOwner.combatPower += 10;
        gameState.units.delete(targetId);
        // Mine also consumed
        roomEmit('unitDestroyed', { id: mine.id, x: mine.x, y: mine.y, type: 'mine' });
        mine.hp = 0;
        gameState.units.delete(mineId);
      }
    });
  });

  // Airstrike processing - 3 separate flights, each bombs once when reaching target
  if (!gameState.activeAirstrikes) gameState.activeAirstrikes = new Map();
  gameState.activeAirstrikes.forEach((strike, strikeId) => {
    // Skip strikes that haven't started yet (delayed 2nd/3rd flights)
    if (now < strike.startTime) return;
    const elapsed = now - strike.startTime;
    const progress = Math.min(1, elapsed / strike.flightTime);
    strike.currentX = strike.fromX + (strike.exitX - strike.fromX) * progress;
    strike.currentY = strike.fromY + (strike.exitY - strike.fromY) * progress;

    if (now >= strike.impactTime && progress < 1) {
      revealFogCircleForAllPlayers(strike.targetX, strike.targetY, strike.damageRadius, now);
    }
    
    // Single bombing when this pass reaches the target point
    if (!strike.damageApplied && now >= strike.impactTime) {
      const damageRadius = strike.damageRadius;

      gameState.units.forEach(target => {
        const targetRadius = getUnitAreaHitRadius(target);
        if (targetIntersectsDamageCircle(strike.targetX, strike.targetY, damageRadius, target.x, target.y, targetRadius)) {
          target.hp -= strike.damagePerPass;
          target.lastDamageTime = now;
          if (target.hp <= 0) {
            const targetOwner = gameState.players.get(target.userId);
            if (targetOwner) {
              const popCost = getUnitDefinition(target.type).pop;
              targetOwner.population = Math.max(0, targetOwner.population - popCost);
            }
            if (isNavalUnitType(target.type) || target.type === 'mine') {
              roomEmit('unitDestroyed', { id: target.id, x: target.x, y: target.y, type: target.type });
            }
            const strikeOwner = gameState.players.get(strike.userId);
            if (strikeOwner) strikeOwner.combatPower += 10;
            gameState.units.delete(target.id);
          }
        }
      });

      gameState.buildings.forEach(target => {
        const targetRadius = getBuildingCollisionSize(target.type) / 2;
        if (targetIntersectsDamageCircle(strike.targetX, strike.targetY, damageRadius, target.x, target.y, targetRadius)) {
          target.hp -= strike.damagePerPass;
          if (target.hp <= 0) {
            roomEmit('buildingDestroyed', { id: target.id, x: target.x, y: target.y, type: target.type });
            gameState.buildings.delete(target.id);
            checkPlayerDefeat(target.userId, strike.userId);
          }
        }
      });
      strike.damageApplied = true;
      
      roomEmit('airstrikePass', {
        id: strikeId,
        passNum: strike.passNumber || 1,
        targetX: strike.targetX,
        targetY: strike.targetY,
        radius: strike.visualRadius,
        explosionsPerPass: strike.explosionsPerPass
      });
    }
    
    // Remove when flight reaches map edge
    if (progress >= 1) {
      gameState.activeAirstrikes.delete(strikeId);
    }
  });

  // Carrier airstrike readiness tracking
  gameState.units.forEach(unit => {
    if (unit.type !== 'carrier') return;
    const acCount = (unit.aircraft || []).length;
    if (acCount >= 10) {
      if (unit.pendingAirstrikeCooldown) {
        // Aircraft just reached 10 after an airstrike - start 20s cooldown
        unit.airstrikeCooldownUntil = now + 20000;
        unit.pendingAirstrikeCooldown = false;
      }
      if (!unit.airstrikeCooldownUntil || now >= unit.airstrikeCooldownUntil) {
        unit.airstrikeReady = true;
      }
    } else {
      unit.airstrikeReady = false;
    }
  });

  // Destroyers always reveal submarines and mines inside current vision.
  const destroyerSensors = [];
  gameState.units.forEach(unit => {
    if (unit.type !== 'destroyer' || unit.hp <= 0) return;
    const baseVision = unit.visionRadius || UNIT_DEFINITIONS.destroyer.visionRadius;
    const detectionRadius = (unit.searchActiveUntil && now < unit.searchActiveUntil)
      ? DESTROYER_SEARCH_VISION_RADIUS
      : baseVision;
    destroyerSensors.push({
      userId: unit.userId,
      x: unit.x,
      y: unit.y,
      radiusSq: detectionRadius * detectionRadius
    });
    if (unit.searchActiveUntil && now >= unit.searchActiveUntil) {
      unit.searchActiveUntil = null;
    }
  });

  gameState.units.forEach(unit => {
    if (unit.type !== 'submarine' && unit.type !== 'mine') return;

    let detected = false;
    if (unit.type === 'submarine' && unit.lastAttackTime && now - unit.lastAttackTime <= 10000) {
      detected = true;
    }
    if (!detected && unit.searchRevealedUntil && now < unit.searchRevealedUntil) {
      detected = true;
    }
    if (!detected) {
      for (let i = 0; i < destroyerSensors.length; i++) {
        const sensor = destroyerSensors[i];
        if (sensor.userId === unit.userId) continue;
        const dx = unit.x - sensor.x;
        const dy = unit.y - sensor.y;
        if ((dx * dx) + (dy * dy) <= sensor.radiusSq) {
          detected = true;
          break;
        }
      }
    }

    unit.isDetected = detected;
    if (unit.searchRevealedUntil && now >= unit.searchRevealedUntil) {
      unit.searchRevealedUntil = null;
    }
  });

  // Carrier aircraft system processing
  gameState.units.forEach((unit, unitId) => {
    if (unit.type !== 'carrier') return;
    if (!unit.aircraft) unit.aircraft = [];
    if (!unit.aircraftDeployed) unit.aircraftDeployed = [];
    if (!unit.aircraftQueue) unit.aircraftQueue = [];
    
    // Aircraft production queue processing
    if (unit.producingAircraft) {
      const elapsed = now - unit.producingAircraft.startTime;
      if (elapsed >= unit.producingAircraft.buildTime) {
        // Production complete - add aircraft
        unit.aircraft.push({ hp: getUnitDefinition('aircraft').hp });
        unit.aircraftQueue.shift();
        unit.producingAircraft = null;
        if (unit.aircraftQueue.length > 0) {
          const next = unit.aircraftQueue[0];
          unit.producingAircraft = {
            type: next.type,
            startTime: Date.now(),
            buildTime: next.buildTime,
            userId: next.userId
          };
        }
      }
    }
    
    // Auto-deploy aircraft when enemies are nearby
    let enemyNearCarrier = false;
    gameState.units.forEach(enemy => {
      if (enemy.userId !== unit.userId && enemy.type !== 'aircraft') {
        if (enemy.type === 'submarine' && !enemy.isDetected) return;
        const ex = enemy.x - unit.x;
        const ey = enemy.y - unit.y;
        if (Math.sqrt(ex * ex + ey * ey) <= (unit.attackRange || 800) + 200) {
          enemyNearCarrier = true;
        }
      }
    });
    gameState.buildings.forEach(enemy => {
      if (enemy.userId !== unit.userId) {
        const ex = enemy.x - unit.x;
        const ey = enemy.y - unit.y;
        if (Math.sqrt(ex * ex + ey * ey) <= (unit.attackRange || 800) + 200) {
          enemyNearCarrier = true;
        }
      }
    });
    
    // If carrier has attack target, deploy command, or enemies nearby, deploy aircraft
    if (unit.attackTargetId || unit.deployAircraft || enemyNearCarrier) {
      if (!unit.lastAircraftDeploy || now - unit.lastAircraftDeploy >= 500) {
        if (unit.aircraft.length > 0) {
          const aircraftData = unit.aircraft.pop();
          const unitConfig = getUnitDefinition('aircraft');
          const acId = Date.now() * 1000 + Math.floor(Math.random() * 1000);
          const spawnPos = findNonOverlappingPosition(unit.x + (Math.random() - 0.5) * 40, unit.y + (Math.random() - 0.5) * 40, 25);
          const ac = {
            id: acId,
            userId: unit.userId,
            type: 'aircraft',
            x: spawnPos.x,
            y: spawnPos.y,
            hp: unitConfig.hp,
            maxHp: unitConfig.hp,
            damage: unitConfig.damage,
            speed: unitConfig.speed,
            attackRange: unitConfig.attackRange,
            attackCooldownMs: unitConfig.attackCooldownMs,
            targetX: null,
            targetY: null,
            gatheringResourceId: null,
            buildingType: null,
            buildTargetX: null,
            buildTargetY: null,
            isDetected: false,
            kills: 0,
            carrierId: unitId,
            carrierRange: unit.attackRange || 800
          };
          gameState.units.set(acId, ac);
          unit.aircraftDeployed.push(acId);
          unit.lastAircraftDeploy = now;
          roomEmit('unitCreated', ac);
        }
      }
      unit.deployAircraft = false;
    }
    
    // Clean up destroyed aircraft references
    unit.aircraftDeployed = unit.aircraftDeployed.filter(id => gameState.units.has(id));
  });
  
  // Aircraft behavior - patrol near carrier, attack enemies, return when no enemies
  gameState.units.forEach((ac) => {
    if (ac.type !== 'aircraft' || !ac.carrierId) return;
    const carrier = gameState.units.get(ac.carrierId);
    if (!carrier) {
      // Carrier destroyed - aircraft is also destroyed
      roomEmit('unitDestroyed', { id: ac.id, x: ac.x, y: ac.y, type: 'aircraft' });
      gameState.units.delete(ac.id);
      return;
    }
    
    const dx = ac.x - carrier.x;
    const dy = ac.y - carrier.y;
    const distToCarrier = Math.sqrt(dx * dx + dy * dy);
    const maxRange = ac.carrierRange || 800;
    
    // Check if there's an enemy in carrier range
    let hasEnemyNearby = false;
    gameState.units.forEach(enemy => {
      if (enemy.userId !== ac.userId && enemy.type !== 'aircraft') {
        if ((enemy.type === 'submarine' || enemy.type === 'mine') && !enemy.isDetected) return;
        const ex = enemy.x - carrier.x;
        const ey = enemy.y - carrier.y;
        if (Math.sqrt(ex * ex + ey * ey) <= maxRange + 200) {
          hasEnemyNearby = true;
        }
      }
    });
    
    if (!hasEnemyNearby && !ac.attackTargetId) {
      // No enemies - return to carrier
      if (distToCarrier > 80) {
        assignMoveTarget(ac, carrier.x + (Math.random() - 0.5) * 60, carrier.y + (Math.random() - 0.5) * 60);
      } else if (distToCarrier <= 80) {
        // Close enough to carrier, dock
        gameState.units.delete(ac.id);
        carrier.aircraftDeployed = carrier.aircraftDeployed.filter(id => id !== ac.id);
        carrier.aircraft.push({ hp: ac.hp });
        return;
      }
    } else if (ac.targetX === null && !ac.attackTargetId) {
      // Patrol randomly near carrier
      const angle = Math.random() * Math.PI * 2;
      const dist = 100 + Math.random() * (maxRange * 0.6);
      const px = carrier.x + Math.cos(angle) * dist;
      const py = carrier.y + Math.sin(angle) * dist;
      assignMoveTarget(ac, px, py);
    }
    
    // If aircraft is too far from carrier and has no player-assigned target, bring it back
    if (distToCarrier > maxRange + 100 && !ac.attackTargetId) {
      assignMoveTarget(ac, carrier.x + (Math.random() - 0.5) * 100, carrier.y + (Math.random() - 0.5) * 100);
    }
  });

  // Spatial index for tower target search (avoids full unit scan per tower).
  const towerTargetSpatialIndex = new Map();
  gameState.units.forEach(unit => {
    if (unit.hp > 0) {
      addToSpatialMap(towerTargetSpatialIndex, unit);
    }
  });
  
  // Defense tower combat
  gameState.buildings.forEach(building => {
    if (building.type !== 'defense_tower' || building.buildProgress < 100) return;
    
    const towerRange = 2500; // Same as battleship
    const towerDamage = 26;  // 1/10 of battleship
    const towerCooldownMs = 480; // 10x faster than battleship
    let towerTrackedTarget = false;
    
    // Find nearest enemy unit
    let nearestTarget = null;
    let nearestDistSq = towerRange * towerRange;

    forEachNearbyEntity(towerTargetSpatialIndex, building.x, building.y, towerRange, (enemy) => {
      if (!enemy || !gameState.units.has(enemy.id)) return;
      if (enemy.userId === building.userId) return;
      if ((enemy.type === 'submarine' || enemy.type === 'mine') && !enemy.isDetected) return;

      const dx = enemy.x - building.x;
      const dy = enemy.y - building.y;
      const distSq = (dx * dx) + (dy * dy);
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq;
        nearestTarget = enemy;
      }
    });
    
    if (nearestTarget) {
      const aimState = getDefenseTowerMuzzleWorldPosition(building.x, building.y, nearestTarget.x, nearestTarget.y);
      building.attackTargetId = nearestTarget.id;
      building.attackTargetType = 'unit';
      building.turretAngle = aimState.angle;
      building.turretTargetX = nearestTarget.x;
      building.turretTargetY = nearestTarget.y;
      building.lastTurretTargetTime = now;
      towerTrackedTarget = true;

      if (!building.lastAttackTime || now - building.lastAttackTime >= towerCooldownMs) {
        building.lastAttackTime = now;
        emitAttackProjectile(building, nearestTarget);
        nearestTarget.hp -= towerDamage;
        nearestTarget.lastDamageTime = now; // Track for HP regeneration
        
        // Track attackers for AI counterattack response (defense tower attacks)
        if (nearestTarget.userId < 0) {
          // Target belongs to AI - record attacker info
          if (!nearestTarget.recentAttackers) nearestTarget.recentAttackers = [];
          nearestTarget.recentAttackers.push({
            attackerId: building.userId,
            attackerBuildingId: building.id,
            attackX: building.x,
            attackY: building.y,
            timestamp: now
          });
          // Also mark the attack location on the AI player
          const aiPlayer = gameState.players.get(nearestTarget.userId);
          if (aiPlayer && aiPlayer.isAI) {
            if (!aiPlayer.recentAttackLocations) aiPlayer.recentAttackLocations = [];
            aiPlayer.recentAttackLocations.push({
              x: nearestTarget.x,
              y: nearestTarget.y,
              attackerId: building.userId,
              timestamp: now
            });
          }
        }
        
        if (nearestTarget.hp <= 0) {
          const attacker = gameState.players.get(building.userId);
          const targetOwner = gameState.players.get(nearestTarget.userId);
          if (targetOwner) {
            const popCost = getUnitDefinition(nearestTarget.type).pop;
            targetOwner.population = Math.max(0, targetOwner.population - popCost);
          }
          // Emit death effect for ships
          if (isNavalUnitType(nearestTarget.type)) {
            roomEmit('unitDestroyed', { id: nearestTarget.id, x: nearestTarget.x, y: nearestTarget.y, type: nearestTarget.type });
          }
          gameState.units.delete(nearestTarget.id);
          building.attackTargetId = null;
          building.attackTargetType = null;
          if (attacker) attacker.combatPower += 10;
        }
      }
    }
    
    // Defense tower SLBM interception (separate cooldown, 500 DPS threshold)
    gameState.activeSlbms.forEach(slbm => {
      if (slbm.userId === building.userId) return;
      if (!slbm.currentX || !slbm.currentY) return;
      const dx = slbm.currentX - building.x;
      const dy = slbm.currentY - building.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= towerRange) {
        // Tower fires at SLBM (using same cooldown as unit attack)
        if (!building.lastSlbmAttackTime || now - building.lastSlbmAttackTime >= towerCooldownMs) {
          const aimState = getDefenseTowerMuzzleWorldPosition(building.x, building.y, slbm.currentX, slbm.currentY);
          building.attackTargetId = slbm.id ?? null;
          building.attackTargetType = 'slbm';
          building.turretAngle = aimState.angle;
          building.turretTargetX = slbm.currentX;
          building.turretTargetY = slbm.currentY;
          building.lastTurretTargetTime = now;
          towerTrackedTarget = true;
          building.lastSlbmAttackTime = now;
          emitAttackProjectile(building, { id: slbm.id, x: slbm.currentX, y: slbm.currentY });
          // Accumulate damage - only applied if 500+ DPS threshold met
          slbm.damageAccumulator = (slbm.damageAccumulator || 0) + towerDamage;
        }
      }
    });

    if (!towerTrackedTarget && building.lastTurretTargetTime && now - building.lastTurretTargetTime > 1200) {
      building.attackTargetId = null;
      building.attackTargetType = null;
      building.turretTargetX = null;
      building.turretTargetY = null;
    }
  });
  
  // Unit collision separation (ellipse-based for naval units)
  const unitArray = Array.from(gameState.units.values());

  function getUnitEllipse(unit) {
    if (unit.type === 'worker' || unit.type === 'mine') {
      const r = (unit.type === 'worker' ? 40 : 40) * 0.5;
      return { semiMajor: r, semiMinor: r, angle: 0 };
    }
    const sz = unit.type === 'frigate' ? 35 : (unit.type === 'aircraft' ? 25 : 60);
    const hm = unit.type === 'aircraft' ? 2.5 : SHIP_HEIGHT_MULT;
    const semiMajor = (sz * hm) / 2;
    const semiMinor = semiMajor * SHIP_ASPECT_RATIO;
    return { semiMajor, semiMinor, angle: unit.angle || 0 };
  }

  // Check if point (px,py) is inside ellipse centered at origin with given semi-axes and rotation
  function pointInEllipse(px, py, semiMajor, semiMinor, angle) {
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    const lx = px * cosA - py * sinA;
    const ly = px * sinA + py * cosA;
    return (lx * lx) / (semiMinor * semiMinor) + (ly * ly) / (semiMajor * semiMajor);
  }

  const collisionSpatialMap = new Map();
  for (let i = 0; i < unitArray.length; i++) {
    const unit = unitArray[i];
    if (unit.type === 'aircraft') continue;
    if (unit.type === 'mine') continue;
    const cellX = Math.floor(unit.x / COLLISION_SPATIAL_CELL_SIZE);
    const cellY = Math.floor(unit.y / COLLISION_SPATIAL_CELL_SIZE);
    const key = `${cellX}_${cellY}`;
    let bucket = collisionSpatialMap.get(key);
    if (!bucket) {
      bucket = [];
      collisionSpatialMap.set(key, bucket);
    }
    bucket.push(i);
  }

  for (let i = 0; i < unitArray.length; i++) {
    const a = unitArray[i];
    if (a.type === 'aircraft') continue;
    const cellX = Math.floor(a.x / COLLISION_SPATIAL_CELL_SIZE);
    const cellY = Math.floor(a.y / COLLISION_SPATIAL_CELL_SIZE);

    for (let dyCell = -1; dyCell <= 1; dyCell++) {
      for (let dxCell = -1; dxCell <= 1; dxCell++) {
        const neighborKey = `${cellX + dxCell}_${cellY + dyCell}`;
        const bucket = collisionSpatialMap.get(neighborKey);
        if (!bucket) continue;

        for (let k = 0; k < bucket.length; k++) {
          const j = bucket[k];
          if (j <= i) continue;
          const b = unitArray[j];
          if (!b || b.type === 'aircraft') continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distSq = (dx * dx) + (dy * dy);
          if (distSq < 0.01) continue;

          const eA = getUnitEllipse(a);
          const eB = getUnitEllipse(b);

          // Quick distance check (max possible radius)
          const maxRadA = Math.max(eA.semiMajor, eA.semiMinor);
          const maxRadB = Math.max(eB.semiMajor, eB.semiMinor);
          if (distSq > (maxRadA + maxRadB) * (maxRadA + maxRadB)) continue;

          // Check overlap: is center of B inside scaled ellipse of A, or vice versa
          const valA = pointInEllipse(dx, dy, eA.semiMajor, eA.semiMinor, eA.angle);
          const valB = pointInEllipse(-dx, -dy, eB.semiMajor, eB.semiMinor, eB.angle);

          // If either center is well inside the other's ellipse, push apart
          const overlapVal = Math.min(valA, valB);
          if (overlapVal < 1.0) {
            const dist = Math.sqrt(distSq);
            const nx = dx / dist;
            const ny = dy / dist;
            // Push force proportional to how deep inside ellipse
            const pushForce = (1.0 - overlapVal) * Math.max(eA.semiMajor, eB.semiMajor) * 0.3;
            const pushX = nx * pushForce;
            const pushY = ny * pushForce;

            a.x -= pushX;
            a.y -= pushY;
            b.x += pushX;
            b.y += pushY;
          }
        }
      }
    }
  }

  // === Cruiser Lone Wolf passive: check isolation ===
  gameState.units.forEach((unit) => {
    if (unit.type !== 'cruiser' || unit.hp <= 0) return;
    const vr = 1200; // cruiser visionRadius
    const vrSq = vr * vr;
    let hasAlly = false;
    // Check allied units in vision range
    gameState.units.forEach((other) => {
      if (hasAlly) return;
      if (other.id === unit.id || other.userId !== unit.userId || other.hp <= 0) return;
      const dx = other.x - unit.x;
      const dy = other.y - unit.y;
      if (dx * dx + dy * dy <= vrSq) hasAlly = true;
    });
    // Check allied buildings in vision range
    if (!hasAlly) {
      gameState.buildings.forEach((bld) => {
        if (hasAlly) return;
        if (bld.userId !== unit.userId || bld.hp <= 0) return;
        const dx = bld.x - unit.x;
        const dy = bld.y - unit.y;
        if (dx * dx + dy * dy <= vrSq) hasAlly = true;
      });
    }
    unit.isIsolated = !hasAlly;
  });

  // Spatial indexes for combat target search.
  const combatUnitSpatialIndex = new Map();
  const combatBuildingSpatialIndex = new Map();
  gameState.units.forEach(unit => {
    if (unit.hp > 0) addToSpatialMap(combatUnitSpatialIndex, unit);
  });
  gameState.buildings.forEach(building => {
    if (building.hp > 0) addToSpatialMap(combatBuildingSpatialIndex, building);
  });
  
  // Combat processing for all units
  gameState.units.forEach((unit, unitId) => {
    // Skip workers for auto-attack
    if (unit.type === 'worker') return;
    // Carrier has no direct attack (uses aircraft instead)
    if (unit.type === 'carrier') return;
    // Mines don't auto-attack (they detonate on proximity, handled separately)
    if (unit.type === 'mine') return;

    const unitStats = getUnitDefinition(unit.type);
    const baseCombatRange = unit.attackRange || unitStats.attackRange || 200;
    let combatRange = (unit.type === 'battleship' && unit.aimedShot) ? baseCombatRange * 2 : baseCombatRange;
    // Aegis mode: 60% range reduction
    if (unit.type === 'cruiser' && unit.aegisMode) {
      combatRange = baseCombatRange * 0.4;
    }
    const attackCooldownMs = unit.attackCooldownMs || unitStats.attackCooldownMs || 1000;
    
    let target = null;
    
    // 1) Check if unit has a specific attack target
    if (unit.attackTargetId) {
      if (unit.attackTargetType === 'unit') {
        target = gameState.units.get(unit.attackTargetId);
        // Can't attack undetected submarines or mines
        if (target && (target.type === 'submarine' || target.type === 'mine') && !target.isDetected) {
          target = null;
          unit.attackTargetId = null;
          unit.attackTargetType = null;
        }
      } else if (unit.attackTargetType === 'building') {
        target = gameState.buildings.get(unit.attackTargetId);
      }
      // If target was destroyed, clear it
      if (!target) {
        unit.attackTargetId = null;
        unit.attackTargetType = null;
      }
    }
    
    // 2) If no specific target, auto-detect nearest enemy within range
    //    Submarines do NOT auto-attack unless on attack-move ('A' key)
    if (!target && (unit.type !== 'submarine' || unit.attackMove || unit.holdPosition)) {
      let nearestDistSq = combatRange * combatRange;

      // Check enemy units (spatial query)
      forEachNearbyEntity(combatUnitSpatialIndex, unit.x, unit.y, combatRange, (enemy) => {
        if (!enemy || enemy.id === unit.id) return;
        if (!gameState.units.has(enemy.id)) return;
        if (enemy.userId === unit.userId) return;
        // Don't attack undetected submarines or mines
        if ((enemy.type === 'submarine' || enemy.type === 'mine') && !enemy.isDetected) return;

        const dx = enemy.x - unit.x;
        const dy = enemy.y - unit.y;
        const distSq = (dx * dx) + (dy * dy);
        if (distSq < nearestDistSq) {
          nearestDistSq = distSq;
          target = enemy;
          unit.attackTargetType = 'unit';
        }
      });

      // Check enemy buildings (spatial query)
      forEachNearbyEntity(combatBuildingSpatialIndex, unit.x, unit.y, combatRange, (enemy) => {
        if (!enemy || !gameState.buildings.has(enemy.id)) return;
        if (enemy.userId === unit.userId) return;

        const dx = enemy.x - unit.x;
        const dy = enemy.y - unit.y;
        const distSq = (dx * dx) + (dy * dy);
        if (distSq < nearestDistSq) {
          nearestDistSq = distSq;
          target = enemy;
          unit.attackTargetType = 'building';
        }
      });
      
      // Check enemy SLBMs - only aegis-mode cruisers can target SLBMs
      if (unit.type === 'cruiser' && unit.aegisMode) {
        gameState.activeSlbms.forEach(slbm => {
          if (slbm.userId === unit.userId) return;
          if (!slbm.currentX || !slbm.currentY) return;
          const dx = slbm.currentX - unit.x;
          const dy = slbm.currentY - unit.y;
          const distSq = dx * dx + dy * dy;
          // Aegis SLBM interception uses full base range (not reduced)
          const aegisSlbmRange = baseCombatRange;
          if (distSq < aegisSlbmRange * aegisSlbmRange && distSq < nearestDistSq) {
            nearestDistSq = distSq;
            target = slbm;
            unit.attackTargetType = 'slbm';
          }
        });
      }
    }
    
    // 3) Process attack on target
    if (target) {
      // SLBM targets use currentX/currentY instead of x/y
      const targetX = (unit.attackTargetType === 'slbm') ? target.currentX : target.x;
      const targetY = (unit.attackTargetType === 'slbm') ? target.currentY : target.y;
      const dx = targetX - unit.x;
      const dy = targetY - unit.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Aegis mode cruiser uses full base range for SLBM targeting
      const effectiveRange = (unit.type === 'cruiser' && unit.aegisMode && unit.attackTargetType === 'slbm') ? baseCombatRange : combatRange;
      
      if (dist <= effectiveRange) {
        // In range - STOP moving and attack
        if (unit.targetX !== null && !unit.attackMove) {
          // Only stop if not on a deliberate attack-move
        }
        
        // Fire if cooldown ready
        if (!unit.lastAttackTime || now - unit.lastAttackTime >= attackCooldownMs) {
          unit.lastAttackTime = now;
          
          // For SLBM targets, create a temporary position object for projectile
          if (unit.attackTargetType === 'slbm') {
            emitAttackProjectile(unit, { x: target.currentX, y: target.currentY });
          } else {
            emitAttackProjectile(unit, target);
          }
          
          // Calculate damage with modifiers
          let dmg = unit.damage;
          
          // Aegis mode: fixed damage, with bonus interception damage versus SLBMs.
          if (unit.type === 'cruiser' && unit.aegisMode) {
            dmg = unit.attackTargetType === 'slbm' ? 50 : 25;
          }
          
          // Aimed shot: 2x damage
          if (unit.type === 'battleship' && unit.aimedShot) {
            dmg *= 2;
          }
          
          // Lone Wolf passive: +100% damage when isolated
          if (unit.type === 'cruiser' && unit.isIsolated && !unit.aegisMode) {
            dmg *= 2;
          }
          
          // Apply damage reduction on target (Lone Wolf: 50% reduction, Aegis: 30% reduction)
          if (unit.attackTargetType === 'unit' && target.type === 'cruiser') {
            if (target.aegisMode) {
              dmg *= 0.7; // 30% damage reduction
            }
            if (target.isIsolated && !target.aegisMode) {
              dmg *= 0.5; // 50% damage reduction
            }
          }
          
          // For SLBM targets in aegis mode, accumulate damage like defense towers
          if (unit.attackTargetType === 'slbm') {
            target.damageAccumulator = (target.damageAccumulator || 0) + dmg;
          } else {
            target.hp -= dmg;
          }
          
          // Track last damage time for HP regeneration
          if (unit.attackTargetType === 'unit' || unit.attackTargetType === 'building') {
            target.lastDamageTime = now;
          }
          
          // Track attackers for AI counterattack response (units only)
          if (unit.attackTargetType === 'unit' && target.userId < 0) {
            // Target belongs to AI - record attacker info
            if (!target.recentAttackers) target.recentAttackers = [];
            target.recentAttackers.push({
              attackerId: unit.userId,
              attackerUnitId: unit.id,
              attackX: unit.x,
              attackY: unit.y,
              timestamp: now
            });
            // Also mark the attack location on the AI player
            const aiPlayer = gameState.players.get(target.userId);
            if (aiPlayer && aiPlayer.isAI) {
              if (!aiPlayer.recentAttackLocations) aiPlayer.recentAttackLocations = [];
              aiPlayer.recentAttackLocations.push({
                x: target.x,
                y: target.y,
                attackerId: unit.userId,
                timestamp: now
              });
            }
          }
          
          // Broadcast SLBM HP update to clients
          if (unit.attackTargetType === 'slbm') {
            roomEmit('slbmDamaged', { id: target.id, hp: target.hp, maxHp: target.maxHp });
          }
          
          // Consume aimed shot after firing and start 16s cooldown
          if (unit.type === 'battleship' && unit.aimedShot) {
            unit.aimedShot = false;
            unit.aimedShotCooldownUntil = now + 16000;
          }
          
          // Submarine breaks stealth when attacking
          if (unit.type === 'submarine') {
            unit.isDetected = true;
          }
          
          // Check if target destroyed
          if (target.hp <= 0) {
            const attacker = gameState.players.get(unit.userId);
            
            if (unit.attackTargetType === 'slbm') {
              // SLBM intercepted!
              roomEmit('slbmDestroyed', { id: target.id, x: target.currentX, y: target.currentY });
              gameState.activeSlbms.delete(target.id);
              if (attacker) attacker.combatPower += 30;
              unit.kills = (unit.kills || 0) + 1;
            } else if (unit.attackTargetType === 'unit') {
              // Decrement owner's population
              const targetOwner = gameState.players.get(target.userId);
              if (targetOwner) {
                const popCost = getUnitDefinition(target.type).pop;
                targetOwner.population = Math.max(0, targetOwner.population - popCost);
              }
              // Emit death effect for ships
              if (isNavalUnitType(target.type)) {
                roomEmit('unitDestroyed', { id: target.id, x: target.x, y: target.y, type: target.type });
              }
              gameState.units.delete(target.id);
              if (attacker) attacker.combatPower += 10;
              unit.kills = (unit.kills || 0) + 1;
            } else {
              roomEmit('buildingDestroyed', { id: target.id, x: target.x, y: target.y, type: target.type });
              gameState.buildings.delete(target.id);
              if (attacker) attacker.combatPower += 20;
              checkPlayerDefeat(target.userId, unit.userId);
            }
            
            unit.attackTargetId = null;
            unit.attackTargetType = null;
          }
        }
      } else if ((unit.attackTargetId || unit.attackMove) && !unit.holdPosition) {
        // Out of range but has explicit attack command - move towards target
        const moveToX = (unit.attackTargetType === 'slbm') ? target.currentX : target.x;
        const moveToY = (unit.attackTargetType === 'slbm') ? target.currentY : target.y;
        assignMoveTarget(unit, moveToX, moveToY);
      }
      // If auto-detected but out of range and no attack command, don't chase
    } else if (unit.attackMove) {
      // Attack-move with no target found - DON'T clear attackMove, keep scanning
      // attackMove naturally clears when unit reaches its move target
    }
  });
}

// Ranking endpoint
app.get('/api/rankings', (req, res) => {
  // Rankings panel is room-local. Never merge same-named AI players across rooms.
  const requestedRoomId = typeof req.query.roomId === 'string' ? req.query.roomId : null;
  const requestedUserId = typeof req.query.userId === 'string' ? req.query.userId : null;
  const room =
    (requestedRoomId && gameRooms.get(requestedRoomId)) ||
    gameRooms.get('server1') ||
    [...gameRooms.values()][0];

  if (!room) {
    res.json([]);
    return;
  }

  const scoredPlayers = [...room.players.values()]
    .filter(player => player && (player.isAI || player.online))
    .map((player) => ({
      userId: String(player.userId),
      username: player.username,
      resources: Math.floor(player.resources || 0),
      population: player.population || 0,
      combat_power: player.combatPower || 0,
      score: calculatePlayerScore(player)
    }))
    .filter(player => player.score > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  const rankings = scoredPlayers
    .slice(0, 10)
    .map(player => ({
      ...player,
      isSelf: requestedUserId != null && player.userId === requestedUserId
    }));

  if (requestedUserId != null && !rankings.some(player => player.userId === requestedUserId)) {
    const ownPlayer = scoredPlayers.find(player => player.userId === requestedUserId);
    if (ownPlayer) {
      rankings.push({
        ...ownPlayer,
        isSelf: true
      });
    }
  }

  res.json(rankings);
});

// Auto-save disabled (no persistence)
// State is cleared on disconnect

// ==================== AI PLAYER SYSTEM ====================

const AI_CONFIG = {
  count: 2, // Number of AI players
  updateInterval: 3000, // AI decision interval (ms)
  respawnDelayMs: 10000, // How long defeated AI stays out of the room
  scoutInterval: 10000, // How often to send scouts
  buildingPriority: ['power_plant', 'shipyard', 'naval_academy', 'missile_silo', 'defense_tower'],
  unitPriority: ['worker', 'destroyer', 'cruiser', 'frigate', 'submarine', 'battleship', 'carrier'],
  attackerTrackingDuration: 5000, // How long to remember attackers (5 seconds)
  counterattackThreshold: 3, // Minimum attackers to trigger counterattack response
  // Combat power scoring per unit type
  combatPower: {
    frigate: 5,
    destroyer: 10,
    cruiser: 15,
    battleship: 50,
    carrier: 40,
    submarine: 100
  },
  // Island expansion threshold
  expansionBuildingThreshold: 10
};

function getAIUserId(aiIndex) {
  return -1000 - aiIndex;
}

function getAIIndexFromUserId(aiUserId) {
  if (aiUserId > -1000) return null;
  return -1000 - aiUserId;
}

function getAIName(aiIndex) {
  return `AI_Commander_${aiIndex + 1}`;
}

function spawnAIPlayer(aiIndex) {
  const aiId = getAIUserId(aiIndex);
  if (gameState.players.has(aiId)) {
    return gameState.players.get(aiId);
  }

  const aiName = getAIName(aiIndex);
  const startPos = findStartPosition();
  if (!isOnLand(startPos.x, startPos.y)) {
    const landPos = findNearestLandPosition(startPos.x, startPos.y);
    startPos.x = landPos.x;
    startPos.y = landPos.y;
  }
  const resolvedStartPos = findNearestValidBuildingPosition('headquarters', startPos.x, startPos.y);
  if (resolvedStartPos) {
    startPos.x = resolvedStartPos.x;
    startPos.y = resolvedStartPos.y;
  }

  const aiPlayer = {
    userId: aiId,
    username: aiName,
    resources: 1000,
    population: 0,
    maxPopulation: 10,
    combatPower: 0,
    score: 0,
    baseX: startPos.x,
    baseY: startPos.y,
    hasBase: true,
    researchedSLBM: false,
    missiles: 0,
    online: true,
    isAI: true,
    lastScoutTime: 0,
    lastAttackTime: 0,
    scoutTargets: [],
    knownEnemyBases: [],
    recentAttackLocations: [],
    priorityTargets: [],
    isCounterattacking: false,
    counterattackTarget: null
  };
  gameState.players.set(aiId, aiPlayer);
  gameState.fogOfWar.set(aiId, new Map());

  const hqId = Date.now() * 1000 + Math.floor(Math.random() * 1000) + aiIndex * 100;
  gameState.buildings.set(hqId, {
    id: hqId,
    userId: aiId,
    type: 'headquarters',
    x: startPos.x,
    y: startPos.y,
    hp: 1500,
    maxHp: 1500,
    buildProgress: 100
  });

  console.log(`AI Player ${aiName} initialized at (${startPos.x.toFixed(0)}, ${startPos.y.toFixed(0)})`);
  return aiPlayer;
}

function scheduleAIRespawn(aiUserId) {
  const roomId = currentRoomId;
  const room = roomId ? gameRooms.get(roomId) : null;
  const aiIndex = getAIIndexFromUserId(aiUserId);
  if (!room || aiIndex == null) {
    return;
  }

  const existingTimer = room.aiRespawnTimers.get(aiUserId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    const targetRoom = gameRooms.get(roomId);
    if (!targetRoom) return;
    targetRoom.aiRespawnTimers.delete(aiUserId);
    if (!roomHasHumanPlayers(roomId)) {
      return;
    }

    switchRoom(roomId);

    const aiPlayer = spawnAIPlayer(aiIndex);
    syncSlbmId();
    io.to(roomId).emit('playerJoined', aiPlayer);
    console.log(`AI ${aiPlayer.username} rejoined room ${roomId}`);
  }, AI_CONFIG.respawnDelayMs);

  room.aiRespawnTimers.set(aiUserId, timer);
}

function clearAIRespawnTimer(aiUserId) {
  const existingTimer = gameState.aiRespawnTimers.get(aiUserId);
  if (!existingTimer) {
    return;
  }
  clearTimeout(existingTimer);
  gameState.aiRespawnTimers.delete(aiUserId);
}

function clearActiveWeaponsForUser(userId) {
  const slbmIdsToDelete = [];
  gameState.activeSlbms.forEach((slbm, slbmId) => {
    if (slbm.userId === userId) {
      slbmIdsToDelete.push(slbmId);
    }
  });
  slbmIdsToDelete.forEach(slbmId => {
    const slbm = gameState.activeSlbms.get(slbmId);
    gameState.activeSlbms.delete(slbmId);
    roomEmit('slbmDestroyed', {
      id: slbmId,
      x: slbm ? slbm.currentX : null,
      y: slbm ? slbm.currentY : null
    });
  });

  if (!gameState.activeAirstrikes) {
    return;
  }

  const strikeIdsToDelete = [];
  gameState.activeAirstrikes.forEach((strike, strikeId) => {
    if (strike.userId === userId) {
      strikeIdsToDelete.push(strikeId);
    }
  });
  strikeIdsToDelete.forEach(strikeId => {
    gameState.activeAirstrikes.delete(strikeId);
    roomEmit('airstrikeCancelled', { id: strikeId });
  });
}

function removeAllAiFactionsFromCurrentRoom(options = {}) {
  if (!gameState || AI_CONFIG.count <= 0) {
    return 0;
  }

  const { emitPlayerLeft = false } = options;
  let removedCount = 0;

  for (let aiIndex = 0; aiIndex < AI_CONFIG.count; aiIndex++) {
    const aiUserId = getAIUserId(aiIndex);
    clearAIRespawnTimer(aiUserId);
    clearActiveWeaponsForUser(aiUserId);

    if (gameState.players.has(aiUserId)) {
      removePlayerFromCurrentRoom(aiUserId, { emitPlayerLeft });
      removedCount++;
    } else {
      gameState.fogOfWar.delete(aiUserId);
    }
  }

  return removedCount;
}

function resetAllAiFactionsInCurrentRoom() {
  if (!gameState || !currentRoomId || AI_CONFIG.count <= 0) {
    return 0;
  }

  const roomId = currentRoomId;
  roomEmit('systemKillLog', { message: '(시스템에 의해 신속하게 처리되었습니다)' });
  removeAllAiFactionsFromCurrentRoom({ emitPlayerLeft: true });

  let respawnedCount = 0;
  for (let aiIndex = 0; aiIndex < AI_CONFIG.count; aiIndex++) {
    const aiPlayer = spawnAIPlayer(aiIndex);
    if (!aiPlayer) continue;
    respawnedCount++;
    io.to(roomId).emit('playerJoined', aiPlayer);
  }

  syncSlbmId();
  console.log(`Reset ${respawnedCount} AI faction(s) in room ${roomId}`);
  return respawnedCount;
}

// Initialize AI players
function initializeAIPlayers() {
  let spawnedCount = 0;
  for (let i = 0; i < AI_CONFIG.count; i++) {
    if (gameState.players.has(getAIUserId(i))) {
      continue;
    }
    const aiPlayer = spawnAIPlayer(i);
    if (aiPlayer) {
      spawnedCount++;
    }
  }
  return spawnedCount;
}

// AI decision making
function updateAI() {
  const now = Date.now();
  
  gameState.players.forEach((player, playerId) => {
    if (!player.isAI || !player.hasBase) return;
    
    // Count AI's units and buildings
    const aiUnits = [];
    const aiWorkers = [];
    const aiCombatUnits = [];
    const aiBuildings = [];
    let hasShipyard = false;
    let hasNavalAcademy = false;
    let hasPowerPlant = false;
    let hasMissileSilo = false;
    let headquartersId = null;
    let shipyardId = null;
    let navalAcademyId = null;
    let missileSiloId = null;
    let powerPlantCount = 0;
    let shipyardCount = 0;
    let defenseCount = 0;
    
    gameState.units.forEach(unit => {
      if (unit.userId === playerId) {
        aiUnits.push(unit);
        if (unit.type === 'worker') {
          aiWorkers.push(unit);
        } else {
          aiCombatUnits.push(unit);
        }
      }
    });
    
    gameState.buildings.forEach(building => {
      if (building.userId === playerId && building.buildProgress >= 100) {
        aiBuildings.push(building);
        if (building.type === 'shipyard') {
          hasShipyard = true;
          shipyardId = building.id;
          shipyardCount++;
        }
        if (building.type === 'naval_academy') {
          hasNavalAcademy = true;
          navalAcademyId = building.id;
        }
        if (building.type === 'power_plant') {
          hasPowerPlant = true;
          powerPlantCount++;
        }
        if (building.type === 'headquarters') headquartersId = building.id;
        if (building.type === 'missile_silo') {
          hasMissileSilo = true;
          missileSiloId = building.id;
        }
        if (building.type === 'defense_tower') defenseCount++;
      }
    });
    
    // Calculate current combat power
    let currentCombatPower = 0;
    aiCombatUnits.forEach(u => {
      currentCombatPower += (AI_CONFIG.combatPower[u.type] || 0);
    });
    
    // Set target combat power if not set
    if (!player.targetCombatPower) {
      player.targetCombatPower = 300 + Math.floor(Math.random() * 401); // 300-700
    }
    
    // --- DEVELOPMENT: Build structures ---
    if (aiWorkers.length > 0) {
      const idleWorker = aiWorkers.find(w => !w.buildingType && !w.gatheringResourceId && !w.targetX);
      
      if (idleWorker && player.resources > 150) {
        let buildType = null;
        let buildCost = 0;
        
        if (!hasPowerPlant && player.resources >= 150) {
          buildType = 'power_plant';
          buildCost = 150;
        } else if (!hasShipyard && player.resources >= 200) {
          buildType = 'shipyard';
          buildCost = 200;
        } else if (!hasNavalAcademy && player.resources >= 300) {
          buildType = 'naval_academy';
          buildCost = 300;
        } else if (powerPlantCount < 3 && player.resources >= 150) {
          buildType = 'power_plant';
          buildCost = 150;
        } else if (!hasMissileSilo && player.resources >= MISSILE_SILO_COST) {
          buildType = 'missile_silo';
          buildCost = MISSILE_SILO_COST;
        } else if (defenseCount < 3 && player.resources >= 250) {
          buildType = 'defense_tower';
          buildCost = 250;
        } else if (player.resources >= 300 && Math.random() < 0.2) {
          // Random extra building
          const extras = ['power_plant', 'defense_tower', 'naval_academy'];
          buildType = extras[Math.floor(Math.random() * extras.length)];
          buildCost = buildType === 'power_plant' ? 150 : buildType === 'defense_tower' ? 250 : 300;
        }
        
        if (buildType && player.resources >= buildCost) {
          const angle = Math.random() * Math.PI * 2;
          const distance = 300 + Math.random() * 200;
          const buildX = player.baseX + Math.cos(angle) * distance;
          const buildY = player.baseY + Math.sin(angle) * distance;
          
          if (isOnLand(buildX, buildY)) {
            idleWorker.buildingType = buildType;
            idleWorker.buildTargetX = buildX;
            idleWorker.buildTargetY = buildY;
            idleWorker.targetX = buildX;
            idleWorker.targetY = buildY;
            idleWorker.gatheringResourceId = null;
          }
        }
      }
      
      // Assign idle workers to gather resources
      aiWorkers.forEach(worker => {
        if (!worker.gatheringResourceId && !worker.buildingType && !worker.targetX) {
          let nearestResource = null;
          let nearestDist = Infinity;
          
          gameState.map.resources.forEach(resource => {
            if (resource.amount > 0) {
              const dx = resource.x - worker.x;
              const dy = resource.y - worker.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < nearestDist) {
                nearestDist = dist;
                nearestResource = resource;
              }
            }
          });
          
          if (nearestResource && nearestDist < 2000) {
            worker.gatheringResourceId = nearestResource.id;
            worker.targetX = nearestResource.x;
            worker.targetY = nearestResource.y;
          }
        }
      });
    }
    
    // --- DEVELOPMENT: Build units ---
    // Build workers if needed (more workers for economy)
    if (aiWorkers.length < 8 && headquartersId && player.resources >= 50 && player.population < player.maxPopulation) {
      buildUnitForAI(playerId, headquartersId, 'worker');
    }
    
    // --- ARMY COMPOSITION: Build towards target combat power ---
    if (currentCombatPower < player.targetCombatPower) {
      // Decide what to build based on what we can afford and need
      if (hasShipyard && player.population + 1 <= player.maxPopulation) {
        // Weighted random unit choice from shipyard
        const roll = Math.random();
        if (roll < 0.30 && player.resources >= 120) {
          buildUnitForAI(playerId, shipyardId, 'frigate');
        } else if (roll < 0.65 && player.resources >= 150) {
          buildUnitForAI(playerId, shipyardId, 'destroyer');
        } else if (player.resources >= 300) {
          buildUnitForAI(playerId, shipyardId, 'cruiser');
        }
      }
      
      if (hasNavalAcademy && player.population + 4 <= player.maxPopulation) {
        const roll = Math.random();
        if (roll < 0.35 && player.resources >= 600) {
          buildUnitForAI(playerId, navalAcademyId, 'battleship');
        } else if (roll < 0.55 && player.resources >= 800) {
          buildUnitForAI(playerId, navalAcademyId, 'carrier');
        } else if (roll < 0.70 && player.resources >= 900) {
          buildUnitForAI(playerId, navalAcademyId, 'submarine');
        }
      }
    }
    
    // When target reached, set a new higher target
    if (currentCombatPower >= player.targetCombatPower) {
      player.targetCombatPower = currentCombatPower + 100 + Math.floor(Math.random() * 200);
    }
    
    // --- AI SLBM ---
    if (hasMissileSilo && player.resources >= 1500 && (!player.missiles || player.missiles < 3)) {
      const silo = gameState.buildings.get(missileSiloId);
      if (silo) {
        if (!silo.missileQueue) silo.missileQueue = [];
        if (silo.missileQueue.length < 10) {
          player.resources -= 1500;
          silo.missileQueue.push({
            type: 'missile',
            buildTime: 45000,
            userId: playerId,
            socketId: null
          });
          if (!silo.missileProducing) {
            const next = silo.missileQueue[0];
            silo.missileProducing = {
              type: next.type,
              startTime: now,
              buildTime: next.buildTime,
              userId: next.userId,
              socketId: next.socketId
            };
          }
        }
      }
    }
    
    // AI fires SLBM from submarines when it has missiles and knows enemy positions
    if (player.missiles > 0 && player.knownEnemyPositions && player.knownEnemyPositions.length > 0) {
      const aiSubs = aiCombatUnits.filter(u => u.type === 'submarine');
      if (aiSubs.length > 0 && Math.random() < 0.3) {
        const sub = aiSubs[0];
        const target = player.knownEnemyPositions[Math.floor(Math.random() * player.knownEnemyPositions.length)];
        player.missiles--;
        sub.isDetected = true;
        const clampedTarget = clampToMapBounds(target.x, target.y);
        
        const slbmId = nextSlbmId++;
        const slbm = {
          id: slbmId,
          fromX: sub.x, fromY: sub.y,
          targetX: clampedTarget.x, targetY: clampedTarget.y,
          currentX: sub.x, currentY: sub.y,
          startTime: now,
          flightTime: 5000,
          hp: SLBM_MAX_HP, maxHp: SLBM_MAX_HP,
          userId: playerId,
          firingSubId: sub.id,
          damageAccumulator: 0,
          damageWindowStart: now
        };
        gameState.activeSlbms.set(slbmId, slbm);
        
        roomEmit('slbmFired', {
          id: slbmId,
          fromX: sub.x, fromY: sub.y,
          targetX: clampedTarget.x, targetY: clampedTarget.y,
          userId: playerId
        });
        console.log(`AI ${player.username} fired SLBM at (${target.x.toFixed(0)}, ${target.y.toFixed(0)})`);
      }
    }
    
    // --- AI CARRIER: Produce and deploy aircraft ---
    const aiCarriers = aiCombatUnits.filter(u => u.type === 'carrier');
    aiCarriers.forEach(carrier => {
      if (!carrier.aircraft) carrier.aircraft = [];
      if (!carrier.aircraftDeployed) carrier.aircraftDeployed = [];
      const totalAc = carrier.aircraft.length + carrier.aircraftDeployed.length;
      if (totalAc < 10 && player.resources >= 100) {
        player.resources -= 100;
        carrier.aircraft.push({ hp: getUnitDefinition('aircraft').hp });
      }
    });
    
    // --- AI AIMED SHOT: Battleships use aimed shot when off cooldown ---
    const aiBattleships = aiCombatUnits.filter(u => u.type === 'battleship');
    aiBattleships.forEach(bs => {
      if (!bs.aimedShot && (!bs.aimedShotCooldownUntil || now >= bs.aimedShotCooldownUntil)) {
        if (bs.attackTargetId) {
          bs.aimedShot = true;
        }
      }
    });
    
    // --- SCOUTING: Send workers to scout all islands ---
    if (!player.scoutedIslands) player.scoutedIslands = new Set();
    if (!player.knownEnemyPositions) player.knownEnemyPositions = [];
    if (!player.lastScoutTime) player.lastScoutTime = 0;
    
    if (now - player.lastScoutTime > AI_CONFIG.scoutInterval) {
      player.lastScoutTime = now;
      
      // Get all island centers by analyzing landCells clusters
      const islandCenters = getIslandCenters();
      
      // Send idle workers to unscouted islands
      const unscoutedIslands = islandCenters.filter((_, idx) => !player.scoutedIslands.has(idx));
      
      if (unscoutedIslands.length > 0 && aiWorkers.length > 1) {
        // Find an idle worker (not building, not gathering)
        const scoutWorker = aiWorkers.find(w => !w.buildingType && !w.gatheringResourceId && !w.targetX);
        if (scoutWorker) {
          const targetIsland = unscoutedIslands[Math.floor(Math.random() * unscoutedIslands.length)];
          assignMoveTarget(scoutWorker, targetIsland.x, targetIsland.y);
          // Mark as scouted
          const idx = islandCenters.indexOf(targetIsland);
          if (idx >= 0) player.scoutedIslands.add(idx);
        }
      }
      
      // Also send idle combat units to scout
      const scoutCombat = aiCombatUnits.find(u => !u.targetX && !u.attackTargetId);
      if (scoutCombat && unscoutedIslands.length > 0) {
        const targetIsland = unscoutedIslands[Math.floor(Math.random() * unscoutedIslands.length)];
        assignMoveTarget(scoutCombat, targetIsland.x, targetIsland.y);
        const idx = islandCenters.indexOf(targetIsland);
        if (idx >= 0) player.scoutedIslands.add(idx);
      }
      
      // Discover enemies: check if any AI unit sees enemy units/buildings
      gameState.players.forEach((otherPlayer, otherId) => {
        if (otherId === playerId) return;
        
        // Check enemy buildings
        gameState.buildings.forEach(building => {
          if (building.userId === otherId) {
            aiUnits.forEach(unit => {
              const dx = building.x - unit.x;
              const dy = building.y - unit.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 1200) {
                // Found enemy! Record position
                const existing = player.knownEnemyPositions.find(p => {
                  const edx = p.x - building.x;
                  const edy = p.y - building.y;
                  return Math.sqrt(edx * edx + edy * edy) < 500;
                });
                if (!existing) {
                  player.knownEnemyPositions.push({ x: building.x, y: building.y, playerId: otherId, discoveredAt: now });
                  console.log(`AI ${player.username} discovered enemy ${otherPlayer.username || otherId} at (${building.x.toFixed(0)}, ${building.y.toFixed(0)})`);
                }
                // Also update knownEnemyBases for SLBM targeting
                if (!player.knownEnemyBases) player.knownEnemyBases = [];
                if (!player.knownEnemyBases.includes(otherId)) {
                  player.knownEnemyBases.push(otherId);
                }
              }
            });
          }
        });
        
        // Check enemy units
        gameState.units.forEach(enemyUnit => {
          if (enemyUnit.userId === otherId) {
            aiUnits.forEach(unit => {
              const dx = enemyUnit.x - unit.x;
              const dy = enemyUnit.y - unit.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 1000) {
                const existing = player.knownEnemyPositions.find(p => {
                  const edx = p.x - enemyUnit.x;
                  const edy = p.y - enemyUnit.y;
                  return Math.sqrt(edx * edx + edy * edy) < 500;
                });
                if (!existing) {
                  player.knownEnemyPositions.push({ x: enemyUnit.x, y: enemyUnit.y, playerId: otherId, discoveredAt: now });
                }
              }
            });
          }
        });
      });
      
      // Clean up old enemy positions (older than 120 seconds)
      player.knownEnemyPositions = player.knownEnemyPositions.filter(p => now - p.discoveredAt < 120000);
    }
    
    // --- COUNTERATTACK DETECTION: Check if AI units were attacked by 3+ enemies ---
    if (!player.recentAttackLocations) player.recentAttackLocations = [];
    if (!player.priorityTargets) player.priorityTargets = [];
    
    // Clean up old attack locations
    player.recentAttackLocations = player.recentAttackLocations.filter(
      loc => now - loc.timestamp < AI_CONFIG.attackerTrackingDuration
    );
    
    // Also clean up recentAttackers on AI units
    aiUnits.forEach(unit => {
      if (unit.recentAttackers) {
        unit.recentAttackers = unit.recentAttackers.filter(
          att => now - att.timestamp < AI_CONFIG.attackerTrackingDuration
        );
      }
    });
    
    // Count unique attackers across all AI units
    const recentAttackerSet = new Set();
    let attackCenterX = 0, attackCenterY = 0, attackCount = 0;
    
    aiUnits.forEach(unit => {
      if (unit.recentAttackers && unit.recentAttackers.length > 0) {
        unit.recentAttackers.forEach(att => {
          if (!recentAttackerSet.has(att.attackerId)) {
            recentAttackerSet.add(att.attackerId);
            attackCenterX += att.attackX;
            attackCenterY += att.attackY;
            attackCount++;
          }
        });
      }
    });
    
    // Trigger counterattack response if 3+ unique attackers detected
    if (recentAttackerSet.size >= AI_CONFIG.counterattackThreshold && !player.isCounterattacking) {
      attackCenterX /= attackCount;
      attackCenterY /= attackCount;
      
      console.log(`AI ${player.username} detected ${recentAttackerSet.size} attackers at (${attackCenterX.toFixed(0)}, ${attackCenterY.toFixed(0)}) - initiating counterattack!`);
      
      // Find the closest island from the attack location
      const islandCenters = getIslandCenters();
      let closestIsland = null;
      let closestIslandDist = Infinity;
      let closestIslandIdx = -1;
      
      islandCenters.forEach((island, idx) => {
        const dx = island.x - attackCenterX;
        const dy = island.y - attackCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < closestIslandDist) {
          closestIslandDist = dist;
          closestIsland = island;
          closestIslandIdx = idx;
        }
      });
      
      if (closestIsland) {
        // Check if there's enemy presence on this island
        let hasEnemyPresence = false;
        let enemyOnIsland = null;
        
        // Check for enemy buildings near this island
        gameState.buildings.forEach(building => {
          if (building.userId !== playerId && !gameState.players.get(building.userId)?.isAI || 
              (gameState.players.get(building.userId)?.isAI && building.userId !== playerId)) {
            const dx = building.x - closestIsland.x;
            const dy = building.y - closestIsland.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1500) {
              hasEnemyPresence = true;
              enemyOnIsland = { x: building.x, y: building.y, playerId: building.userId };
            }
          }
        });
        
        // Check for enemy units near this island
        if (!hasEnemyPresence) {
          gameState.units.forEach(unit => {
            if (unit.userId !== playerId) {
              const dx = unit.x - closestIsland.x;
              const dy = unit.y - closestIsland.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 1500) {
                hasEnemyPresence = true;
                enemyOnIsland = { x: unit.x, y: unit.y, playerId: unit.userId };
              }
            }
          });
        }
        
        if (hasEnemyPresence) {
          // Found enemy on closest island - add to priority targets
          const existingTarget = player.priorityTargets.find(t => {
            const dx = t.x - enemyOnIsland.x;
            const dy = t.y - enemyOnIsland.y;
            return Math.sqrt(dx * dx + dy * dy) < 500;
          });
          
          if (!existingTarget) {
            player.priorityTargets.push({
              x: enemyOnIsland.x,
              y: enemyOnIsland.y,
              playerId: enemyOnIsland.playerId,
              discoveredAt: now,
              priority: player.priorityTargets.length // First discovered = highest priority
            });
            console.log(`AI ${player.username} added priority target at (${enemyOnIsland.x.toFixed(0)}, ${enemyOnIsland.y.toFixed(0)})`);
          }
          
          player.isCounterattacking = true;
          player.counterattackTarget = { x: enemyOnIsland.x, y: enemyOnIsland.y, playerId: enemyOnIsland.playerId };
        } else {
          // No enemy on closest island - search next closest islands
          console.log(`AI ${player.username} found no enemies on closest island, searching nearby...`);
          
          // Sort islands by distance and find one with enemy presence
          const sortedIslands = islandCenters
            .map((island, idx) => {
              const dx = island.x - attackCenterX;
              const dy = island.y - attackCenterY;
              return { ...island, idx, dist: Math.sqrt(dx * dx + dy * dy) };
            })
            .sort((a, b) => a.dist - b.dist);
          
          for (const island of sortedIslands) {
            if (island.idx === closestIslandIdx) continue; // Skip already checked
            
            let foundEnemy = null;
            
            // Check buildings
            gameState.buildings.forEach(building => {
              if (building.userId !== playerId) {
                const dx = building.x - island.x;
                const dy = building.y - island.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 1500 && !foundEnemy) {
                  foundEnemy = { x: building.x, y: building.y, playerId: building.userId };
                }
              }
            });
            
            // Check units
            if (!foundEnemy) {
              gameState.units.forEach(unit => {
                if (unit.userId !== playerId) {
                  const dx = unit.x - island.x;
                  const dy = unit.y - island.y;
                  const dist = Math.sqrt(dx * dx + dy * dy);
                  if (dist < 1500 && !foundEnemy) {
                    foundEnemy = { x: unit.x, y: unit.y, playerId: unit.userId };
                  }
                }
              });
            }
            
            if (foundEnemy) {
              // Found enemy on this island
              const existingTarget = player.priorityTargets.find(t => {
                const dx = t.x - foundEnemy.x;
                const dy = t.y - foundEnemy.y;
                return Math.sqrt(dx * dx + dy * dy) < 500;
              });
              
              if (!existingTarget) {
                player.priorityTargets.push({
                  x: foundEnemy.x,
                  y: foundEnemy.y,
                  playerId: foundEnemy.playerId,
                  discoveredAt: now,
                  priority: player.priorityTargets.length
                });
                console.log(`AI ${player.username} added priority target at (${foundEnemy.x.toFixed(0)}, ${foundEnemy.y.toFixed(0)}) (re-search)`);
              }
              
              player.isCounterattacking = true;
              player.counterattackTarget = { x: foundEnemy.x, y: foundEnemy.y, playerId: foundEnemy.playerId };
              break;
            }
          }
        }
      }
    }
    
    // --- PRIORITY TARGET ATTACK: Continue raiding priority targets ---
    // Check if current counterattack target is eliminated
    if (player.isCounterattacking && player.counterattackTarget) {
      const targetPlayerId = player.counterattackTarget.playerId;
      const targetX = player.counterattackTarget.x;
      const targetY = player.counterattackTarget.y;
      
      // Check if target area still has enemy presence
      let targetStillExists = false;
      
      gameState.buildings.forEach(building => {
        if (building.userId === targetPlayerId) {
          const dx = building.x - targetX;
          const dy = building.y - targetY;
          if (Math.sqrt(dx * dx + dy * dy) < 1500) {
            targetStillExists = true;
          }
        }
      });
      
      if (!targetStillExists) {
        gameState.units.forEach(unit => {
          if (unit.userId === targetPlayerId) {
            const dx = unit.x - targetX;
            const dy = unit.y - targetY;
            if (Math.sqrt(dx * dx + dy * dy) < 1500) {
              targetStillExists = true;
            }
          }
        });
      }
      
      if (!targetStillExists) {
        console.log(`AI ${player.username} eliminated target at (${targetX.toFixed(0)}, ${targetY.toFixed(0)})`);
        
        // Remove from priority targets
        player.priorityTargets = player.priorityTargets.filter(t => {
          const dx = t.x - targetX;
          const dy = t.y - targetY;
          return Math.sqrt(dx * dx + dy * dy) >= 500;
        });
        
        // Move to next priority target if available
        if (player.priorityTargets.length > 0) {
          // Sort by priority (lowest = highest priority)
          player.priorityTargets.sort((a, b) => a.priority - b.priority);
          const nextTarget = player.priorityTargets[0];
          player.counterattackTarget = { x: nextTarget.x, y: nextTarget.y, playerId: nextTarget.playerId };
          console.log(`AI ${player.username} moving to next priority target at (${nextTarget.x.toFixed(0)}, ${nextTarget.y.toFixed(0)})`);
        } else {
          player.isCounterattacking = false;
          player.counterattackTarget = null;
          console.log(`AI ${player.username} counterattack completed - all priority targets eliminated`);
        }
      }
    }
    
    // --- Discovery during combat: Add newly found buildings to priority targets ---
    aiUnits.forEach(unit => {
      gameState.buildings.forEach(building => {
        if (building.userId !== playerId && building.userId > 0) { // Enemy player building (not AI)
          const dx = building.x - unit.x;
          const dy = building.y - unit.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          
          if (dist < 1200) {
            // Check if already in priority targets
            const existing = player.priorityTargets.find(t => {
              const edx = t.x - building.x;
              const edy = t.y - building.y;
              return Math.sqrt(edx * edx + edy * edy) < 500;
            });
            
            if (!existing) {
              player.priorityTargets.push({
                x: building.x,
                y: building.y,
                playerId: building.userId,
                discoveredAt: now,
                priority: player.priorityTargets.length
              });
              console.log(`AI ${player.username} discovered enemy building at (${building.x.toFixed(0)}, ${building.y.toFixed(0)}) - added to priority targets`);
              
              // If not already counterattacking, start
              if (!player.isCounterattacking) {
                player.isCounterattacking = true;
                player.counterattackTarget = { x: building.x, y: building.y, playerId: building.userId };
              }
            }
          }
        }
      });
    });
    
    // --- ATTACK: Send army when we have enough combat power ---
    // Priority targets take precedence over regular attacks
    if (!player.lastAttackTime) player.lastAttackTime = 0;
    
    const canAttack = currentCombatPower >= Math.min(player.targetCombatPower * 0.6, 150);
    const hasPriorityTargets = player.priorityTargets && player.priorityTargets.length > 0;
    const hasTargets = (player.knownEnemyPositions && player.knownEnemyPositions.length > 0) || hasPriorityTargets;
    const attackCooldown = now - player.lastAttackTime > 20000; // 20 second cooldown between attacks
    // Shorter cooldown for counterattacks (immediate response)
    const counterattackCooldown = now - player.lastAttackTime > 5000;
    
    // Counterattack with priority targets (immediate, less strict requirements)
    if (player.isCounterattacking && player.counterattackTarget && counterattackCooldown && aiCombatUnits.length >= 1) {
      player.lastAttackTime = now;
      const target = player.counterattackTarget;
      
      console.log(`AI ${player.username} counterattacking at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}) with ${aiCombatUnits.length} units (COUNTERATTACK)`);
      
      // Send ALL combat units to counterattack position
      aiCombatUnits.forEach(unit => {
        assignMoveTarget(unit, target.x, target.y);
        unit.attackMove = true;
        
        // Find nearest enemy entity at target area to focus fire
        let nearestTarget = null;
        let nearestDist = Infinity;
        
        gameState.buildings.forEach(building => {
          if (building.userId === target.playerId) {
            const dx = building.x - target.x;
            const dy = building.y - target.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 2000 && dist < nearestDist) {
              nearestDist = dist;
              nearestTarget = { id: building.id, type: 'building' };
            }
          }
        });
        
        if (!nearestTarget) {
          gameState.units.forEach(enemyUnit => {
            if (enemyUnit.userId === target.playerId) {
              const dx = enemyUnit.x - target.x;
              const dy = enemyUnit.y - target.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 2000 && dist < nearestDist) {
                nearestDist = dist;
                nearestTarget = { id: enemyUnit.id, type: 'unit' };
              }
            }
          });
        }
        
        if (nearestTarget) {
          unit.attackTargetId = nearestTarget.id;
          unit.attackTargetType = nearestTarget.type;
        }
      });
    } else if (canAttack && hasTargets && attackCooldown && aiCombatUnits.length >= 3 && !player.isCounterattacking) {
      // Normal attack behavior (when not counterattacking)
      player.lastAttackTime = now;
      
      // Pick a target position (preferring most recent discovery)
      const sortedTargets = [...player.knownEnemyPositions].sort((a, b) => b.discoveredAt - a.discoveredAt);
      const target = sortedTargets[0];
      
      console.log(`AI ${player.username} attacking at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}) with ${aiCombatUnits.length} units (power: ${currentCombatPower})`);
      
      // Send ALL idle combat units to the attack position
      aiCombatUnits.forEach(unit => {
        // Send to attack position with attack-move
        assignMoveTarget(unit, target.x, target.y);
        unit.attackMove = true;
        
        // Find nearest enemy entity at target area to focus fire
        let nearestTarget = null;
        let nearestDist = Infinity;
        
        gameState.buildings.forEach(building => {
          if (building.userId === target.playerId) {
            const dx = building.x - target.x;
            const dy = building.y - target.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 2000 && dist < nearestDist) {
              nearestDist = dist;
              nearestTarget = { id: building.id, type: 'building' };
            }
          }
        });
        
        if (!nearestTarget) {
          gameState.units.forEach(enemyUnit => {
            if (enemyUnit.userId === target.playerId) {
              const dx = enemyUnit.x - target.x;
              const dy = enemyUnit.y - target.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 2000 && dist < nearestDist) {
                nearestDist = dist;
                nearestTarget = { id: enemyUnit.id, type: 'unit' };
              }
            }
          });
        }
        
        if (nearestTarget) {
          unit.attackTargetId = nearestTarget.id;
          unit.attackTargetType = nearestTarget.type;
        }
      });
    }
    
    // --- BASE EXPANSION: when 10+ buildings on main island, expand ---
    if (aiBuildings.length >= AI_CONFIG.expansionBuildingThreshold && !player.isExpanding) {
      const islandCenters = getIslandCenters();
      
      // Find closest island that we don't have buildings on
      const ownBuildingPositions = aiBuildings.map(b => ({ x: b.x, y: b.y }));
      
      let bestIsland = null;
      let bestDist = Infinity;
      
      islandCenters.forEach(island => {
        // Check if we already have buildings on this island (within 1500 units)
        const hasBuilding = ownBuildingPositions.some(bp => {
          const dx = bp.x - island.x;
          const dy = bp.y - island.y;
          return Math.sqrt(dx * dx + dy * dy) < 1500;
        });
        
        if (!hasBuilding) {
          const dx = player.baseX - island.x;
          const dy = player.baseY - island.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestIsland = island;
          }
        }
      });
      
      if (bestIsland) {
        player.isExpanding = true;
        player.expansionTarget = { x: bestIsland.x, y: bestIsland.y };
        player.expansionBuilt = [];
        console.log(`AI ${player.username} expanding to island at (${bestIsland.x.toFixed(0)}, ${bestIsland.y.toFixed(0)})`);
      }
    }
    
    // Process expansion: send workers to build on the new island
    if (player.isExpanding && player.expansionTarget) {
      const expansionBuildings = ['power_plant', 'shipyard', 'missile_silo', 'defense_tower'];
      if (!player.expansionBuilt) player.expansionBuilt = [];
      
      const nextBuild = expansionBuildings.find(bt => !player.expansionBuilt.includes(bt));
      
      if (nextBuild) {
        // Find an idle worker
        const expandWorker = aiWorkers.find(w => !w.buildingType && !w.targetX);
        if (expandWorker) {
          const costs = { power_plant: 150, shipyard: 200, missile_silo: MISSILE_SILO_COST, defense_tower: 250 };
          const cost = costs[nextBuild] || 200;
          
          if (player.resources >= cost) {
            const angle = Math.random() * Math.PI * 2;
            const distance = 100 + Math.random() * 200;
            const buildX = player.expansionTarget.x + Math.cos(angle) * distance;
            const buildY = player.expansionTarget.y + Math.sin(angle) * distance;
            
            if (isOnLand(buildX, buildY)) {
              expandWorker.buildingType = nextBuild;
              expandWorker.buildTargetX = buildX;
              expandWorker.buildTargetY = buildY;
              expandWorker.targetX = buildX;
              expandWorker.targetY = buildY;
              expandWorker.gatheringResourceId = null;
              player.expansionBuilt.push(nextBuild);
            }
          }
        }
      } else {
        // All expansion buildings queued
        player.isExpanding = false;
        player.expansionTarget = null;
        console.log(`AI ${player.username} expansion complete`);
      }
    }
    
    // Combat is processed in the global updateGame() loop for all players (including AI).
  });
}

// Get island centers by clustering land cells
function getIslandCenters() {
  if (!gameState || !gameState.map || !gameState.map.landCells) return [];
  
  // Cache island centers per room
  if (gameState._islandCenters) return gameState._islandCenters;
  
  const map = gameState.map;
  const cellSize = map.cellSize;
  const gridSize = map.gridSize;
  const visited = new Set();
  const islands = [];
  
  // BFS to find connected components (islands)
  for (const [gx, gy] of map.landCells) {
    const key = gy * gridSize + gx;
    if (visited.has(key)) continue;
    
    const island = [];
    const queue = [[gx, gy]];
    visited.add(key);
    
    while (queue.length > 0) {
      const [cx, cy] = queue.shift();
      island.push([cx, cy]);
      
      // Check 4-connected neighbors
      const neighbors = [[cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]];
      for (const [nx, ny] of neighbors) {
        if (nx >= 0 && nx < gridSize && ny >= 0 && ny < gridSize) {
          const nkey = ny * gridSize + nx;
          if (!visited.has(nkey) && map.landCellSet.has(nkey)) {
            visited.add(nkey);
            queue.push([nx, ny]);
          }
        }
      }
    }
    
    // Calculate island center
    if (island.length > 10) { // Skip tiny islands
      let sumX = 0, sumY = 0;
      island.forEach(([ix, iy]) => {
        sumX += ix * cellSize + cellSize / 2;
        sumY += iy * cellSize + cellSize / 2;
      });
      islands.push({ x: sumX / island.length, y: sumY / island.length, size: island.length });
    }
  }
  
  gameState._islandCenters = islands;
  return islands;
}

// Build unit for AI (uses production queue like players)
function buildUnitForAI(userId, buildingId, unitType) {
  const building = gameState.buildings.get(buildingId);
  const player = gameState.players.get(userId);
  
  if (!building || building.userId !== userId || !player) return false;
  if (!Object.prototype.hasOwnProperty.call(UNIT_DEFINITIONS, unitType)) return false;
  if (building.buildProgress < 100) return false;

  // Building type restrictions for AI
  if (unitType === 'worker' && building.type !== 'headquarters') return false;
  if ((unitType === 'destroyer' || unitType === 'cruiser' || unitType === 'frigate') && building.type !== 'shipyard') return false;
  if ((unitType === 'battleship' || unitType === 'carrier' || unitType === 'submarine') && building.type !== 'naval_academy') return false;

  // Initialize queue
  if (!building.productionQueue) building.productionQueue = [];
  if (building.productionQueue.length >= 10) return false;

  const unitConfig = getUnitDefinition(unitType);
  
  if (player.resources >= unitConfig.cost && player.population + unitConfig.pop <= player.maxPopulation) {
    player.resources -= unitConfig.cost;
    player.population += unitConfig.pop;
    
    building.productionQueue.push({
      unitType: unitType,
      buildTime: unitConfig.buildTime,
      userId: userId
    });
    
    if (!building.producing) {
      const next = building.productionQueue[0];
      building.producing = { unitType: next.unitType, startTime: Date.now(), buildTime: next.buildTime, userId: next.userId };
    }
    
    return true;
  }
  
  return false;
}

// Run AI update loop - only for rooms with connected humans
setInterval(() => {
  gameRooms.forEach((room, roomId) => {
    if (!roomHasHumanPlayers(roomId)) return;
    switchRoom(roomId);
    updateAI();
    syncSlbmId();
  });
}, AI_CONFIG.updateInterval);

// ==================== END AI PLAYER SYSTEM ====================

if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET is not set. Using insecure fallback secret.');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} server running on port ${PORT}`);
});

