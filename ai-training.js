/**
 * ai-training.js — Reinforcement Learning module for MW Craft AI
 *
 * Q-learning based system with:
 * - State discretization (resources, units, buildings, combat power ratio)
 * - Action space (build/produce/attack/defend/skill decisions)
 * - Experience replay + epsilon-greedy policy
 * - Training via accelerated headless game simulation
 * - Difficulty tiers (Easy/Normal/Hard/Expert)
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

const EXTERNAL_WEIGHTS_URLS = Object.freeze({
  hard: process.env.MW_RL_WEIGHTS_HARD_URL || 'https://drive.google.com/uc?export=download&id=19iFoCr5N69GBYFJR5RuRLJLr2lPQfTNt',
  expert: process.env.MW_RL_WEIGHTS_EXPERT_URL || 'https://drive.google.com/uc?export=download&id=1f38P1dYPT-F9MpGTPuqL2EgssWuasJkU'
});
const weightsDownloadPromises = new Map();

function getWeightsPaths(difficulty) {
  const jsonPath = path.join(__dirname, `ai-weights-${difficulty}.json`);
  return {
    jsonPath,
    gzipPath: `${jsonPath}.gz`
  };
}

function getExternalWeightsUrl(difficulty) {
  return EXTERNAL_WEIGHTS_URLS[difficulty] || null;
}

function hasCachedWeights(difficulty) {
  const paths = getWeightsPaths(difficulty);
  return fs.existsSync(paths.jsonPath) || fs.existsSync(paths.gzipPath);
}

function mergeCookieHeader(existingHeader, setCookieHeaders) {
  const cookieMap = new Map();
  if (existingHeader) {
    for (const part of String(existingHeader).split(/;\s*/)) {
      const eqIndex = part.indexOf('=');
      if (eqIndex <= 0) continue;
      cookieMap.set(part.slice(0, eqIndex), part);
    }
  }
  const headers = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : (setCookieHeaders ? [setCookieHeaders] : []);
  for (const rawHeader of headers) {
    const pair = String(rawHeader).split(';')[0].trim();
    const eqIndex = pair.indexOf('=');
    if (eqIndex <= 0) continue;
    cookieMap.set(pair.slice(0, eqIndex), pair);
  }
  return Array.from(cookieMap.values()).join('; ');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, '\'')
    .replace(/&quot;/g, '"');
}

function decodeGoogleDriveEscapedUrl(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002f/g, '/')
    .replace(/\\\//g, '/');
}

function isGoogleDriveUrl(url) {
  return /drive\.google\.com|drive\.usercontent\.google\.com/.test(String(url || ''));
}

function extractHtmlAttribute(tag, attrName) {
  const match = String(tag || '').match(new RegExp(`${attrName}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match ? decodeHtmlEntities(match[2]) : null;
}

function extractGoogleDriveDownloadUrl(html, currentUrl) {
  const downloadUrlMatch = html.match(/"downloadUrl":"([^"]+)"/i);
  if (downloadUrlMatch) {
    return decodeGoogleDriveEscapedUrl(downloadUrlMatch[1]);
  }

  const hrefMatch = html.match(/href\s*=\s*(['"])(\/[^'"]*export=download[^'"]*|https?:\/\/[^'"]*(?:export=download|drive\.usercontent\.google\.com\/download)[^'"]*)\1/i);
  if (hrefMatch) {
    return new URL(decodeGoogleDriveEscapedUrl(hrefMatch[2]), currentUrl).toString();
  }

  const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let formMatch;
  while ((formMatch = formRegex.exec(html)) !== null) {
    const formAttrs = formMatch[1] || '';
    const formBody = formMatch[2] || '';
    const action = extractHtmlAttribute(formAttrs, 'action');
    if (!action) continue;
    const actionUrl = new URL(decodeGoogleDriveEscapedUrl(action), currentUrl);
    const actionText = actionUrl.toString();
    if (!/export=download|drive\.usercontent\.google\.com\/download/i.test(actionText)) {
      continue;
    }

    const inputRegex = /<input\b([^>]*)>/gi;
    let inputMatch;
    while ((inputMatch = inputRegex.exec(formBody)) !== null) {
      const inputAttrs = inputMatch[1] || '';
      const type = (extractHtmlAttribute(inputAttrs, 'type') || '').toLowerCase();
      const name = extractHtmlAttribute(inputAttrs, 'name');
      const value = extractHtmlAttribute(inputAttrs, 'value') || '';
      if (!name) continue;
      if (type && type !== 'hidden') continue;
      actionUrl.searchParams.set(name, value);
    }
    return actionUrl.toString();
  }

  return null;
}

function downloadFileWithRedirects(url, destinationPath, redirectCount = 0, cookieHeader = '') {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('Missing download URL'));
      return;
    }
    if (redirectCount > 5) {
      reject(new Error('Too many redirects while downloading weights'));
      return;
    }
    const client = url.startsWith('https://') ? https : http;
    const requestOptions = new URL(url);
    requestOptions.headers = {
      'User-Agent': 'Mozilla/5.0 MW-Craft-RL/1.0',
      Accept: '*/*'
    };
    if (cookieHeader) {
      requestOptions.headers.Cookie = cookieHeader;
    }
    const request = client.get(requestOptions, (response) => {
      const statusCode = response.statusCode || 0;
      const location = response.headers.location;
      const nextCookieHeader = mergeCookieHeader(cookieHeader, response.headers['set-cookie']);
      if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
        response.resume();
        const nextUrl = new URL(location, url).toString();
        resolve(downloadFileWithRedirects(nextUrl, destinationPath, redirectCount + 1, nextCookieHeader));
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Weight download failed with HTTP ${statusCode}`));
        return;
      }

      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      if (contentType.includes('text/html')) {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < 262144) body += chunk;
        });
        response.on('end', () => {
          if (isGoogleDriveUrl(url)) {
            const nextUrl = extractGoogleDriveDownloadUrl(body, url);
            if (nextUrl) {
              resolve(downloadFileWithRedirects(nextUrl, destinationPath, redirectCount + 1, nextCookieHeader));
              return;
            }
          }
          reject(new Error(`Weight download returned HTML instead of binary: ${body.slice(0, 120)}`));
        });
        return;
      }

      const tempPath = `${destinationPath}.tmp`;
      const output = fs.createWriteStream(tempPath);
      output.on('error', (error) => {
        response.destroy(error);
      });
      response.on('error', (error) => {
        output.destroy(error);
      });
      output.on('finish', () => {
        output.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }
          fs.rename(tempPath, destinationPath, (renameError) => {
            if (renameError) {
              reject(renameError);
              return;
            }
            resolve(destinationPath);
          });
        });
      });
      response.pipe(output);
    });
    request.on('error', reject);
  });
}

async function ensureExternalWeightsCached(difficulty) {
  if (hasCachedWeights(difficulty)) {
    console.log(`[AI-RL][${difficulty}] Using cached local weights file.`);
    return true;
  }
  const downloadUrl = getExternalWeightsUrl(difficulty);
  if (!downloadUrl) {
    return false;
  }
  if (!weightsDownloadPromises.has(difficulty)) {
    const { gzipPath } = getWeightsPaths(difficulty);
    console.log(`[AI-RL][${difficulty}] Downloading weights from external source...`);
    const promise = downloadFileWithRedirects(downloadUrl, gzipPath)
      .then(() => {
        console.log(`[AI-RL][${difficulty}] External weights cached at ${path.basename(gzipPath)}.`);
        return true;
      })
      .finally(() => {
        weightsDownloadPromises.delete(difficulty);
      });
    weightsDownloadPromises.set(difficulty, promise);
  }
  return weightsDownloadPromises.get(difficulty);
}

// ========== STATE ENCODING ==========

// Discretize a continuous value into buckets
function discretize(value, thresholds) {
  for (let i = 0; i < thresholds.length; i++) {
    if (value <= thresholds[i]) return i;
  }
  return thresholds.length;
}

/**
 * Encode the game state for a given AI player into a discrete state key.
 * Returns a bucketized abstract state string shared by live play and offline training.
 */
function encodeState(gameState, playerId) {
  const summary = summarizeLiveGameState(gameState, playerId);
  if (!summary) return 'dead';
  return encodeAbstractState(summary);
}

const COMBAT_POWER_MAP = {
  slbm: 200,
  frigate: 30, destroyer: 150, cruiser: 100,
  battleship: 200, carrier: 180, submarine: 200,
  assaultship: 100, missile_launcher: 100
};

// Unit range tiers (abstracted from actual game values)
// 0=melee/none, 1=short(~750), 2=mid(~1250-2000), 3=long(~2500+)
const UNIT_RANGE_TIER = {
  frigate: 1, destroyer: 2, cruiser: 2,
  battleship: 3, carrier: 3, submarine: 1,
  assaultship: 0, missile_launcher: 3  // launcher deployed = 2500 range
};

// Unit vision tiers (abstracted)
// 0=none, 1=short(~800-1000), 2=mid(~1200-2000), 3=long(~3200+)
const UNIT_VISION_TIER = {
  frigate: 1, destroyer: 1, cruiser: 2,
  battleship: 3, carrier: 3, submarine: 1,
  assaultship: 2, missile_launcher: 1
};

const SUBMARINE_SLBM_CAPACITY = 3;

// ========== ACTION SPACE ==========

const ACTIONS = [
  'build_power_plant',
  'build_shipyard',
  'build_naval_academy',
  'build_missile_silo',
  'build_defense_tower',
  'build_carbase',
  'produce_worker',
  'produce_frigate',
  'produce_destroyer',
  'produce_cruiser',
  'produce_battleship',
  'produce_carrier',
  'produce_submarine',
  'produce_assaultship',
  'produce_missile_launcher',
  'produce_slbm',
  'attack_nearest_enemy',
  'attack_strongest_enemy',
  'defend_base',
  'scout',
  'load_submarine_slbm',
  'use_slbm',
  'use_airstrike',
  'activate_aegis',
  'lay_mines',
  'lure_tactic',
  'expand',
  'save_resources',
  // Skill actions — unit-specific abilities with cooldowns/timing
  'skill_aimed_shot',       // Battleship: 2x damage next attack (16s cd)
  'skill_combat_stance',    // Battleship: +atk speed stacking, costs HP per attack
  'skill_engine_overdrive', // Frigate: +speed, evasion up to 80%, costs HP/tick
  'skill_search',           // Destroyer: 4800-range vision pulse, reveals subs (16s cd)
  'skill_stealth',          // Submarine: 15s invisibility (30s cd)
  // Strategic actions — deploy, transport, amphibious
  'deploy_launchers',       // Deploy mobile launchers (huge range, can't move)
  'undeploy_launchers',     // Undeploy → mobile again
  'load_assault_ship',      // Load missile launchers onto assault ship
  'amphibious_landing',     // Sail assault ship to enemy island, unload + deploy
];

const ACTION_COUNT = ACTIONS.length;

const SIM_TICK_MS = 1000;
const SIM_BUILDING_BUILD_TIME_MS = 10000;
const SIM_MAX_QUEUE_PER_PRODUCER = 10;
const SIM_STARTING_RESOURCES = 1000;
const SIM_STARTING_WORKERS = 4;
const SIM_BASE_POPULATION_CAP = 10;
const SIM_HEADQUARTERS_POPULATION_BONUS = 20;
const SIM_MAX_POPULATION_CAP = 250;
const SIM_STARTING_MAX_POPULATION = Math.min(
  SIM_MAX_POPULATION_CAP,
  SIM_BASE_POPULATION_CAP + SIM_HEADQUARTERS_POPULATION_BONUS
);

const SIM_BUILDING_DEFS = Object.freeze({
  headquarters: { cost: 800, buildTime: 0, popBonus: SIM_HEADQUARTERS_POPULATION_BONUS, completionReward: 2, combatPower: 120 },
  power_plant: { cost: 150, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 3, completionReward: 1, combatPower: 120 },
  shipyard: { cost: 200, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 5, completionReward: 2, combatPower: 120 },
  naval_academy: { cost: 300, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 10, completionReward: 2.5, combatPower: 150 },
  missile_silo: { cost: 1600, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 0, completionReward: 3, combatPower: 150 },
  defense_tower: { cost: 250, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 0, completionReward: 1.5, combatPower: 150 },
  carbase: { cost: 350, buildTime: SIM_BUILDING_BUILD_TIME_MS, popBonus: 0, completionReward: 2.5, combatPower: 150 }
});

