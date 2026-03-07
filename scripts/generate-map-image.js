#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function parseArgs(argv) {
  const options = {
    input: path.join('public', 'assets', 'maps', 'terrain-grid.json'),
    output: path.join('public', 'assets', 'maps', 'world-map.png'),
    scale: 1,
    land: '#3d5a3d',
    water: '#1a3a5c'
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      options.input = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      options.output = argv[++i];
    } else if (arg === '--scale' && argv[i + 1]) {
      options.scale = Number(argv[++i]);
    } else if (arg === '--land' && argv[i + 1]) {
      options.land = argv[++i];
    } else if (arg === '--water' && argv[i + 1]) {
      options.water = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!Number.isInteger(options.scale) || options.scale < 1) {
    throw new Error('--scale must be an integer >= 1');
  }

  return options;
}

function printHelp() {
  console.log([
    'Generate map PNG from terrain-grid.json',
    '',
    'Usage:',
    '  node scripts/generate-map-image.js [options]',
    '',
    'Options:',
    '  --input <path>   Input terrain json (default: public/assets/maps/terrain-grid.json)',
    '  --output <path>  Output png path (default: public/assets/maps/world-map.png)',
    '  --scale <n>      Pixels per terrain cell (default: 1)',
    '  --land <hex>     Land color hex (default: #3d5a3d)',
    '  --water <hex>    Water color hex (default: #1a3a5c)',
    '  --help           Show help'
  ].join('\n'));
}

function parseHexColor(hex) {
  const clean = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    throw new Error(`Invalid color: ${hex}`);
  }
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
    255
  ];
}

function ensureTerrainGrid(terrain) {
  if (!Array.isArray(terrain) || terrain.length === 0) {
    throw new Error('terrain must be a non-empty 2D array');
  }
  const size = terrain.length;
  for (let y = 0; y < size; y++) {
    if (!Array.isArray(terrain[y]) || terrain[y].length !== size) {
      throw new Error(`terrain row ${y} has invalid length`);
    }
  }
  return size;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createPng(width, height, rgbaWithFilterBytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const compressed = zlib.deflateSync(rgbaWithFilterBytes, { level: 9 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPath = path.resolve(options.output);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const terrain = payload.terrain;
  const gridSize = ensureTerrainGrid(terrain);
  const scale = options.scale;
  const width = gridSize * scale;
  const height = gridSize * scale;

  const land = parseHexColor(options.land);
  const water = parseHexColor(options.water);

  const stride = (width * 4) + 1; // +1 filter byte per row
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const srcY = Math.floor(y / scale);
    const row = terrain[srcY];
    const rowOffset = y * stride;
    raw[rowOffset] = 0; // filter type: None

    for (let x = 0; x < width; x++) {
      const srcX = Math.floor(x / scale);
      const color = row[srcX] === 1 ? land : water;
      const pixelOffset = rowOffset + 1 + (x * 4);
      raw[pixelOffset] = color[0];
      raw[pixelOffset + 1] = color[1];
      raw[pixelOffset + 2] = color[2];
      raw[pixelOffset + 3] = color[3];
    }
  }

  const png = createPng(width, height, raw);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, png);

  console.log(`Map image generated: ${outputPath}`);
  console.log(`Size: ${width}x${height} (scale=${scale}, grid=${gridSize})`);
}

main();
