#!/usr/bin/env node
/*
 * generate-sprite.js
 *
 * Scans the ./audios/ folder for files named like "Cs3-Maj.mp3" and builds a single sprite
 * `audios/sprites/part1.mp3` and a mapping file `audios/sprites/map.json` containing offsets and durations
 * for each key "<midi>-<chord>".
 *
 * Requirements: ffmpeg and ffprobe must be installed and available in PATH.
 * Usage: node scripts/generate-sprite.js --out ./audios/sprites/part1.mp3 --map ./audios/sprites/map.json
 *
 * The script will:
 *  - enumerate matching audio files in ./audios/
 *  - for each file, run ffprobe to get its duration
 *  - convert each to a temporary WAV with consistent sample rate/channels
 *  - concatenate WAVs with ffmpeg concat demuxer
 *  - encode the final sprite to mp3
 *  - write map.json with offsets (seconds) and durations
 *
 * Notes:
 *  - This is a pragmatic helper; test it on a small set of files first.
 *  - Filenames must match pattern: <Root><octave>-<Chord>.ext (e.g., Cs3-Maj.mp3)
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AUDIO_DIR = path.resolve(__dirname, '..', 'audios');
const OUT_DIR_DEFAULT = path.join(AUDIO_DIR, 'sprites');

const argv = require('minimist')(process.argv.slice(2));
const OUT_SPRITE = argv.out ? path.resolve(argv.out) : path.join(OUT_DIR_DEFAULT, 'part1.mp3');
const OUT_MAP = argv.map ? path.resolve(argv.map) : path.join(OUT_DIR_DEFAULT, 'map.json');

if (!fs.existsSync(AUDIO_DIR)) {
  console.error('audios directory not found:', AUDIO_DIR);
  process.exit(1);
}

if (!fs.existsSync(OUT_DIR_DEFAULT)) fs.mkdirSync(OUT_DIR_DEFAULT, { recursive: true });

// Helper to run ffprobe and return duration in seconds
function getDuration(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
    return parseFloat(out.trim());
  } catch (e) {
    console.error('ffprobe failed for', file, e.message);
    return null;
  }
}

// Find all mp3 (or wav) files in AUDIO_DIR (ignore sprites subdir)
const files = fs.readdirSync(AUDIO_DIR).filter(f => {
  const full = path.join(AUDIO_DIR, f);
  if (!fs.statSync(full).isFile()) return false;
  if (f.startsWith('sprites')) return false;
  const ext = path.extname(f).toLowerCase();
  return ext === '.mp3' || ext === '.wav' || ext === '.ogg' || ext === '.m4a';
}).sort();

if (!files.length) {
  console.error('No audio files found in', AUDIO_DIR);
  process.exit(1);
}

console.log('Found', files.length, 'files');

// Convert filenames to keys and collect durations
const items = [];
for (const f of files) {
  const m = f.match(/^(.+?)\.(mp3|wav|ogg|m4a)$/i);
  if (!m) continue;
  const name = m[1];
  // Attempt to parse name as <Root><octave>-<Chord>, e.g., Cs3-Maj
  const dash = name.indexOf('-');
  if (dash === -1) continue;
  const root = name.slice(0, dash);
  const chord = name.slice(dash + 1);
  // convert root to midi number-ish? We'll keep the file root as-is for now and construct key differently below
  const fullPath = path.join(AUDIO_DIR, f);
  const duration = getDuration(fullPath);
  if (!duration) {
    console.warn('Skipping file (no duration):', f);
    continue;
  }
  items.push({ file: fullPath, name, root, chord, duration });
}

if (!items.length) {
  console.error('No parseable audio items found. Filenames must be like Cs3-Maj.mp3');
  process.exit(1);
}

// Create temp wav files with consistent params
const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sprite-'));
const tmpWavs = [];
console.log('Using tmp dir', tmpDir);

for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const tmpWav = path.join(tmpDir, `part-${i}.wav`);
  // use ffmpeg to convert to 44100Hz, mono, 16-bit wav
  const res = spawnSync('ffmpeg', ['-y', '-i', it.file, '-ar', '44100', '-ac', '1', tmpWav], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('ffmpeg failed converting', it.file);
    process.exit(1);
  }
  tmpWavs.push({ path: tmpWav, duration: it.duration, name: it.name, root: it.root, chord: it.chord });
}

// create concat list
const concatList = path.join(tmpDir, 'concat.txt');
fs.writeFileSync(concatList, tmpWavs.map(w => `file '${w.path.replace(/'/g, "'\\''")}'`).join('\n'));

// concat into a single wav
const spriteWav = path.join(tmpDir, 'sprite_full.wav');
console.log('Concatenating to', spriteWav);
const concatRes = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', spriteWav], { stdio: 'inherit' });
if (concatRes.status !== 0) {
  console.error('ffmpeg concat failed');
  process.exit(1);
}

// encode to mp3 (or keep wav)
console.log('Encoding sprite to mp3:', OUT_SPRITE);
const encodeRes = spawnSync('ffmpeg', ['-y', '-i', spriteWav, '-codec:a', 'libmp3lame', '-qscale:a', '2', OUT_SPRITE], { stdio: 'inherit' });
if (encodeRes.status !== 0) {
  console.error('ffmpeg encode failed');
  process.exit(1);
}

// Build map.json offsets (in seconds) using item durations
const map = {};
let offset = 0.0;
for (const w of tmpWavs) {
  // Try to construct midi number from root (e.g., Cs3)
  const m = w.name.match(/^([A-G]s?)(-?\d+)-?(.+)?$/);
  let midiKey = w.name;
  if (m) {
    const note = m[1];
    const octave = parseInt(m[2], 10);
    const fileNotesMap = {C:0, Cs:1, D:2, Ds:3, E:4, F:5, Fs:6, G:7, Gs:8, A:9, As:10, B:11};
    if (note in fileNotesMap) {
      const midi = (octave + 1) * 12 + fileNotesMap[note];
      midiKey = `${midi}-${w.chord}`;
    }
  }
  map[midiKey] = { sprite: path.relative(AUDIO_DIR, OUT_SPRITE).startsWith('sprites') ? `./${path.relative(path.dirname(AUDIO_DIR), OUT_SPRITE)}` : path.relative(AUDIO_DIR, OUT_SPRITE), offset: Math.round(offset * 1000) / 1000, duration: Math.round(w.duration * 1000) / 1000 };
  offset += w.duration;
}

// write map file
fs.writeFileSync(OUT_MAP, JSON.stringify(map, null, 2), 'utf8');
console.log('Map written to', OUT_MAP);

console.log('Cleaning up tmp');
// remove tmp files
try {
  fs.unlinkSync(concatList);
  tmpWavs.forEach(w => fs.unlinkSync(w.path));
  fs.unlinkSync(spriteWav);
  fs.rmdirSync(tmpDir);
} catch (e) {
  // ignore cleanup errors
}

console.log('Done.');