const SIM_UNIT_DEFS = Object.freeze({
  worker: { cost: 50, pop: 1, buildTime: 3000, combatPower: 0, producer: 'headquarters', countField: 'workerCount', completionReward: 0.6 },
  frigate: { cost: 120, pop: 1, buildTime: 5000, combatPower: COMBAT_POWER_MAP.frigate, producer: 'shipyard', countField: 'frigateCount', completionReward: 0.8 },
  destroyer: { cost: 150, pop: 2, buildTime: 8000, combatPower: COMBAT_POWER_MAP.destroyer, producer: 'shipyard', countField: 'destroyerCount', completionReward: 1.2 },
  cruiser: { cost: 300, pop: 3, buildTime: 15000, combatPower: COMBAT_POWER_MAP.cruiser, producer: 'shipyard', countField: 'cruiserCount', completionReward: 1.3 },
  battleship: { cost: 2400, pop: 20, buildTime: 70000, combatPower: COMBAT_POWER_MAP.battleship, producer: 'naval_academy', countField: 'battleshipCount', completionReward: 2.8 },
  carrier: { cost: 1600, pop: 12, buildTime: 40000, combatPower: COMBAT_POWER_MAP.carrier, producer: 'naval_academy', countField: 'carrierCount', completionReward: 2.4 },
  assaultship: { cost: 1000, pop: 10, buildTime: 26000, combatPower: COMBAT_POWER_MAP.assaultship, producer: 'naval_academy', countField: 'assaultshipCount', completionReward: 1.8 },
  submarine: { cost: 1800, pop: 8, buildTime: 30000, combatPower: COMBAT_POWER_MAP.submarine, producer: 'naval_academy', countField: 'submarineCount', completionReward: 2.2 },
  missile_launcher: { cost: 2200, pop: 4, buildTime: 18000, combatPower: COMBAT_POWER_MAP.missile_launcher, producer: 'carbase', countField: 'launcherCount', completionReward: 1.9 },
  slbm: { cost: 1500, pop: 0, buildTime: 45000, combatPower: 0, producer: 'missile_silo', countField: null, completionReward: 1.5 }
});

const SIM_PRODUCER_TYPES = Object.freeze(['headquarters', 'shipyard', 'naval_academy', 'carbase', 'missile_silo']);
const SIM_BUILDING_TYPES = Object.freeze(['headquarters', 'power_plant', 'shipyard', 'naval_academy', 'missile_silo', 'defense_tower', 'carbase']);
const SIM_UNIT_COUNT_FIELDS = Object.freeze([
  'workerCount',
  'frigateCount',
  'destroyerCount',
  'cruiserCount',
  'battleshipCount',
  'carrierCount',
  'submarineCount',
  'assaultshipCount',
  'launcherCount',
  'deployedLauncherCount'
]);

function createEmptySimulationProduction() {
  return {
    headquarters: { active: [], queue: [] },
    shipyard: { active: [], queue: [] },
    naval_academy: { active: [], queue: [] },
    carbase: { active: [], queue: [] },
    missile_silo: { active: [], queue: [] }
  };
}

function cloneSimulationState(state) {
  return {
    ...state,
    completedBuildings: normalizeCompletedBuildings(state.completedBuildings),
    pendingBuildings: Array.isArray(state.pendingBuildings) ? state.pendingBuildings.map(item => ({ ...item })) : [],
    production: cloneSimulationProduction(state.production)
  };
}

function cloneSimulationProduction(production) {
  const base = createEmptySimulationProduction();
  if (!production) return base;
  SIM_PRODUCER_TYPES.forEach(type => {
    const line = production[type] || {};
    base[type] = {
      active: Array.isArray(line.active) ? line.active.map(item => ({ ...item })) : [],
      queue: Array.isArray(line.queue) ? line.queue.map(item => ({ ...item })) : []
    };
  });
  return base;
}

function normalizeCompletedBuildings(buildings) {
  const normalized = {};
  SIM_BUILDING_TYPES.forEach(type => {
    normalized[type] = Math.max(0, Math.floor(buildings?.[type] || 0));
  });
  return normalized;
}

function getCurrentLivePopulation(state) {
  return (
    (state.workerCount || 0) * (SIM_UNIT_DEFS.worker.pop || 0) +
    (state.frigateCount || 0) * SIM_UNIT_DEFS.frigate.pop +
    (state.destroyerCount || 0) * SIM_UNIT_DEFS.destroyer.pop +
    (state.cruiserCount || 0) * SIM_UNIT_DEFS.cruiser.pop +
    (state.battleshipCount || 0) * SIM_UNIT_DEFS.battleship.pop +
    (state.carrierCount || 0) * SIM_UNIT_DEFS.carrier.pop +
    (state.submarineCount || 0) * SIM_UNIT_DEFS.submarine.pop +
    (state.assaultshipCount || 0) * SIM_UNIT_DEFS.assaultship.pop +
    ((state.launcherCount || 0) + (state.deployedLauncherCount || 0)) * SIM_UNIT_DEFS.missile_launcher.pop
  );
}

function syncSimulationState(state) {
  state.completedBuildings = normalizeCompletedBuildings(state.completedBuildings);
  SIM_UNIT_COUNT_FIELDS.forEach(field => {
    state[field] = Math.max(0, Math.floor(state[field] || 0));
  });
  state.population = Math.max(0, Math.floor(state.population || 0));
  state.maxPopulation = Math.max(
    SIM_BASE_POPULATION_CAP,
    Math.min(SIM_MAX_POPULATION_CAP, Math.floor(state.maxPopulation || SIM_STARTING_MAX_POPULATION))
  );
  state.storedSlbmCount = Math.max(0, Math.floor(state.storedSlbmCount || 0));
  state.loadedSlbmCount = Math.max(0, Math.floor(state.loadedSlbmCount || 0));
  state.loadedSlbmCount = Math.min(state.loadedSlbmCount, state.submarineCount * SUBMARINE_SLBM_CAPACITY);
  state.pendingBuildings = Array.isArray(state.pendingBuildings) ? state.pendingBuildings.map(item => ({
    type: item.type,
    remainingMs: Math.max(0, Math.floor(item.remainingMs || 0))
  })) : [];
  state.production = cloneSimulationProduction(state.production);
  state.buildingCount = SIM_BUILDING_TYPES.reduce((sum, type) => sum + state.completedBuildings[type], 0);
  state.unitCount =
    (state.workerCount || 0) +
    (state.frigateCount || 0) +
    (state.destroyerCount || 0) +
    (state.cruiserCount || 0) +
    (state.battleshipCount || 0) +
    (state.carrierCount || 0) +
    (state.submarineCount || 0) +
    (state.assaultshipCount || 0) +
    (state.launcherCount || 0) +
    (state.deployedLauncherCount || 0);
  state.hasShipyard = state.completedBuildings.shipyard > 0;
  state.hasNavalAcademy = state.completedBuildings.naval_academy > 0;
  state.hasSilo = state.completedBuildings.missile_silo > 0;
  state.hasCarbase = state.completedBuildings.carbase > 0;
  return state;
}

function getInitialSimulationCombatPower(state) {
  const completedBuildings = normalizeCompletedBuildings(state.completedBuildings);
  let total = 0;
  SIM_BUILDING_TYPES.forEach(type => {
    total += completedBuildings[type] * (SIM_BUILDING_DEFS[type]?.combatPower || 0);
  });
  total += Math.max(0, Math.floor(state.frigateCount || 0)) * COMBAT_POWER_MAP.frigate;
  total += Math.max(0, Math.floor(state.destroyerCount || 0)) * COMBAT_POWER_MAP.destroyer;
  total += Math.max(0, Math.floor(state.cruiserCount || 0)) * COMBAT_POWER_MAP.cruiser;
  total += Math.max(0, Math.floor(state.battleshipCount || 0)) * COMBAT_POWER_MAP.battleship;
  total += Math.max(0, Math.floor(state.carrierCount || 0)) * COMBAT_POWER_MAP.carrier;
  total += Math.max(0, Math.floor(state.submarineCount || 0)) * COMBAT_POWER_MAP.submarine;
  total += Math.max(0, Math.floor(state.assaultshipCount || 0)) * COMBAT_POWER_MAP.assaultship;
  total += (
    Math.max(0, Math.floor(state.launcherCount || 0))
    + Math.max(0, Math.floor(state.deployedLauncherCount || 0))
  ) * COMBAT_POWER_MAP.missile_launcher;
  total += (
    Math.max(0, Math.floor(state.storedSlbmCount || 0))
    + Math.max(0, Math.floor(state.loadedSlbmCount || 0))
  ) * COMBAT_POWER_MAP.slbm;
  return total;
}

function createSimulationState(overrides = {}) {
  const state = {
    resources: SIM_STARTING_RESOURCES,
    population: SIM_STARTING_WORKERS,
    maxPopulation: SIM_STARTING_MAX_POPULATION,
    combatPower: 0,
    buildingCount: 1,
    unitCount: SIM_STARTING_WORKERS,
    workerCount: SIM_STARTING_WORKERS,
    enemyCombatPower: 100 + Math.floor(Math.random() * 200),
    enemyBuildingCount: 3 + Math.floor(Math.random() * 5),
    hasSilo: false,
    hasShipyard: false,
    hasNavalAcademy: false,
    hasCarbase: false,
    alive: true,
    kills: 0,
    tick: 0,
    fogLevel: 0,
    redZoneTimer: 0,
    inRedZoneDanger: false,
    frigateCount: 0,
    destroyerCount: 0,
    cruiserCount: 0,
    battleshipCount: 0,
    carrierCount: 0,
    submarineCount: 0,
    storedSlbmCount: 0,
    loadedSlbmCount: 0,
    aimedShotReady: false,
    aimedShotCooldown: 0,
    combatStanceActive: false,
    combatStanceStacks: 0,
    engineOverdriveActive: false,
    searchCooldown: 0,
    stealthActive: false,
    stealthCooldown: 0,
    stealthTimer: 0,
    aircraftCount: 0,
    inCombat: false,
    enemyDistance: 2,
    maxAttackRange: 0,
    totalVision: 0,
    assaultshipCount: 0,
    launcherCount: 0,
    deployedLauncherCount: 0,
    loadedAssaultShips: 0,
    hasLandAccess: false,
    completedBuildings: { headquarters: 1, power_plant: 0, shipyard: 0, naval_academy: 0, missile_silo: 0, defense_tower: 0, carbase: 0 },
    pendingBuildings: [],
    production: createEmptySimulationProduction(),
    ...overrides
  };
  state.completedBuildings = normalizeCompletedBuildings({
    headquarters: 1,
    power_plant: 0,
    shipyard: 0,
    naval_academy: 0,
    missile_silo: 0,
    defense_tower: 0,
    carbase: 0,
    ...(overrides.completedBuildings || {})
  });
  state.production = cloneSimulationProduction(overrides.production);
  state.pendingBuildings = Array.isArray(overrides.pendingBuildings) ? overrides.pendingBuildings.map(item => ({ ...item })) : [];
  if (!Number.isFinite(overrides.combatPower)) {
    state.combatPower = getInitialSimulationCombatPower(state);
  }
  return syncSimulationState(state);
}

function encodeAbstractState(summary) {
  const resourceBucket = discretize(summary.resources, [200, 500, 1000, 2000, 5000]);
  const freePopBucket = discretize(summary.freePopulation, [0, 4, 10, 20, 40]);
  const workerBucket = discretize(summary.workerCount, [2, 4, 6, 10, 16]);
  const unitBucket = discretize(summary.unitCount, [4, 8, 15, 25, 40]);
  const buildingBucket = discretize(summary.buildingCount, [1, 3, 6, 10, 15, 25]);
  const combatBucket = discretize(summary.combatPower, [100, 300, 600, 1200, 2500, 5000]);
  const enemyBucket = discretize(summary.enemyPressure, [0, 2, 5, 8, 12]);
  const shipyardBucket = discretize(summary.shipyardCount, [0, 1, 2, 4]);
  const academyBucket = discretize(summary.navalAcademyCount, [0, 1, 2, 3]);
  const siloBucket = discretize(summary.siloCount, [0, 1, 3, 5]);
  const carbaseBucket = discretize(summary.carbaseCount, [0, 1, 2]);
  const subBucket = discretize(summary.submarineCount, [0, 1, 3, 6]);
  const storedSlbmBucket = discretize(summary.storedSlbmCount, [0, 1, 3, 6]);
  const loadedSlbmBucket = discretize(summary.loadedSlbmCount, [0, 1, 3, 6]);
  const pendingBucket = discretize(summary.pendingBuildingCount, [0, 1, 3, 6]);
  const queueBucket = discretize(summary.productionLoad, [0, 1, 4, 10, 20]);
  const deployedBucket = discretize(summary.deployedLauncherCount, [0, 1, 3, 6]);
  return `${resourceBucket}-${freePopBucket}-${workerBucket}-${unitBucket}-${buildingBucket}-${combatBucket}-${enemyBucket}-${shipyardBucket}-${academyBucket}-${siloBucket}-${carbaseBucket}-${subBucket}-${storedSlbmBucket}-${loadedSlbmBucket}-${pendingBucket}-${queueBucket}-${deployedBucket}`;
}

function summarizeLiveGameState(gameState, playerId) {
  const player = gameState.players.get(playerId);
  if (!player || !player.hasBase) return null;

  let unitCount = 0;
  let workerCount = 0;
  let combatPower = 0;
  let buildingCount = 0;
  let shipyardCount = 0;
  let navalAcademyCount = 0;
  let siloCount = 0;
  let carbaseCount = 0;
  let submarineCount = 0;
  let storedSlbmCount = 0;
  let loadedSlbmCount = 0;
  let pendingBuildingCount = 0;
  let productionLoad = 0;
  let deployedLauncherCount = 0;

  gameState.units.forEach(unit => {
    if (unit.userId !== playerId) return;
    unitCount++;
    if (unit.type === 'worker') workerCount++;
    if (unit.type !== 'worker') combatPower += COMBAT_POWER_MAP[unit.type] || 0;
    if (unit.type === 'submarine') submarineCount++;
    if (unit.type === 'missile_launcher' && unit.deployState === 'deployed') deployedLauncherCount++;
    loadedSlbmCount += Math.max(0, Math.floor(unit.loadedSlbms || 0));
  });

  gameState.buildings.forEach(building => {
    if (building.userId !== playerId) return;
    if ((building.buildProgress || 0) >= 100) {
      buildingCount++;
      if (building.type === 'shipyard') shipyardCount++;
      if (building.type === 'naval_academy') navalAcademyCount++;
      if (building.type === 'missile_silo') siloCount++;
      if (building.type === 'carbase') carbaseCount++;
      storedSlbmCount += Math.max(0, Math.floor(building.slbmCount || 0));
    } else {
      pendingBuildingCount++;
    }
    productionLoad += (building.productionQueue?.length || 0)
      + (building.producing ? 1 : 0)
      + (building.missileQueue?.length || 0)
      + (building.missileProducing ? 1 : 0);
  });

  return {
    resources: Math.max(0, Math.floor(player.resources || 0)),
    freePopulation: Math.max(0, Math.floor((player.maxPopulation || 0) - (player.population || 0))),
    workerCount,
    unitCount,
    buildingCount,
    combatPower: Math.max(
      0,
      Math.floor(Number.isFinite(player.combatPower) ? player.combatPower : combatPower)
    ),
    enemyPressure: Math.min((player.knownEnemyPositions || []).length, 12),
    shipyardCount,
    navalAcademyCount,
    siloCount,
    carbaseCount,
    submarineCount,
    storedSlbmCount,
    loadedSlbmCount,
    pendingBuildingCount,
    productionLoad,
    deployedLauncherCount
  };
}

function summarizeSimulationState(state) {
  syncSimulationState(state);
  return {
    resources: Math.max(0, Math.floor(state.resources || 0)),
    freePopulation: Math.max(0, state.maxPopulation - state.population),
    workerCount: Math.max(0, Math.floor(state.workerCount || 0)),
    unitCount: state.unitCount,
    buildingCount: state.buildingCount,
    combatPower: Math.max(0, Math.floor(state.combatPower || 0)),
    enemyPressure: Math.min(12, Math.max(0, Math.ceil((state.enemyCombatPower || 0) / 180))),
    shipyardCount: state.completedBuildings.shipyard,
    navalAcademyCount: state.completedBuildings.naval_academy,
    siloCount: state.completedBuildings.missile_silo,
    carbaseCount: state.completedBuildings.carbase,
    submarineCount: state.submarineCount,
    storedSlbmCount: state.storedSlbmCount,
    loadedSlbmCount: state.loadedSlbmCount,
    pendingBuildingCount: state.pendingBuildings.length,
    productionLoad: SIM_PRODUCER_TYPES.reduce((sum, producerType) => {
      const line = state.production[producerType];
      return sum + line.active.length + line.queue.length;
    }, 0),
    deployedLauncherCount: state.deployedLauncherCount
  };
}

function getCompletedBuildingCount(state, buildingType) {
  return Math.max(0, Math.floor(state.completedBuildings?.[buildingType] || 0));
}

function getSimulationPassiveIncome(state) {
  return 20 + getCompletedBuildingCount(state, 'power_plant') * 5 + (state.workerCount || 0) * 2;
}

function getSimulationProducerCapacity(state, producerType) {
  return Math.max(0, getCompletedBuildingCount(state, producerType));
}

function rebalanceSimulationProduction(state, producerType) {
  const line = state.production[producerType];
  if (!line) return;
  const capacity = getSimulationProducerCapacity(state, producerType);
  while (line.active.length > capacity) {
    line.active.pop();
  }
  const maxJobs = capacity * SIM_MAX_QUEUE_PER_PRODUCER;
  while (line.active.length + line.queue.length > maxJobs) {
    line.queue.pop();
  }
  while (line.active.length < capacity && line.queue.length > 0) {
    const next = line.queue.shift();
    line.active.push({
      type: next.type,
      remainingMs: Math.max(1, Math.floor(next.remainingMs || 1))
    });
  }
}

function enqueueSimulationBuilding(state, buildingType) {
  const def = SIM_BUILDING_DEFS[buildingType];
  if (!def || state.resources < def.cost || (state.workerCount || 0) <= 0) return false;
  if (buildingType === 'naval_academy' && getCompletedBuildingCount(state, 'shipyard') <= 0) return false;
  if (
    buildingType === 'carbase'
    && (
      getCompletedBuildingCount(state, 'power_plant') <= 0
      || getCompletedBuildingCount(state, 'shipyard') <= 0
      || getCompletedBuildingCount(state, 'defense_tower') <= 0
      || getCompletedBuildingCount(state, 'naval_academy') <= 0
      || getCompletedBuildingCount(state, 'missile_silo') < 2
    )
  ) return false;
  state.resources -= def.cost;
  state.pendingBuildings.push({ type: buildingType, remainingMs: def.buildTime });
  return true;
}

function enqueueSimulationProduction(state, itemType) {
  const def = SIM_UNIT_DEFS[itemType];
  if (!def) return false;
  const producerType = def.producer;
  const producerCount = getSimulationProducerCapacity(state, producerType);
  if (producerCount <= 0) return false;
  const line = state.production[producerType];
  const totalQueued = line.active.length + line.queue.length;
  if (totalQueued >= producerCount * SIM_MAX_QUEUE_PER_PRODUCER) return false;
  if (state.resources < def.cost) return false;
  if (def.pop > 0 && state.population + def.pop > state.maxPopulation) return false;
  state.resources -= def.cost;
  if (def.pop > 0) state.population += def.pop;
  line.queue.push({ type: itemType, remainingMs: def.buildTime });
  rebalanceSimulationProduction(state, producerType);
  return true;
}

function completeSimulationBuilding(state, buildingType) {
  const def = SIM_BUILDING_DEFS[buildingType];
  if (!def) return 0;
  state.completedBuildings[buildingType] = getCompletedBuildingCount(state, buildingType) + 1;
  if (def.popBonus > 0) {
    state.maxPopulation = Math.min(SIM_MAX_POPULATION_CAP, state.maxPopulation + def.popBonus);
  }
  if (def.combatPower) state.combatPower += def.combatPower;
  if (SIM_PRODUCER_TYPES.includes(buildingType)) rebalanceSimulationProduction(state, buildingType);
  syncSimulationState(state);
  return def.completionReward || 0;
}

function completeSimulationProduction(state, itemType) {
  const def = SIM_UNIT_DEFS[itemType];
  if (!def) return 0;
  if (itemType === 'slbm') {
    state.storedSlbmCount++;
    state.combatPower += COMBAT_POWER_MAP.slbm;
    syncSimulationState(state);
    return def.completionReward || 0;
  }
  const producedCount = itemType === 'frigate' ? 2 : 1;
  if (def.countField) state[def.countField] = Math.max(0, Math.floor(state[def.countField] || 0)) + producedCount;
  if (def.combatPower > 0) state.combatPower += def.combatPower * producedCount;
  if (itemType === 'battleship') state.aimedShotReady = true;
  syncSimulationState(state);
  return def.completionReward || 0;
}

function advanceSimulationProgress(state, elapsedMs) {
  let reward = 0;
  const remainingBuildings = [];
  for (const pending of state.pendingBuildings) {
    const next = { ...pending, remainingMs: pending.remainingMs - elapsedMs };
    if (next.remainingMs <= 0) reward += completeSimulationBuilding(state, next.type);
    else remainingBuildings.push(next);
  }
  state.pendingBuildings = remainingBuildings;

  SIM_PRODUCER_TYPES.forEach(producerType => {
    rebalanceSimulationProduction(state, producerType);
    const line = state.production[producerType];
    const stillActive = [];
    line.active.forEach(job => {
      const next = { ...job, remainingMs: job.remainingMs - elapsedMs };
      if (next.remainingMs <= 0) reward += completeSimulationProduction(state, next.type);
      else stillActive.push(next);
    });
    line.active = stillActive;
    rebalanceSimulationProduction(state, producerType);
  });

  syncSimulationState(state);
  return reward;
}

function removeRandomUnitsFromSimulation(state, count, options = {}) {
  const allowWorkers = options.allowWorkers !== false;
  for (let i = 0; i < count; i++) {
    const candidates = [];
    if (allowWorkers && state.workerCount > 0) candidates.push({ field: 'workerCount', pop: SIM_UNIT_DEFS.worker.pop, type: 'worker' });
    if (state.frigateCount > 0) candidates.push({ field: 'frigateCount', pop: SIM_UNIT_DEFS.frigate.pop, type: 'frigate' });
    if (state.destroyerCount > 0) candidates.push({ field: 'destroyerCount', pop: SIM_UNIT_DEFS.destroyer.pop, type: 'destroyer' });
    if (state.cruiserCount > 0) candidates.push({ field: 'cruiserCount', pop: SIM_UNIT_DEFS.cruiser.pop, type: 'cruiser' });
    if (state.battleshipCount > 0) candidates.push({ field: 'battleshipCount', pop: SIM_UNIT_DEFS.battleship.pop, type: 'battleship' });
    if (state.carrierCount > 0) candidates.push({ field: 'carrierCount', pop: SIM_UNIT_DEFS.carrier.pop, type: 'carrier' });
    if (state.submarineCount > 0) candidates.push({ field: 'submarineCount', pop: SIM_UNIT_DEFS.submarine.pop, type: 'submarine' });
    if (state.assaultshipCount > 0) candidates.push({ field: 'assaultshipCount', pop: SIM_UNIT_DEFS.assaultship.pop, type: 'assaultship' });
    if (state.launcherCount > 0) candidates.push({ field: 'launcherCount', pop: SIM_UNIT_DEFS.missile_launcher.pop, type: 'missile_launcher' });
    if (state.deployedLauncherCount > 0) candidates.push({ field: 'deployedLauncherCount', pop: SIM_UNIT_DEFS.missile_launcher.pop, type: 'missile_launcher' });
    if (candidates.length === 0) break;
    const lost = candidates[Math.floor(Math.random() * candidates.length)];
    const previousCount = Math.max(0, Math.floor(state[lost.field] || 0));
    state[lost.field] = Math.max(0, state[lost.field] - 1);
    state.population = Math.max(0, state.population - lost.pop);
    if (lost.type === 'submarine') {
      if (previousCount > 0 && state.loadedSlbmCount > 0) {
        const lostLoadedSlbms = Math.min(
          SUBMARINE_SLBM_CAPACITY,
          Math.max(1, Math.ceil(state.loadedSlbmCount / previousCount))
        );
        state.loadedSlbmCount = Math.max(0, state.loadedSlbmCount - lostLoadedSlbms);
        state.combatPower = Math.max(0, state.combatPower - (lostLoadedSlbms * COMBAT_POWER_MAP.slbm));
      }
      state.loadedSlbmCount = Math.min(state.loadedSlbmCount, state.submarineCount * SUBMARINE_SLBM_CAPACITY);
      if (state.submarineCount <= 0) state.stealthActive = false;
    }
    if (lost.type === 'battleship' && state.battleshipCount <= 0) {
      state.combatStanceActive = false;
      state.aimedShotReady = false;
    }
  }
  syncSimulationState(state);
}

function destroyRandomCompletedBuilding(state) {
  const candidates = SIM_BUILDING_TYPES.filter(type => getCompletedBuildingCount(state, type) > 0);
  if (candidates.length === 0) return null;
  const buildingType = candidates[Math.floor(Math.random() * candidates.length)];
  const beforeSilos = getCompletedBuildingCount(state, 'missile_silo');
  const previousStoredSlbmCount = state.storedSlbmCount;
  state.completedBuildings[buildingType] = Math.max(0, getCompletedBuildingCount(state, buildingType) - 1);
  if (SIM_BUILDING_DEFS[buildingType]?.combatPower) {
    state.combatPower = Math.max(0, state.combatPower - (SIM_BUILDING_DEFS[buildingType].combatPower || 0));
  }
  if (buildingType === 'missile_silo' && beforeSilos > 0) {
    const afterSilos = getCompletedBuildingCount(state, 'missile_silo');
    state.storedSlbmCount = afterSilos <= 0
      ? 0
      : Math.floor(state.storedSlbmCount * (afterSilos / beforeSilos));
    const lostStoredSlbms = Math.max(0, previousStoredSlbmCount - state.storedSlbmCount);
    state.combatPower = Math.max(0, state.combatPower - (lostStoredSlbms * COMBAT_POWER_MAP.slbm));
  }
  if (SIM_PRODUCER_TYPES.includes(buildingType)) rebalanceSimulationProduction(state, buildingType);
  syncSimulationState(state);
  return buildingType;
}

// ========== Q-TABLE ==========

class QTable {
  constructor() {
    this.table = {};   // { stateKey: [q0, q1, ..., qN] }
    this.learningRate = 0.1;
    this.discountFactor = 0.95;
    this.epsilon = 0.3;       // Exploration rate
    this.minEpsilon = 0.05;
    this.epsilonDecay = 0.9995;
    this.totalEpisodes = 0;
    this.totalReward = 0;
    this.recentRewards = [];  // Last 100 episode rewards for tracking
  }

  ensureActionRow(state) {
    if (!this.table[state]) {
      this.table[state] = new Array(ACTION_COUNT).fill(0);
    } else if (this.table[state].length < ACTION_COUNT) {
      this.table[state].length = ACTION_COUNT;
      for (let i = 0; i < ACTION_COUNT; i++) {
        if (this.table[state][i] === undefined) this.table[state][i] = 0;
      }
    }
    return this.table[state];
  }

  getQ(state, action) {
    return this.ensureActionRow(state)[action];
  }

  setQ(state, action, value) {
    this.ensureActionRow(state)[action] = value;
  }

  getBestAction(state) {
    if (!this.table[state]) {
      return Math.floor(Math.random() * ACTION_COUNT);
    }
    const qValues = this.ensureActionRow(state);
    let bestAction = 0;
    let bestValue = qValues[0];
    for (let i = 1; i < qValues.length; i++) {
      if (qValues[i] > bestValue) {
        bestValue = qValues[i];
        bestAction = i;
      }
    }
    return bestAction;
  }

  chooseAction(state, epsilon) {
    const eps = epsilon !== undefined ? epsilon : this.epsilon;
    if (Math.random() < eps) {
      return Math.floor(Math.random() * ACTION_COUNT);
    }
    return this.getBestAction(state);
  }

  update(state, action, reward, nextState) {
    const currentQ = this.getQ(state, action);
    const bestNextQ = Math.max(...this.ensureActionRow(nextState));
    const newQ = currentQ + this.learningRate * (reward + this.discountFactor * bestNextQ - currentQ);
    this.setQ(state, action, newQ);
  }

  decayEpsilon() {
    this.epsilon = Math.max(this.minEpsilon, this.epsilon * this.epsilonDecay);
  }

  getStats() {
    const stateCount = Object.keys(this.table).length;
    const avgReward = this.recentRewards.length > 0
      ? this.recentRewards.reduce((a, b) => a + b, 0) / this.recentRewards.length
      : 0;
    return {
      episodes: this.totalEpisodes,
      states: stateCount,
      epsilon: Math.round(this.epsilon * 1000) / 1000,
      avgReward: Math.round(avgReward * 10) / 10,
      totalReward: Math.round(this.totalReward * 10) / 10
    };
  }
}

// ========== DIFFICULTY PRESETS ==========

const DIFFICULTY_PRESETS = {
  easy: {
    label: '쉬움',
    epsilon: 0.6,            // Very random (bad decisions)
    updateInterval: 4000,    // Slow decisions
    buildingMultiplier: 0.5, // Builds less buildings
    unitMultiplier: 0.5,     // Produces fewer units
    attackCooldown: 40000,   // Attacks less frequently
    counterattackThreshold: 5, // Slow to respond
    useSkills: false,
    useRL: false,            // Pure rule-based, weakened
    minPowerPlants: 2,
    minShipyards: 1,
    minSilos: 0,
    minTowers: 1,
    maxWorkers: 1,
  },
  normal: {
    label: '보통',
    epsilon: 0.3,
    updateInterval: 2000,
    buildingMultiplier: 1.0,
    unitMultiplier: 1.0,
    attackCooldown: 20000,
    counterattackThreshold: 2,
    useSkills: true,
    useRL: false,            // Rule-based (current AI)
    minPowerPlants: 3,
    minShipyards: 1,
    minSilos: 1,
    minTowers: 2,
    maxWorkers: 1,
  },
  hard: {
    label: '어려움',
    epsilon: 0.15,
    updateInterval: 1500,
    buildingMultiplier: 1.5,
    unitMultiplier: 1.5,
    attackCooldown: 10000,
    counterattackThreshold: 1,
    useSkills: true,
    useRL: true,             // RL-enhanced decisions
    minPowerPlants: 4,
    minShipyards: 2,
    minSilos: 1,
    minTowers: 3,
    maxWorkers: 1,
  },
  expert: {
    label: '전문가',
    epsilon: 0.05,
    updateInterval: 1000,
    buildingMultiplier: 2.0,
    unitMultiplier: 2.0,
    attackCooldown: 5000,
    counterattackThreshold: 1,
    useSkills: true,
    useRL: true,             // Full RL policy
    minPowerPlants: 5,
    minShipyards: 2,
    minSilos: 2,
    minTowers: 4,
    maxWorkers: 1,
  }
};

// ========== REWARD CALCULATION ==========

function calculateReward(prevSnapshot, currentSnapshot) {
  let reward = 0;

  // Unit changes
  const unitDiff = currentSnapshot.combatPower - prevSnapshot.combatPower;
  reward += unitDiff * 0.01;

  // Building progress
  const buildingDiff = currentSnapshot.buildingCount - prevSnapshot.buildingCount;
  reward += buildingDiff * 2;

  // Resource efficiency (not too high, not too low)
  if (currentSnapshot.resources > 500 && currentSnapshot.resources < 3000) {
    reward += 0.5;
  }

  // Enemy damage dealt
  const enemyPowerLoss = prevSnapshot.enemyCombatPower - currentSnapshot.enemyCombatPower;
  reward += enemyPowerLoss * 0.02;

  // Survival bonus
  if (currentSnapshot.alive) reward += 0.1;
  else reward -= 50;

  // Kill reward
  const killDiff = currentSnapshot.kills - prevSnapshot.kills;
  reward += killDiff * 5;

  // Win condition
  if (currentSnapshot.won) reward += 100;

  return reward;
}

function takeSnapshot(gameState, playerId) {
  const player = gameState.players.get(playerId);
  if (!player) return { alive: false, won: false, combatPower: 0, buildingCount: 0, resources: 0, kills: 0, enemyCombatPower: 0 };

  let combatPower = 0, buildingCount = 0, kills = 0;
  let enemyCombatPower = 0;

  gameState.units.forEach(u => {
    if (u.userId === playerId) {
      combatPower += COMBAT_POWER_MAP[u.type] || 0;
      kills += u.kills || 0;
    }
  });

  gameState.buildings.forEach(b => {
    if (b.userId === playerId && b.buildProgress >= 100) buildingCount++;
  });

  // Check if all enemies eliminated
  let enemyAlive = false;
  gameState.players.forEach((p, id) => {
    if (id !== playerId && p.hasBase) {
      enemyAlive = true;
      enemyCombatPower += Math.max(0, Math.floor(p.combatPower || 0));
    }
  });

  return {
    alive: player.hasBase,
    won: !enemyAlive && player.hasBase,
    combatPower: Math.max(
      0,
      Math.floor(Number.isFinite(player.combatPower) ? player.combatPower : combatPower)
    ),
    buildingCount,
    resources: player.resources || 0,
    kills,
    enemyCombatPower
  };
}

// ========== TRAINING SESSION MANAGER ==========

class TrainingSession {
  constructor(difficulty) {
    this.difficulty = difficulty || 'default';
    this.qTable = new QTable();
    this.loadedStateCount = 0;
    this.isTraining = false;
    this.frozen = false;         // When frozen, no weight updates (online learning or training)
    this.trainingSpeed = 1;
    this.episodeCount = 0;
    this.maxEpisodes = 1000;
    this.currentEpisode = 0;
    this.episodeSteps = 0;
    this.maxStepsPerEpisode = 300;
    this.trainingLog = [];
    this.lastSaveTime = 0;
    this.autoSaveInterval = 60000;
    const weightPaths = getWeightsPaths(this.difficulty);
    this.weightsPath = weightPaths.jsonPath;
    this.compressedWeightsPath = weightPaths.gzipPath;

    // Migrate old single weights file if this is 'hard' and no per-difficulty file exists
    if (this.difficulty === 'hard') {
      const oldPath = path.join(__dirname, 'ai-weights.json');
      if (
        !getExternalWeightsUrl(this.difficulty) &&
        !fs.existsSync(this.weightsPath) &&
        !fs.existsSync(this.compressedWeightsPath) &&
        fs.existsSync(oldPath)
      ) {
        try { fs.copyFileSync(oldPath, this.weightsPath); console.log('[AI-RL] Migrated old weights to hard'); } catch(e) {}
      }
    }

    this.loadWeights();
  }

  loadWeights() {
    try {
      if (fs.existsSync(this.weightsPath)) {
        const data = JSON.parse(fs.readFileSync(this.weightsPath, 'utf8'));
        this.qTable.table = data.table || {};
        this.qTable.epsilon = data.epsilon || 0.3;
        this.qTable.totalEpisodes = data.totalEpisodes || 0;
        this.qTable.totalReward = data.totalReward || 0;
        this.qTable.recentRewards = data.recentRewards || [];
        this.frozen = !!data.frozen;
        this.loadedStateCount = Object.keys(this.qTable.table).length;
        console.log(`[AI-RL][${this.difficulty}] Loaded weights: ${this.loadedStateCount} states, ${this.qTable.totalEpisodes} episodes, frozen: ${this.frozen}`);
        return true;
      }
      if (fs.existsSync(this.compressedWeightsPath)) {
        const compressed = fs.readFileSync(this.compressedWeightsPath);
        const data = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
        this.qTable.table = data.table || {};
        this.qTable.epsilon = data.epsilon || 0.3;
        this.qTable.totalEpisodes = data.totalEpisodes || 0;
        this.qTable.totalReward = data.totalReward || 0;
        this.qTable.recentRewards = data.recentRewards || [];
        this.frozen = !!data.frozen;
        this.loadedStateCount = Object.keys(this.qTable.table).length;
        console.log(`[AI-RL][${this.difficulty}] Loaded compressed weights: ${this.loadedStateCount} states, ${this.qTable.totalEpisodes} episodes, frozen: ${this.frozen}`);
        return true;
      }
    } catch (e) {
      console.error(`[AI-RL][${this.difficulty}] Failed to load weights:`, e.message);
    }
    this.loadedStateCount = 0;
    return false;
  }

  saveWeights() {
    try {
      const data = {
        table: this.qTable.table,
        epsilon: this.qTable.epsilon,
        totalEpisodes: this.qTable.totalEpisodes,
        totalReward: this.qTable.totalReward,
        recentRewards: this.qTable.recentRewards.slice(-100),
        frozen: this.frozen,
        difficulty: this.difficulty,
        savedAt: new Date().toISOString(),
        stateCount: Object.keys(this.qTable.table).length
      };
      fs.writeFileSync(this.weightsPath, JSON.stringify(data), 'utf8');
      console.log(`[AI-RL][${this.difficulty}] Saved weights: ${data.stateCount} states, frozen: ${this.frozen}`);
      return true;
    } catch (e) {
      console.error(`[AI-RL][${this.difficulty}] Failed to save weights:`, e.message);
      return false;
    }
  }

  getStatus() {
    return {
      difficulty: this.difficulty,
      isTraining: this.isTraining,
      frozen: this.frozen,
      currentEpisode: this.currentEpisode,
      maxEpisodes: this.maxEpisodes,
      episodeSteps: this.episodeSteps,
      stats: this.qTable.getStats(),
      log: this.trainingLog.slice(-20)
    };
  }

  /**
   * Called by the server during normal AI updates.
   * Returns the RL-chosen action index for a given state, or null if RL is not used.
   */
  getAction(gameState, playerId, difficulty) {
    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.normal;
    if (!preset.useRL) return null;

    const state = encodeState(gameState, playerId);
    if (state === 'dead') return null;

    const liveEpsilon = this.frozen
      ? 0.01
      : Math.max(0.01, Math.min(0.04, preset.epsilon * 0.25));
    return this.qTable.chooseAction(state, liveEpsilon);
  }

  /**
   * Record a transition during live gameplay (online learning).
   * Skipped if frozen.
   */
  recordTransition(prevState, action, reward, nextState) {
    if (this.frozen) return;
    this.qTable.update(prevState, action, reward, nextState);
  }

  /**
   * Start training mode — runs accelerated AI-vs-AI episodes.
   * This is non-blocking; it runs step-by-step via setInterval.
   */
  startTraining(episodes, stepCallback) {
    if (this.isTraining) return false;
    if (this.frozen) {
      this.trainingLog.push('[오류] 이 난이도는 고정(잠금) 상태입니다. 해제 후 학습하세요.');
      return false;
    }
    this.isTraining = true;
    this.maxEpisodes = episodes || 1000;
    this.currentEpisode = 0;
    this.trainingLog = [];
    this.trainingLog.push(`[학습 시작] ${this.maxEpisodes} 에피소드`);
    console.log(`[AI-RL] Training started: ${this.maxEpisodes} episodes`);

    this._runTrainingStep(stepCallback);
    return true;
  }

  stopTraining() {
    this.isTraining = false;
    this.saveWeights();
    this.trainingLog.push('[학습 중단]');
    console.log('[AI-RL] Training stopped');
  }

  _runTrainingStep(stepCallback) {
    if (!this.isTraining || this.currentEpisode >= this.maxEpisodes) {
      this.isTraining = false;
      this.saveWeights();
      this.trainingLog.push(`[학습 완료] ${this.currentEpisode} 에피소드, 평균 보상: ${this.qTable.getStats().avgReward}`);
      console.log(`[AI-RL] Training complete: ${this.currentEpisode} episodes`);
      if (stepCallback) stepCallback({ done: true, episode: this.currentEpisode });
      return;
    }

    // Run one episode as a simplified simulation
    const episodeReward = this._simulateEpisode();
    this.currentEpisode++;
    this.qTable.totalEpisodes++;
    this.qTable.totalReward += episodeReward;
    this.qTable.recentRewards.push(episodeReward);
    if (this.qTable.recentRewards.length > 100) this.qTable.recentRewards.shift();
    this.qTable.decayEpsilon();

    // Log every 50 episodes
    if (this.currentEpisode % 50 === 0) {
      const stats = this.qTable.getStats();
      const msg = `[에피소드 ${this.currentEpisode}/${this.maxEpisodes}] 보상: ${Math.round(episodeReward)}, 평균: ${stats.avgReward}, ε: ${stats.epsilon}, 상태: ${stats.states}`;
      this.trainingLog.push(msg);
      console.log(`[AI-RL] ${msg}`);
    }

    // Auto-save periodically
    const now = Date.now();
    if (now - this.lastSaveTime > this.autoSaveInterval) {
      this.saveWeights();
      this.lastSaveTime = now;
    }

    // Continue next episode asynchronously
    setImmediate(() => this._runTrainingStep(stepCallback));
  }

  /**
   * Simplified episode simulation using abstract state transitions.
   * Instead of running the full game engine, we simulate state changes
   * based on action effects with randomized outcomes.
   */
  _simulateEpisode() {
    let totalReward = 0;
    let state = this._randomInitialState();
    const maxSteps = this.maxStepsPerEpisode;

    for (let step = 0; step < maxSteps; step++) {
      const stateKey = this._simStateToKey(state);
      const action = this.qTable.chooseAction(stateKey);
      const { nextState, reward, done } = this._simulateStep(state, action);

      const nextKey = this._simStateToKey(nextState);
      this.qTable.update(stateKey, action, reward, nextKey);

      totalReward += reward;
      state = nextState;

      if (done) break;
    }

    return totalReward;
  }

  _randomInitialState() {
    return createSimulationState({
      enemyCombatPower: 100 + Math.floor(Math.random() * 200),
      enemyBuildingCount: 3 + Math.floor(Math.random() * 5)
    });
  }

  _simStateToKey(s) {
    return encodeAbstractState(summarizeSimulationState(s));
  }

  _simulateStep(state, actionIdx) {
    const action = ACTIONS[actionIdx];
    const s = cloneSimulationState(state);
    s.tick = state.tick + 1;
    let reward = 0;

    // Passive income per tick
    syncSimulationState(s);
    s.resources += getSimulationPassiveIncome(s);

    // --- Recalculate range/vision from unit composition ---
    s.maxAttackRange = 0;
    s.totalVision = 0;
    const unitTypes = [
      ['frigate', s.frigateCount], ['destroyer', s.destroyerCount],
      ['cruiser', s.cruiserCount], ['battleship', s.battleshipCount], ['carrier', s.carrierCount],
      ['submarine', s.submarineCount], ['assaultship', s.assaultshipCount]
    ];
    for (const [type, count] of unitTypes) {
      if (count > 0) {
        s.maxAttackRange = Math.max(s.maxAttackRange, UNIT_RANGE_TIER[type] || 0);
        s.totalVision += count * (UNIT_VISION_TIER[type] || 0);
      }
    }
    // Deployed launchers have range 3 (2500)
    if (s.deployedLauncherCount > 0) {
      s.maxAttackRange = Math.max(s.maxAttackRange, 3);
      s.totalVision += s.deployedLauncherCount * 1;
    }

    // --- Fog of War simulation ---
    // Fog level driven by total vision score from units
    if (s.totalVision >= 10) s.fogLevel = 2;       // excellent vision coverage
    else if (s.totalVision >= 4) s.fogLevel = 1;   // moderate coverage
    else s.fogLevel = 0;                            // early game / few units = blind
    // Destroyer search overrides to full vision temporarily (handled in skill_search)

    // With poor vision, enemy attack estimation is less accurate (penalty for attacking blind)
    const visionPenalty = s.fogLevel === 0 ? 0.7 : (s.fogLevel === 1 ? 0.9 : 1.0);

    // --- Red Zone simulation ---
    // Red zones appear periodically (roughly every ~60 ticks like the 10-min real interval)
    if (s.redZoneTimer <= 0 && Math.random() < 0.015) {
      s.redZoneTimer = 5; // 5 ticks warning before strike
      s.inRedZoneDanger = Math.random() < 0.4; // 40% chance units are in danger zone
    }
    if (s.redZoneTimer > 0) {
      s.redZoneTimer--;
      if (s.redZoneTimer === 0 && s.inRedZoneDanger) {
        // Red zone strike hits units/buildings in the zone
        const dmg = 100 + Math.floor(Math.random() * 200);
        s.combatPower = Math.max(0, s.combatPower - dmg);
        removeRandomUnitsFromSimulation(s, Math.ceil(dmg / 150));
        if (Math.random() < 0.25) destroyRandomCompletedBuilding(s);
        reward -= 8; // Penalty for not evacuating
        s.inRedZoneDanger = false;
      }
    }

    // Enemy grows slowly
    if (Math.random() < 0.3) {
      s.enemyCombatPower += 20;
      s.enemyBuildingCount += Math.random() < 0.2 ? 1 : 0;
    }

      // Action effects
      switch (action) {
      case 'build_power_plant':
        if (enqueueSimulationBuilding(s, 'power_plant')) reward += 0.3;
        else reward -= 1;
        break;
      case 'build_shipyard':
        if (enqueueSimulationBuilding(s, 'shipyard')) reward += 0.5;
        else reward -= 1;
        break;
      case 'build_naval_academy':
        if (enqueueSimulationBuilding(s, 'naval_academy')) reward += 0.6;
        else reward -= 1;
        break;
      case 'build_missile_silo':
        if (enqueueSimulationBuilding(s, 'missile_silo')) reward += 0.8;
        else reward -= 1;
        break;
      case 'build_defense_tower':
        if (enqueueSimulationBuilding(s, 'defense_tower')) reward += 0.4;
        else reward -= 1;
        break;
      case 'build_carbase':
        if (enqueueSimulationBuilding(s, 'carbase')) reward += 0.7;
        else reward -= 1;
        break;
      case 'produce_worker':
        if (enqueueSimulationProduction(s, 'worker')) {
          reward += s.workerCount < 8 ? 0.9 : 0.25;
        } else reward -= 0.4;
        break;
      case 'produce_frigate':
        if (enqueueSimulationProduction(s, 'frigate')) reward += 0.3;
        else reward -= 0.5;
        break;
      case 'produce_destroyer':
        if (enqueueSimulationProduction(s, 'destroyer')) reward += 0.4;
        else reward -= 0.5;
        break;
      case 'produce_cruiser':
        if (enqueueSimulationProduction(s, 'cruiser')) reward += 0.45;
        else reward -= 0.5;
        break;
      case 'produce_battleship':
        if (enqueueSimulationProduction(s, 'battleship')) reward += 0.7;
        else reward -= 0.5;
        break;
      case 'produce_carrier':
        if (enqueueSimulationProduction(s, 'carrier')) reward += 0.6;
        else reward -= 0.5;
        break;
      case 'produce_submarine':
        if (enqueueSimulationProduction(s, 'submarine')) reward += 0.65;
        else reward -= 0.5;
        break;
      case 'produce_assaultship':
        if (enqueueSimulationProduction(s, 'assaultship')) reward += 0.5;
        else reward -= 0.5;
        break;
      case 'produce_missile_launcher':
        if (enqueueSimulationProduction(s, 'missile_launcher')) reward += 0.6;
        else reward -= 0.5;
        break;
      case 'produce_slbm': {
        const totalMissiles = s.storedSlbmCount + s.loadedSlbmCount;
        const desiredStock = Math.max(2, s.submarineCount * SUBMARINE_SLBM_CAPACITY);
        if (enqueueSimulationProduction(s, 'slbm')) {
          if (s.submarineCount > 0 && totalMissiles < desiredStock) reward += 3;
          else if (s.enemyCombatPower > 250) reward += 2;
          else reward += 0.5;
        } else reward -= 1;
        break;
      }
      case 'attack_nearest_enemy':
      case 'attack_strongest_enemy': {
        if (s.combatPower <= 0) { reward -= 2; break; }
        const powerRatio = s.combatPower / Math.max(1, s.enemyCombatPower);
        // Vision affects attack effectiveness: blind attacks are riskier
        const effectiveRatio = powerRatio * visionPenalty;
        // Range advantage: if our max range > enemy distance tier, first-strike bonus
        const rangeAdvantage = s.maxAttackRange >= 3 ? 1.3
          : (s.maxAttackRange >= 2 ? 1.1 : 1.0);
        // Deployed launchers add massive range firepower in defensive fights
        const launcherDps = s.deployedLauncherCount * 80;
        const totalPower = s.combatPower + launcherDps;
        const win = Math.random() < Math.min(0.85, effectiveRatio * 0.5 * rangeAdvantage);
        if (win) {
          const damage = Math.floor(totalPower * 0.2 * Math.random());
          s.enemyCombatPower = Math.max(0, s.enemyCombatPower - damage);
          s.kills += Math.floor(damage / 100);
          reward += damage * 0.02;
          if (Math.random() < 0.3) { s.enemyBuildingCount = Math.max(0, s.enemyBuildingCount - 1); reward += 5; }
        } else {
          // Fog makes losses worse when attacking blind
          const lossMul = s.fogLevel === 0 ? 1.4 : (s.fogLevel === 1 ? 1.1 : 1.0);
          const loss = Math.floor(s.combatPower * 0.15 * Math.random() * lossMul);
          s.combatPower = Math.max(0, s.combatPower - loss);
          removeRandomUnitsFromSimulation(s, Math.ceil(loss / 100), { allowWorkers: false });
          reward -= loss * 0.01;
        }
        break;
      }
      case 'defend_base':
        s.combatPower += 20; // Defensive bonus
        // Defending also moves units away from red zone danger
        if (s.inRedZoneDanger && s.redZoneTimer > 0) { s.inRedZoneDanger = false; reward += 2; }
        reward += 0.3;
        break;
      case 'scout':
        // Scouting improves fog level and earns bonus if vision was poor
        if (s.fogLevel < 2) { s.fogLevel = Math.min(2, s.fogLevel + 1); reward += 1.5; }
        else reward += 0.2;
        // Scouting also detects red zone threats — move units out of danger
        if (s.inRedZoneDanger && s.redZoneTimer > 0) { s.inRedZoneDanger = false; reward += 3; }
        break;
      case 'load_submarine_slbm': {
        const freeSlots = Math.max(0, (s.submarineCount * SUBMARINE_SLBM_CAPACITY) - s.loadedSlbmCount);
        if (s.submarineCount > 0 && s.storedSlbmCount > 0 && freeSlots > 0) {
          const loadCount = Math.min(s.submarineCount, s.storedSlbmCount, freeSlots);
          s.storedSlbmCount -= loadCount;
          s.loadedSlbmCount += loadCount;
          if (s.enemyCombatPower > 0 || s.fogLevel >= 1) reward += loadCount * 1.5;
          else reward += loadCount * 0.8;
        } else if (s.submarineCount <= 0) {
          reward -= 1;
        } else if (s.storedSlbmCount <= 0) {
          reward -= 0.8;
        } else {
          reward -= 0.3;
        }
        break;
      }
      case 'use_slbm':
        if (s.submarineCount > 0 && s.loadedSlbmCount > 0) {
          s.loadedSlbmCount--;
          s.combatPower = Math.max(0, s.combatPower - COMBAT_POWER_MAP.slbm);
          const intelMultiplier = s.fogLevel >= 1 ? 1.0 : 0.65;
          const stealthMultiplier = s.stealthActive ? 1.1 : 1.0;
          const dmg = Math.floor((180 + Math.random() * 220) * intelMultiplier * stealthMultiplier);
          s.enemyCombatPower = Math.max(0, s.enemyCombatPower - dmg);
          if (Math.random() < (s.fogLevel >= 1 ? 0.55 : 0.25)) {
            s.enemyBuildingCount = Math.max(0, s.enemyBuildingCount - 1);
          }
          reward += s.fogLevel >= 1 ? 5.5 : 3.5;
          if (s.enemyCombatPower > 200) reward += 1;
        } else if (s.storedSlbmCount > 0) {
          reward -= 0.8; // Produced missiles exist, but firing without loading is invalid.
        } else {
          reward -= 1;
        }
        break;
      case 'use_airstrike':
        // Requires carrier with 10 aircraft, consumes all, 3 passes of 240 dmg
        if (s.carrierCount > 0 && s.aircraftCount >= 10) {
          s.aircraftCount = 0;
          const dmg = 720 * (s.enemyDistance <= 1 ? 1.0 : 0.5); // Range matters: far = half effect
          s.enemyCombatPower = Math.max(0, s.enemyCombatPower - dmg);
          if (Math.random() < 0.4) s.enemyBuildingCount = Math.max(0, s.enemyBuildingCount - 1);
          reward += 6;
        } else if (s.carrierCount > 0 && s.aircraftCount < 10) {
          reward -= 0.3; // Has carrier but not enough aircraft
        } else reward -= 0.5;
        break;
      case 'activate_aegis':
        if (s.combatPower >= 200) { s.combatPower += 30; reward += 1; }
        else reward -= 0.5;
        break;
      case 'lay_mines':
        if (s.destroyerCount > 0) {
          // Mines are most effective when enemy is approaching (mid distance)
          const mineBonus = s.enemyDistance === 1 ? 2.0 : 0.5;
          s.combatPower += 10;
          reward += mineBonus;
        } else reward -= 0.5;
        break;
      case 'lure_tactic':
        // Requires frigate + deployed launchers, best at mid range
        if (s.frigateCount > 0 && s.combatPower >= 300 && s.enemyCombatPower > 0) {
          const rangeBonus = s.enemyDistance === 1 ? 0.5 : 0.3;
          const trapped = Math.random() < (0.4 + rangeBonus);
          if (trapped) { s.enemyCombatPower = Math.max(0, s.enemyCombatPower - 100); reward += 4; }
          else reward += 0.5;
        } else reward -= 0.5;
        break;
      case 'expand':
        if (enqueueSimulationBuilding(s, s.hasShipyard ? 'power_plant' : 'shipyard')) reward += 0.5;
        else reward -= 0.5;
        break;
      case 'save_resources':
        reward += 0.1;
        break;

      // ========== SKILL ACTIONS ==========
      case 'skill_aimed_shot':
        // Battleship: next attack deals 2x damage. 16-tick cooldown.
        if (s.battleshipCount > 0 && s.aimedShotReady && s.aimedShotCooldown <= 0) {
          s.aimedShotReady = false;
          s.aimedShotCooldown = 5; // ~16s mapped to 5 ticks
          // Aimed shot is most valuable when in combat and enemy is in range
          if (s.inCombat && s.enemyDistance <= 1) {
            const aimDmg = Math.floor(s.battleshipCount * 200 * 0.5); // 2x on subset
            s.enemyCombatPower = Math.max(0, s.enemyCombatPower - aimDmg);
            reward += 4;
          } else if (s.inCombat) {
            // In combat but enemy far — wasted, but partial value
            reward += 1;
          } else {
            // Not in combat — wasted cooldown
            reward -= 1;
          }
        } else if (s.battleshipCount <= 0) {
          reward -= 1; // No battleship
        } else {
          reward -= 0.5; // On cooldown
        }
        break;

      case 'skill_combat_stance':
        // Battleship: +10% atk speed per stack, costs 10% HP per attack
        if (s.battleshipCount > 0) {
          if (!s.combatStanceActive) {
            s.combatStanceActive = true;
            s.combatStanceStacks = 1;
            // Good when in combat with HP advantage
            if (s.inCombat && s.combatPower > s.enemyCombatPower * 0.5) {
              reward += 2;
            } else if (s.inCombat) {
              reward += 0.5; // Risky — low HP but might help
            } else {
              reward += 0.3; // Preemptive activation, mild
            }
          } else {
            // Already active — stacking
            s.combatStanceStacks = Math.min(5, s.combatStanceStacks + 1);
            if (s.inCombat) reward += 0.5;
            else reward += 0.1;
          }
          // HP drain: combat stance costs HP over time
          const hpCost = s.battleshipCount * 20 * s.combatStanceStacks;
          s.combatPower = Math.max(0, s.combatPower - hpCost * 0.05);
        } else reward -= 1;
        break;

      case 'skill_engine_overdrive':
        // Frigate: +speed, evasion scales with missing HP, costs HP/tick
        if (s.frigateCount > 0) {
          if (!s.engineOverdriveActive) {
            s.engineOverdriveActive = true;
            // Overdrive is great for retreating or chasing
            if (s.inCombat) {
              // In combat: evasion helps survive, good timing
              reward += 2.5;
            } else if (s.inRedZoneDanger) {
              // Escaping red zone: speed helps
              reward += 2;
            } else {
              reward += 0.5; // Preemptive, less useful
            }
          } else {
            reward += 0.1; // Already active
          }
          // HP drain per tick while active
          if (s.engineOverdriveActive) {
            s.combatPower = Math.max(0, s.combatPower - s.frigateCount * 3);
          }
        } else reward -= 1;
        break;

      case 'skill_search':
        // Destroyer: massive vision pulse (4800 range), reveals subs. 16s cd.
        if (s.destroyerCount > 0 && s.searchCooldown <= 0) {
          s.searchCooldown = 5; // ~16s mapped to 5 ticks
          s.fogLevel = 2; // Full vision temporarily
          // Reveals hidden enemies — especially valuable when blind
          if (s.fogLevel < 2) {
            reward += 3;
          } else {
            reward += 1;
          }
          // Bonus if enemy has submarines (counter-play)
          if (s.enemyCombatPower > 200) reward += 1;
        } else if (s.destroyerCount <= 0) {
          reward -= 1;
        } else {
          reward -= 0.3; // On cooldown
        }
        break;

      case 'skill_stealth':
        // Submarine: 15s invisibility, 30s cooldown
        if (s.submarineCount > 0 && !s.stealthActive && s.stealthCooldown <= 0) {
          s.stealthActive = true;
          s.stealthTimer = 5; // ~15s mapped to 5 ticks
          s.stealthCooldown = 10; // ~30s mapped to 10 ticks
          // Stealth is best used right before attacking (ambush) or to survive
          if (s.inCombat && s.combatPower < s.enemyCombatPower) {
            // Losing fight — stealth to survive, great timing
            reward += 3;
          } else if (!s.inCombat && s.enemyDistance <= 1) {
            // Enemy approaching — preemptive ambush positioning
            reward += 2.5;
          } else {
            reward += 1; // General stealth
          }
        } else if (s.submarineCount <= 0) {
          reward -= 1;
        } else {
          reward -= 0.3; // Already active or on cooldown
        }
        break;

      // ========== STRATEGIC ACTIONS ==========
      case 'deploy_launchers':
        // Deploy mobile launchers → immobile but 2500 range
        if (s.launcherCount > 0) {
          // Best when enemy approaching and we need area denial
          const count = s.launcherCount;
          s.deployedLauncherCount += count;
          s.launcherCount = 0;
          // Range 2500 is massive — great for defense
          if (s.enemyDistance <= 1) {
            reward += count * 2.5; // Enemy in range, deploy now = excellent
          } else {
            reward += count * 1.0; // Preemptive, good but less urgent
          }
        } else {
          reward -= 0.5; // No launchers to deploy
        }
        break;

      case 'undeploy_launchers':
        // Undeploy → mobile again (for relocation)
        if (s.deployedLauncherCount > 0) {
          s.launcherCount += s.deployedLauncherCount;
          s.deployedLauncherCount = 0;
          // Only good if you need to reposition
          if (s.inRedZoneDanger) {
            reward += 2; // Evacuate from red zone
          } else if (s.enemyDistance === 2) {
            reward += 0.5; // Enemy far, ok to reposition
          } else {
            reward -= 1; // Undeploying during combat = bad
          }
        } else {
          reward -= 0.5;
        }
        break;

      case 'load_assault_ship':
        // Load mobile launchers onto assault ship for transport
        if (s.assaultshipCount > 0 && s.launcherCount > 0 && s.loadedAssaultShips < s.assaultshipCount) {
          const canLoad = Math.min(s.launcherCount, 10); // Max 10 per ship
          s.launcherCount -= canLoad;
          s.unitCount -= canLoad; // Launchers removed from field
          s.combatPower -= canLoad * 100; // Combat power decreases temporarily
          s.loadedAssaultShips++;
          // Good when planning amphibious assault
          if (s.enemyDistance <= 1 && s.fogLevel >= 1) {
            reward += 3; // Good intelligence + close enough to land
          } else {
            reward += 1; // Loading in preparation
          }
        } else if (s.assaultshipCount <= 0) {
          reward -= 1;
        } else {
          reward -= 0.5;
        }
        break;

      case 'amphibious_landing':
        // Sail loaded assault ship to enemy island, unload launchers, deploy them
        // This is the strategic combo: load → transport → unload → deploy
        if (s.loadedAssaultShips > 0) {
          // Unload launchers near enemy territory
          const unloadCount = Math.min(10, 3 + Math.floor(Math.random() * 8));
          s.deployedLauncherCount += unloadCount;
          s.unitCount += unloadCount; // Launchers back on field
          s.combatPower += unloadCount * 100;
          s.loadedAssaultShips--;
          s.hasLandAccess = true;

          // Deployed launchers at range 2500 near enemy = devastating
          // BUT risky if enemy has strong counter
          if (s.fogLevel >= 1 && s.enemyCombatPower < s.combatPower * 1.5) {
            // Good recon + manageable enemy = great landing
            const dps = unloadCount * 80;
            s.enemyCombatPower = Math.max(0, s.enemyCombatPower - Math.floor(dps * 0.3));
            reward += 8; // Huge reward for successful amphibious strategy
          } else if (s.fogLevel < 1) {
            // Blind landing — risky
            reward += 2;
            // 30% chance enemy discovers and destroys some launchers
            if (Math.random() < 0.3) {
              const lost = Math.ceil(unloadCount * 0.4);
              s.deployedLauncherCount = Math.max(0, s.deployedLauncherCount - lost);
              s.unitCount = Math.max(0, s.unitCount - lost);
              s.combatPower = Math.max(0, s.combatPower - lost * 100);
              reward -= 3;
            }
          } else {
            // Enemy too strong, landing under fire
            reward += 3;
            if (Math.random() < 0.2) {
              const lost = Math.ceil(unloadCount * 0.3);
              s.deployedLauncherCount = Math.max(0, s.deployedLauncherCount - lost);
              s.unitCount = Math.max(0, s.unitCount - lost);
              reward -= 2;
            }
          }
        } else {
          reward -= 1; // No loaded ships
        }
        break;
    }

    reward += advanceSimulationProgress(s, SIM_TICK_MS);

    // --- Skill cooldown/timer ticks ---
    if (s.aimedShotCooldown > 0) { s.aimedShotCooldown--; if (s.aimedShotCooldown <= 0) s.aimedShotReady = true; }
    if (s.searchCooldown > 0) s.searchCooldown--;
    if (s.stealthTimer > 0) {
      s.stealthTimer--;
      if (s.stealthTimer <= 0) { s.stealthActive = false; } // Stealth expired
    }
    if (s.stealthCooldown > 0) s.stealthCooldown--;
    // Engine overdrive ongoing HP drain
    if (s.engineOverdriveActive && s.frigateCount > 0) {
      s.combatPower = Math.max(0, s.combatPower - s.frigateCount * 2);
      // Frigates can die from overdrive drain
      if (s.combatPower <= 0 && s.frigateCount > 0) {
        removeRandomUnitsFromSimulation(s, 1, { allowWorkers: false });
        s.engineOverdriveActive = s.frigateCount > 0;
      }
    }
    // Carrier aircraft production (passive, 1 per 3 ticks if carrier exists)
    if (s.carrierCount > 0 && s.aircraftCount < 10 && s.tick % 3 === 0) {
      s.aircraftCount = Math.min(10, s.aircraftCount + s.carrierCount);
    }

    // --- Combat engagement simulation ---
    // Enemy distance changes over time: enemy approaches
    if (s.enemyCombatPower > 0 && Math.random() < 0.08) {
      s.enemyDistance = Math.max(0, s.enemyDistance - 1);
    }
    // Check if in combat (enemy close + both have power)
    s.inCombat = s.enemyDistance === 0 && s.combatPower > 0 && s.enemyCombatPower > 0;

    // Enemy attacks player when close
    if (s.inCombat || (Math.random() < 0.1 && s.enemyCombatPower > 0)) {
      let enemyDmg = Math.floor(s.enemyCombatPower * 0.1 * Math.random());
      // Stealth reduces incoming damage (enemies can't see submarines)
      if (s.stealthActive) enemyDmg = Math.floor(enemyDmg * 0.4);
      // Engine overdrive gives evasion
      if (s.engineOverdriveActive) enemyDmg = Math.floor(enemyDmg * 0.5);
      s.combatPower = Math.max(0, s.combatPower - enemyDmg);
      if (s.combatPower <= 0 && Math.random() < 0.3) {
        destroyRandomCompletedBuilding(s);
      }
      // Unit losses from combat
      if (enemyDmg > 100) {
        const lost = Math.ceil(enemyDmg / 200);
        removeRandomUnitsFromSimulation(s, lost);
      }
    }

    // Check end conditions
    let done = false;
    if (s.buildingCount <= 0) { s.alive = false; done = true; reward -= 50; }
    if (s.enemyBuildingCount <= 0 && s.enemyCombatPower <= 0) { done = true; reward += 100; }
    if (s.tick >= this.maxStepsPerEpisode) done = true;

    return { nextState: s, reward, done };
  }
}

// ========== SELF-PLAY ARENA ==========
// N agents compete in simulated matches. Victory margin determines reward.
// Uses the same Q-table but trains by having agents play against each other.

class SelfPlayArena {
  constructor(difficulty, numAgents = 4) {
    this.difficulty = difficulty;
    this.numAgents = Math.max(2, Math.min(8, numAgents));
    this.qTable = null;         // Set externally from TrainingSession
    this.isRunning = false;
    this.currentMatch = 0;
    this.maxMatches = 100;
    this.maxStepsPerMatch = 500;
    this.matchLog = [];
    // ELO ratings per agent slot (reset each training run)
    this.eloRatings = new Array(this.numAgents).fill(1200);
    this.matchResults = [];     // { winner, scores[], margin }
  }

  /**
   * Create initial state for one agent in a multi-agent match.
   * Each agent starts with slightly randomized conditions.
   */
  _createAgentState(agentIdx) {
    return createSimulationState({
      id: agentIdx,
      resources: SIM_STARTING_RESOURCES,
      enemyCombatPower: 0,
      enemyBuildingCount: 0,
      totalDamageDealt: 0,
      totalDamageTaken: 0,
      enemiesEliminated: 0
    });
  }

  /**
   * Build a per-agent view: aggregate all other alive agents as "enemy".
   * This lets each agent see a combined enemy state for its Q-table lookup.
   */
  _buildAgentView(agent, allAgents) {
    let enemyCombat = 0, enemyBuildings = 0, closestDist = 2;
    for (const other of allAgents) {
      if (other.id === agent.id || !other.alive) continue;
      enemyCombat += other.combatPower;
      enemyBuildings += other.buildingCount;
      // Simplify distance: if any enemy is close, we're close
      closestDist = Math.min(closestDist, other.enemyDistance !== undefined ? 1 : 2);
    }
    // Write aggregated enemy view into agent's state for Q-table encoding
    const view = { ...agent };
    view.enemyCombatPower = enemyCombat;
    view.enemyBuildingCount = enemyBuildings;
    view.enemyDistance = closestDist;
    return view;
  }

  /**
   * Convert agent state to Q-table state key (reuses TrainingSession's key format).
   */
  _stateToKey(s) {
    return encodeAbstractState(summarizeSimulationState(s));
  }

  /**
   * Apply combat between two agents. Stronger side wins the exchange.
   */
  _resolveCombat(attacker, defender) {
    if (attacker.combatPower <= 0 || defender.combatPower <= 0) return;

    const atkRange = attacker.maxAttackRange >= 3 ? 1.3 : (attacker.maxAttackRange >= 2 ? 1.1 : 1.0);
    const defRange = defender.maxAttackRange >= 3 ? 1.3 : (defender.maxAttackRange >= 2 ? 1.1 : 1.0);
    const atkVision = attacker.fogLevel === 0 ? 0.7 : (attacker.fogLevel === 1 ? 0.9 : 1.0);
    const defVision = defender.fogLevel === 0 ? 0.7 : (defender.fogLevel === 1 ? 0.9 : 1.0);

    // Attacker's effective power
    let atkPower = attacker.combatPower + attacker.deployedLauncherCount * 80;
    atkPower *= atkRange * atkVision;
    if (attacker.stealthActive) atkPower *= 1.2; // Ambush bonus
    if (attacker.engineOverdriveActive) atkPower *= 0.9; // Speed over firepower

    // Defender's effective power
    let defPower = defender.combatPower + defender.deployedLauncherCount * 80;
    defPower *= defRange * defVision;

    const totalPower = atkPower + defPower;
    if (totalPower <= 0) return;

    // Proportional damage exchange
    const atkDmgFactor = 0.08 + Math.random() * 0.12; // 8-20% of power dealt as damage
    const atkDmg = Math.floor(atkPower * atkDmgFactor);
    const defDmg = Math.floor(defPower * atkDmgFactor * 0.7); // Defender deals less (attacker chose the fight)

    // Apply damage to defender
    defender.combatPower = Math.max(0, defender.combatPower - atkDmg);
    defender.totalDamageTaken += atkDmg;
    attacker.totalDamageDealt += atkDmg;
    const defLost = Math.ceil(atkDmg / 150);
    this._reduceUnitCounts(defender, defLost);
    if (atkDmg > 200 && Math.random() < 0.3) {
      destroyRandomCompletedBuilding(defender);
    }
    attacker.kills += defLost;

    // Apply damage to attacker
    let actualDefDmg = defDmg;
    if (attacker.stealthActive) actualDefDmg = Math.floor(actualDefDmg * 0.4);
    if (attacker.engineOverdriveActive) actualDefDmg = Math.floor(actualDefDmg * 0.5);
    attacker.combatPower = Math.max(0, attacker.combatPower - actualDefDmg);
    attacker.totalDamageTaken += actualDefDmg;
    defender.totalDamageDealt += actualDefDmg;
    const atkLost = Math.ceil(actualDefDmg / 150);
    this._reduceUnitCounts(attacker, atkLost);
    defender.kills += atkLost;

    // Match actual defeat flow more closely: elimination requires losing all buildings.
    if (this._checkElimination(defender)) {
      attacker.enemiesEliminated++;
    }
    this._checkElimination(attacker);
  }

  _checkElimination(agent) {
    const wasAlive = agent.alive !== false;
    if (agent.buildingCount <= 0) {
      agent.alive = false;
      return wasAlive;
    }
    return false;
  }

  _reduceUnitCounts(agent, lost) {
    removeRandomUnitsFromSimulation(agent, lost, { allowWorkers: false });
  }

  /**
   * Simulate one complete self-play match. Returns per-agent rewards.
   */
  _simulateMatch() {
    const agents = [];
    for (let i = 0; i < this.numAgents; i++) {
      agents.push(this._createAgentState(i));
    }

    // Track transitions for Q-table updates
    const transitions = []; // { agentIdx, stateKey, action, nextStateKey }

    for (let step = 0; step < this.maxStepsPerMatch; step++) {
      const aliveAgents = agents.filter(a => a.alive);
      if (aliveAgents.length <= 1) break;

      // Each alive agent picks an action
      for (const agent of aliveAgents) {
        agent.tick = step;
        const view = this._buildAgentView(agent, agents);
        const stateKey = this._stateToKey(view);
        const actionIdx = this.qTable.chooseAction(stateKey);

        // Apply the action using the existing simulation logic
        this._applyAction(agent, actionIdx, agents);

        // Tick cooldowns/timers
        this._tickTimers(agent);
        advanceSimulationProgress(agent, SIM_TICK_MS);
        syncSimulationState(agent);

        const nextView = this._buildAgentView(agent, agents);
        const nextKey = this._stateToKey(nextView);
        transitions.push({ agentIdx: agent.id, stateKey, action: actionIdx, nextKey });
      }

      // --- Combat phase: battle royale style, escalating engagement ---
      // Combat probability increases over time: early=30%, mid=60%, late=90%+
      const combatChance = Math.min(0.95, 0.30 + step * 0.004);
      for (let i = 0; i < aliveAgents.length; i++) {
        for (let j = i + 1; j < aliveAgents.length; j++) {
          if (!aliveAgents[i].alive || !aliveAgents[j].alive) continue;
          if (Math.random() < combatChance) {
            const [atk, def] = aliveAgents[i].combatPower >= aliveAgents[j].combatPower
              ? [aliveAgents[i], aliveAgents[j]]
              : [aliveAgents[j], aliveAgents[i]];
            this._resolveCombat(atk, def);
          }
        }
      }

      // --- Red zone: escalating pressure (battle royale shrinking circle) ---
      // Phase 1 (step<100): mild, Phase 2 (100-250): moderate, Phase 3 (250+): deadly
      const rzChance = step < 100 ? 0.02 : (step < 250 ? 0.08 : 0.25);
      const rzDmgMul = step < 100 ? 1.0 : (step < 250 ? 2.0 : 5.0);
      if (Math.random() < rzChance) {
        for (const agent of aliveAgents) {
          if (!agent.alive) continue;
          const hitChance = step < 100 ? 0.3 : (step < 250 ? 0.5 : 0.8);
          if (Math.random() < hitChance) {
            const baseDmg = 100 + Math.floor(Math.random() * 200);
            const dmg = Math.floor(baseDmg * rzDmgMul);
            agent.combatPower = Math.max(0, agent.combatPower - dmg);
            const lost = Math.ceil(dmg / 120);
            this._reduceUnitCounts(agent, lost);
            // Building destruction increases over time
            const bldgDestroyChance = step < 100 ? 0.15 : (step < 250 ? 0.3 : 0.5);
            if (agent.buildingCount > 0 && Math.random() < bldgDestroyChance) destroyRandomCompletedBuilding(agent);
            this._checkElimination(agent);
          }
        }
      }

      // Passive income for all alive agents
      for (const agent of aliveAgents) {
        if (agent.alive) {
          agent.resources += getSimulationPassiveIncome(agent);
          // Aircraft production
          if (agent.carrierCount > 0 && agent.aircraftCount < 10 && step % 3 === 0) {
            agent.aircraftCount = Math.min(10, agent.aircraftCount + agent.carrierCount);
          }
        }
      }

      // --- Phase 4 (step 400+): Sudden death. Massive unavoidable damage every tick ---
      if (step >= 400) {
        for (const agent of agents.filter(a => a.alive)) {
          const sdDmg = 300 + (step - 400) * 50;
          agent.combatPower = Math.max(0, agent.combatPower - sdDmg);
          const lost = Math.ceil(sdDmg / 80);
          agent.unitCount = Math.max(0, agent.unitCount - lost);
          this._reduceUnitCounts(agent, lost);
          if (Math.random() < 0.6) agent.buildingCount = Math.max(0, agent.buildingCount - 1);
          this._checkElimination(agent);
        }
      }
    }

    // --- Force exactly 1 survivor: if multiple still alive, weakest die ---
    const finalAlive = agents.filter(a => a.alive);
    if (finalAlive.length > 1) {
      finalAlive.sort((a, b) => this._calculateScore(b) - this._calculateScore(a));
      for (let i = 1; i < finalAlive.length; i++) {
        finalAlive[i].alive = false;
        finalAlive[0].enemiesEliminated++;
      }
    }

    // === Score & Reward calculation ===
    const scores = agents.map(a => this._calculateScore(a));
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const scoreRange = Math.max(1, maxScore - minScore);

    // Rank agents by score
    const ranked = agents.map((a, i) => ({ idx: i, score: scores[i], alive: a.alive }))
      .sort((a, b) => b.score - a.score);

    // Assign rewards based on relative performance (margin of victory matters)
    const agentRewards = new Array(this.numAgents).fill(0);
    for (let rank = 0; rank < ranked.length; rank++) {
      const { idx, score } = ranked[rank];
      // Normalized score: how dominant was this agent? (0 to 1)
      const dominance = (score - minScore) / scoreRange;

      if (rank === 0) {
        // Winner: base reward + bonus for margin of victory
        const marginOverSecond = ranked.length > 1
          ? (score - ranked[1].score) / Math.max(1, scoreRange) : 1;
        agentRewards[idx] = 50 + 50 * marginOverSecond + 20 * dominance;
        if (agents[idx].alive) agentRewards[idx] += 20; // Survival bonus
      } else if (rank === ranked.length - 1) {
        // Last place: heavy penalty scaled by margin
        const marginFromFirst = (ranked[0].score - score) / Math.max(1, scoreRange);
        agentRewards[idx] = -30 - 40 * marginFromFirst;
        if (!agents[idx].alive) agentRewards[idx] -= 20;
      } else {
        // Middle ranks: scaled between +10 and -10 based on relative position
        const relativePos = 1 - (rank / (ranked.length - 1)); // 1=top, 0=bottom
        agentRewards[idx] = (relativePos - 0.5) * 40 + dominance * 10;
      }
    }

    // Update Q-table with per-agent rewards
    for (const t of transitions) {
      const reward = agentRewards[t.agentIdx] / this.maxStepsPerMatch; // Distribute over steps
      this.qTable.update(t.stateKey, t.action, reward, t.nextKey);
    }

    // Update ELO ratings
    this._updateElo(ranked);

    // Record result
    const winner = ranked[0];
    this.matchResults.push({
      winner: winner.idx,
      scores,
      margin: ranked.length > 1 ? winner.score - ranked[1].score : 0,
      aliveCount: agents.filter(a => a.alive).length
    });

    return agentRewards[ranked[0].idx]; // Return winner's reward for logging
  }

  _calculateScore(agent) {
    let score = 0;
    score += agent.combatPower * 0.5;
    score += agent.buildingCount * 30;
    score += agent.kills * 20;
    score += agent.totalDamageDealt * 0.1;
    score -= agent.totalDamageTaken * 0.05;
    score += agent.enemiesEliminated * 100;
    if (agent.alive) score += 200;
    score += Math.min(agent.resources, 3000) * 0.05;
    return Math.round(score);
  }

  _updateElo(ranked) {
    const K = 32;
    for (let i = 0; i < ranked.length; i++) {
      for (let j = i + 1; j < ranked.length; j++) {
        const a = ranked[i].idx, b = ranked[j].idx;
        const ea = 1 / (1 + Math.pow(10, (this.eloRatings[b] - this.eloRatings[a]) / 400));
        const eb = 1 - ea;
        // i beat j (higher rank = better)
        this.eloRatings[a] += K * (1 - ea);
        this.eloRatings[b] += K * (0 - eb);
      }
    }
  }

  /**
   * Apply an action to an agent. Simplified version of _simulateStep.
   */
  _applyAction(agent, actionIdx, allAgents) {
    const action = ACTIONS[actionIdx];

    // Recalculate range/vision
    agent.maxAttackRange = 0;
    agent.totalVision = 0;
    const types = [
      ['frigate', agent.frigateCount], ['destroyer', agent.destroyerCount],
      ['cruiser', agent.cruiserCount], ['battleship', agent.battleshipCount], ['carrier', agent.carrierCount],
      ['submarine', agent.submarineCount], ['assaultship', agent.assaultshipCount]
    ];
    for (const [type, count] of types) {
      if (count > 0) {
        agent.maxAttackRange = Math.max(agent.maxAttackRange, UNIT_RANGE_TIER[type] || 0);
        agent.totalVision += count * (UNIT_VISION_TIER[type] || 0);
      }
    }
    if (agent.deployedLauncherCount > 0) {
      agent.maxAttackRange = Math.max(agent.maxAttackRange, 3);
      agent.totalVision += agent.deployedLauncherCount;
    }
    if (agent.totalVision >= 10) agent.fogLevel = 2;
    else if (agent.totalVision >= 4) agent.fogLevel = 1;
    else agent.fogLevel = 0;

    syncSimulationState(agent);

    // Find a random alive enemy for targeted attacks
    const enemies = allAgents.filter(a => a.id !== agent.id && a.alive);
    const targetEnemy = enemies.length > 0 ? enemies[Math.floor(Math.random() * enemies.length)] : null;

    switch (action) {
      case 'build_power_plant':
        enqueueSimulationBuilding(agent, 'power_plant');
        break;
      case 'build_shipyard':
        enqueueSimulationBuilding(agent, 'shipyard');
        break;
      case 'build_naval_academy':
        enqueueSimulationBuilding(agent, 'naval_academy');
        break;
      case 'build_missile_silo':
        enqueueSimulationBuilding(agent, 'missile_silo');
        break;
      case 'build_defense_tower':
        enqueueSimulationBuilding(agent, 'defense_tower');
        break;
      case 'build_carbase':
        enqueueSimulationBuilding(agent, 'carbase');
        break;
      case 'produce_worker':
        enqueueSimulationProduction(agent, 'worker');
        break;
      case 'produce_frigate':
        enqueueSimulationProduction(agent, 'frigate');
        break;
      case 'produce_destroyer':
        enqueueSimulationProduction(agent, 'destroyer');
        break;
      case 'produce_cruiser':
        enqueueSimulationProduction(agent, 'cruiser');
        break;
      case 'produce_battleship':
        enqueueSimulationProduction(agent, 'battleship');
        break;
      case 'produce_carrier':
        enqueueSimulationProduction(agent, 'carrier');
        break;
      case 'produce_submarine':
        enqueueSimulationProduction(agent, 'submarine');
        break;
      case 'produce_assaultship':
        enqueueSimulationProduction(agent, 'assaultship');
        break;
      case 'produce_missile_launcher':
        enqueueSimulationProduction(agent, 'missile_launcher');
        break;
      case 'produce_slbm':
        enqueueSimulationProduction(agent, 'slbm');
        break;
      case 'attack_nearest_enemy':
      case 'attack_strongest_enemy':
        if (targetEnemy && agent.combatPower > 0) {
          this._resolveCombat(agent, targetEnemy);
        }
        break;
      case 'defend_base':
        agent.combatPower += 20;
        break;
      case 'scout':
        if (agent.fogLevel < 2) agent.fogLevel = Math.min(2, agent.fogLevel + 1);
        break;
      case 'load_submarine_slbm': {
        const free = Math.max(0, (agent.submarineCount * SUBMARINE_SLBM_CAPACITY) - agent.loadedSlbmCount);
        if (agent.submarineCount > 0 && agent.storedSlbmCount > 0 && free > 0) {
          const load = Math.min(agent.submarineCount, agent.storedSlbmCount, free);
          agent.storedSlbmCount -= load;
          agent.loadedSlbmCount += load;
        }
        break;
      }
      case 'use_slbm':
        if (targetEnemy && agent.submarineCount > 0 && agent.loadedSlbmCount > 0) {
          agent.loadedSlbmCount--;
          agent.combatPower = Math.max(0, agent.combatPower - COMBAT_POWER_MAP.slbm);
          const mul = agent.fogLevel >= 1 ? 1.0 : 0.65;
          const dmg = Math.floor((180 + Math.random() * 220) * mul);
          targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
          targetEnemy.totalDamageTaken += dmg;
          agent.totalDamageDealt += dmg;
          if (Math.random() < 0.45) {
            destroyRandomCompletedBuilding(targetEnemy);
            if (this._checkElimination(targetEnemy)) agent.enemiesEliminated++;
          }
        }
        break;
      case 'use_airstrike':
        if (targetEnemy && agent.carrierCount > 0 && agent.aircraftCount >= 10) {
          agent.aircraftCount = 0;
          const dmg = 720;
          targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
          targetEnemy.totalDamageTaken += dmg;
          agent.totalDamageDealt += dmg;
          if (Math.random() < 0.4) {
            destroyRandomCompletedBuilding(targetEnemy);
            if (this._checkElimination(targetEnemy)) agent.enemiesEliminated++;
          }
        }
        break;
      case 'activate_aegis':
        if (agent.combatPower >= 200) agent.combatPower += 30;
        break;
      case 'lay_mines':
        if (agent.destroyerCount > 0) agent.combatPower += 10;
        break;
      case 'lure_tactic':
        if (targetEnemy && agent.frigateCount > 0 && agent.combatPower >= 300) {
          if (Math.random() < 0.4) {
            const dmg = 100;
            targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
            targetEnemy.totalDamageTaken += dmg;
            agent.totalDamageDealt += dmg;
          }
        }
        break;
      case 'expand':
        enqueueSimulationBuilding(agent, agent.hasShipyard ? 'power_plant' : 'shipyard');
        break;
      case 'save_resources':
        break;
      case 'skill_aimed_shot':
        if (targetEnemy && agent.battleshipCount > 0 && agent.aimedShotReady && agent.aimedShotCooldown <= 0) {
          agent.aimedShotReady = false;
          agent.aimedShotCooldown = 5;
          const dmg = Math.floor(agent.battleshipCount * 200 * 0.5);
          targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
          targetEnemy.totalDamageTaken += dmg;
          agent.totalDamageDealt += dmg;
        }
        break;
      case 'skill_combat_stance':
        if (agent.battleshipCount > 0) {
          if (!agent.combatStanceActive) { agent.combatStanceActive = true; agent.combatStanceStacks = 1; }
          else agent.combatStanceStacks = Math.min(5, agent.combatStanceStacks + 1);
          agent.combatPower = Math.max(0, agent.combatPower - agent.battleshipCount * 20 * agent.combatStanceStacks * 0.05);
        }
        break;
      case 'skill_engine_overdrive':
        if (agent.frigateCount > 0) {
          agent.engineOverdriveActive = true;
          agent.combatPower = Math.max(0, agent.combatPower - agent.frigateCount * 3);
        }
        break;
      case 'skill_search':
        if (agent.destroyerCount > 0 && agent.searchCooldown <= 0) {
          agent.searchCooldown = 5;
          agent.fogLevel = 2;
        }
        break;
      case 'skill_stealth':
        if (agent.submarineCount > 0 && !agent.stealthActive && agent.stealthCooldown <= 0) {
          agent.stealthActive = true;
          agent.stealthTimer = 5;
          agent.stealthCooldown = 10;
        }
        break;
      case 'deploy_launchers':
        if (agent.launcherCount > 0) {
          agent.deployedLauncherCount += agent.launcherCount;
          agent.launcherCount = 0;
        }
        break;
      case 'undeploy_launchers':
        if (agent.deployedLauncherCount > 0) {
          agent.launcherCount += agent.deployedLauncherCount;
          agent.deployedLauncherCount = 0;
        }
        break;
      case 'load_assault_ship':
        if (agent.assaultshipCount > 0 && agent.launcherCount > 0 && agent.loadedAssaultShips < agent.assaultshipCount) {
          const load = Math.min(agent.launcherCount, 10);
          agent.launcherCount -= load;
          agent.unitCount -= load;
          agent.combatPower -= load * 100;
          agent.loadedAssaultShips++;
        }
        break;
      case 'amphibious_landing':
        if (targetEnemy && agent.loadedAssaultShips > 0) {
          const unload = Math.min(10, 3 + Math.floor(Math.random() * 8));
          agent.deployedLauncherCount += unload;
          agent.unitCount += unload;
          agent.combatPower += unload * 100;
          agent.loadedAssaultShips--;
          agent.hasLandAccess = true;
          // Deployed launchers deal damage from landing
          const dps = unload * 80;
          const dmg = Math.floor(dps * 0.3);
          targetEnemy.combatPower = Math.max(0, targetEnemy.combatPower - dmg);
          targetEnemy.totalDamageTaken += dmg;
          agent.totalDamageDealt += dmg;
        }
        break;
    }
    syncSimulationState(agent);
  }

  _tickTimers(agent) {
    if (agent.aimedShotCooldown > 0) { agent.aimedShotCooldown--; if (agent.aimedShotCooldown <= 0) agent.aimedShotReady = true; }
    if (agent.searchCooldown > 0) agent.searchCooldown--;
    if (agent.stealthTimer > 0) { agent.stealthTimer--; if (agent.stealthTimer <= 0) agent.stealthActive = false; }
    if (agent.stealthCooldown > 0) agent.stealthCooldown--;
    if (agent.engineOverdriveActive && agent.frigateCount > 0) {
      agent.combatPower = Math.max(0, agent.combatPower - agent.frigateCount * 2);
      if (agent.combatPower <= 0 && agent.frigateCount > 0) {
        removeRandomUnitsFromSimulation(agent, 1, { allowWorkers: false });
        agent.engineOverdriveActive = agent.frigateCount > 0;
      }
    }
    syncSimulationState(agent);
  }

  getStats() {
    const recent = this.matchResults.slice(-50);
    const avgMargin = recent.length > 0
      ? Math.round(recent.reduce((s, m) => s + m.margin, 0) / recent.length)
      : 0;
    const avgAlive = recent.length > 0
      ? (recent.reduce((s, m) => s + m.aliveCount, 0) / recent.length).toFixed(1)
      : 0;
    return {
      matches: this.matchResults.length,
      numAgents: this.numAgents,
      eloRatings: this.eloRatings.map(r => Math.round(r)),
      avgVictoryMargin: avgMargin,
      avgSurvivors: avgAlive
    };
  }
}

// Add self-play training to TrainingSession
TrainingSession.prototype.startSelfPlayTraining = function(matches, numAgents, stepCallback) {
  if (this.isTraining) return false;
  if (this.frozen) {
    this.trainingLog.push('[오류] 이 난이도는 고정(잠금) 상태입니다. 해제 후 학습하세요.');
    return false;
  }
  this.isTraining = true;
  this.selfPlayArena = new SelfPlayArena(this.difficulty, numAgents);
  this.selfPlayArena.qTable = this.qTable;
  this.selfPlayArena.maxMatches = matches || 1000;
  this.selfPlayArena.isRunning = true;
  this.maxEpisodes = matches;
  this.currentEpisode = 0;
  this.trainingLog = [];
  this.trainingLog.push(`[셀프플레이 시작] ${matches} 매치, ${numAgents}명 대전`);
  console.log(`[AI-RL][${this.difficulty}] Self-play started: ${matches} matches, ${numAgents} agents`);

  this._runSelfPlayStep(stepCallback);
  return true;
};

TrainingSession.prototype._runSelfPlayStep = function(stepCallback) {
  if (!this.isTraining || this.currentEpisode >= this.maxEpisodes) {
    this.isTraining = false;
    if (this.selfPlayArena) this.selfPlayArena.isRunning = false;
    this.saveWeights();
    const stats = this.selfPlayArena ? this.selfPlayArena.getStats() : {};
    this.trainingLog.push(`[셀프플레이 완료] ${this.currentEpisode} 매치, 평균 승리마진: ${stats.avgVictoryMargin || 0}`);
    console.log(`[AI-RL][${this.difficulty}] Self-play complete: ${this.currentEpisode} matches`);
    if (stepCallback) stepCallback({ done: true, episode: this.currentEpisode });
    return;
  }

  // Run one match
  const winnerReward = this.selfPlayArena._simulateMatch();
  this.currentEpisode++;
  this.selfPlayArena.currentMatch = this.currentEpisode;
  this.qTable.totalEpisodes++;
  this.qTable.totalReward += winnerReward;
  this.qTable.recentRewards.push(winnerReward);
  if (this.qTable.recentRewards.length > 100) this.qTable.recentRewards.shift();
  this.qTable.decayEpsilon();

  // Log every 50 matches
  if (this.currentEpisode % 50 === 0) {
    const qStats = this.qTable.getStats();
    const arenaStats = this.selfPlayArena.getStats();
    const recent = this.selfPlayArena.matchResults.slice(-50);
    const avgMargin = recent.length > 0 ? Math.round(recent.reduce((s, m) => s + m.margin, 0) / recent.length) : 0;
    const msg = `[매치 ${this.currentEpisode}/${this.maxEpisodes}] 승리마진: ${avgMargin}, ε: ${qStats.epsilon}, 상태: ${qStats.states}, ELO: [${arenaStats.eloRatings.join(',')}]`;
    this.trainingLog.push(msg);
    console.log(`[AI-RL][${this.difficulty}] ${msg}`);
  }

  // Auto-save
  const now = Date.now();
  if (now - this.lastSaveTime > this.autoSaveInterval) {
    this.saveWeights();
    this.lastSaveTime = now;
  }

  setImmediate(() => this._runSelfPlayStep(stepCallback));
};

TrainingSession.prototype.getSelfPlayStatus = function() {
  if (!this.selfPlayArena) return null;
  return this.selfPlayArena.getStats();
};

// ========== EXPORTS ==========

module.exports = {
  TrainingSession,
  SelfPlayArena,
  QTable,
  ACTIONS,
  DIFFICULTY_PRESETS,
  ensureExternalWeightsCached,
  encodeState,
  calculateReward,
  takeSnapshot,
  discretize,
  COMBAT_POWER_MAP
};
