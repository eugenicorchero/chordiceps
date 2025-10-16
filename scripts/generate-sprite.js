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

// Detect availability of ffprobe and ffmpeg
let hasFFProbe = true;
let hasFFmpeg = true;
try {
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch (e) {
  hasFFProbe = false;
}
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch (e) {
  hasFFmpeg = false;
}

// Optional fallback: music-metadata for reading duration without ffprobe
let mm = null;
if (!hasFFProbe) {
  try {
    mm = require('music-metadata');
  } catch (e) {
    // not installed - we'll warn later if needed
    mm = null;
  }
}

// Helper to get duration. Prefer ffprobe; fall back to music-metadata if available.
function getDuration(file) {
  if (hasFFProbe) {
    try {
      const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf8' });
      return parseFloat(out.trim());
    } catch (e) {
      console.error('ffprobe failed for', file, e.message);
      // fall through to metadata
    }
  }

  if (mm) {
    try {
      const stat = fs.readFileSync(file);
      const meta = mm.parseBuffer(stat, path.extname(file).slice(1));
      // parseBuffer returns a promise in some versions; handle both
      if (meta && meta.then) {
        // synchronous flow expects duration; bail out
        console.warn('music-metadata parseBuffer returned a promise; please run the script with Node >= the package supports or install ffprobe.');
        return null;
      }
      if (meta && meta.format && meta.format.duration) return meta.format.duration;
    } catch (e) {
      // try async API as last resort
      try {
        return null; // we'll handle async path below in main flow if needed
      } catch (err) {
        return null;
      }
    }
  }

  // No way to measure duration here
  return null;
}

// Find all mp3 (or wav) files in AUDIO_DIR (ignore sprites subdir)
const files = fs.readdirSync(AUDIO_DIR).filter(f => {
  const full = path.join(AUDIO_DIR, f);
  if (!fs.statSync(full).isFile()) return false;
  if (f === 'sprites' || f.startsWith('sprites/')) return false;
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
const skipped = [];
for (const f of files) {
  const m = f.match(/^(.+?)\.(mp3|wav|ogg|m4a)$/i);
  if (!m) {
    skipped.push({ file: f, reason: 'extension mismatch' });
    continue;
  }
  if (!m) continue;
  const name = m[1];
  // Attempt to parse name as <Root><octave>-<Chord>, e.g., Cs3-Maj
  const dash = name.indexOf('-');
  if (dash === -1) { skipped.push({ file: f, reason: 'no dash in name' }); continue; }
  const root = name.slice(0, dash);
  const chord = name.slice(dash + 1);
  const fullPath = path.join(AUDIO_DIR, f);

  // Try synchronous duration first
  let duration = getDuration(fullPath);

  // If we couldn't get duration synchronously but music-metadata is available, try async path
  if ((duration === null || isNaN(duration)) && mm && !hasFFProbe) {
    try {
      // use async API
      const data = fs.readFileSync(fullPath);
      mm.parseBuffer(data, path.extname(fullPath).slice(1)).then(meta => {
        // This async result cannot easily be returned here; we'll let the file pass through and handle durations later
      }).catch(() => {});
    } catch (e) {
      // ignore
    }
  }

  if (!duration) {
    if (!hasFFProbe && mm) {
      // try a simple async-blocking call via music-metadata's parseFile (synchronous wrapper not available), fallback to null
      try {
        const meta = require('child_process').execSync(`node -e "(async()=>{const mm=require('music-metadata');const m=await mm.parseFile('${fullPath.replace(/'/g, "'\\''")}');console.log(m.format.duration||'');})()"`, { encoding: 'utf8' }).trim();
        duration = meta ? parseFloat(meta) : null;
      } catch (e) {
        duration = null;
      }
    }
  }

  // If duration is missing and we have ffprobe available, skip (we expect accurate durations).
  if ((!duration || isNaN(duration)) && hasFFProbe) {
    skipped.push({ file: f, reason: 'no duration (ffprobe expected)' });
    console.warn('Skipping file (no duration):', f);
    continue;
  }

  // Push the item even if duration is null (we can still create a per-file map when ffmpeg is missing)
  items.push({ file: fullPath, name, root, chord, duration: duration || 0 });
}

if (!items.length) {
  console.error('No parseable audio items found. Filenames must be like Cs3-Maj.mp3');
  if (skipped.length) {
    console.error('Skipped files and reasons:');
    for (const s of skipped) console.error(' -', s.file, ':', s.reason);
  } else {
    console.error('No files matched the extension filter. Found files:', files.join(', '));
  }
  process.exit(1);
}

// If ffmpeg is not available, produce a per-file map.json so the app can fallback
if (!hasFFmpeg) {
  console.log('ffmpeg not found on PATH — generating per-file map.json (no sprites will be created).');
  const perFileMap = {};
  for (const it of items) {
    const m = it.name.match(/^([A-G]s?)(-?\d+)-?(.+)?$/);
    let midiKey = it.name;
    if (m) {
      const note = m[1];
      const octave = parseInt(m[2], 10);
      const fileNotesMap = {C:0, Cs:1, D:2, Ds:3, E:4, F:5, Fs:6, G:7, Gs:8, A:9, As:10, B:11};
      if (note in fileNotesMap) {
        const midi = (octave + 1) * 12 + fileNotesMap[note];
        midiKey = `${midi}-${it.chord}`;
      }
    }
    const rel = `./audios/${path.basename(it.file)}`;
    perFileMap[midiKey] = { sprite: rel, offset: 0, duration: Math.round((it.duration||0) * 1000) / 1000 };
  }
  try {
    fs.writeFileSync(OUT_MAP, JSON.stringify(perFileMap, null, 2), 'utf8');
    console.log('Wrote per-file map to', OUT_MAP);
    console.log('Note: no sprite files were generated because ffmpeg is missing; the app will need to fetch individual audio files using these paths.');
  } catch (e) {
    console.error('Failed to write map file:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

// Helper to build a sprite from a set of items and produce a map for them
function buildSpriteFor(groupItems, outSpritePath) {
  if (!groupItems || !groupItems.length) return {};
  const tmpDirLocal = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sprite-'));
  const tmpWavsLocal = [];
  console.log('Using tmp dir', tmpDirLocal, 'for', outSpritePath);

  for (let i = 0; i < groupItems.length; i++) {
    const it = groupItems[i];
    const tmpWav = path.join(tmpDirLocal, `part-${i}.wav`);
    const res = spawnSync('ffmpeg', ['-y', '-i', it.file, '-ar', '44100', '-ac', '1', tmpWav], { stdio: 'inherit' });
    if (res.status !== 0) {
      console.error('ffmpeg failed converting', it.file);
      // cleanup and abort this group
      try { fs.rmdirSync(tmpDirLocal, { recursive: true }); } catch(e) {}
      return {};
    }
    tmpWavsLocal.push({ path: tmpWav, duration: it.duration, name: it.name, root: it.root, chord: it.chord });
  }

  const concatListLocal = path.join(tmpDirLocal, 'concat.txt');
  fs.writeFileSync(concatListLocal, tmpWavsLocal.map(w => `file '${w.path.replace(/'/g, "'\\''")}'`).join('\n'));

  const spriteWavLocal = path.join(tmpDirLocal, 'sprite_full.wav');
  console.log('Concatenating to', spriteWavLocal);
  const concatResLocal = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatListLocal, '-c', 'copy', spriteWavLocal], { stdio: 'inherit' });
  if (concatResLocal.status !== 0) {
    console.error('ffmpeg concat failed');
    try { fs.rmdirSync(tmpDirLocal, { recursive: true }); } catch(e) {}
    return {};
  }

  console.log('Encoding sprite to mp3:', outSpritePath);
  const encodeResLocal = spawnSync('ffmpeg', ['-y', '-i', spriteWavLocal, '-codec:a', 'libmp3lame', '-qscale:a', '2', outSpritePath], { stdio: 'inherit' });
  if (encodeResLocal.status !== 0) {
    console.error('ffmpeg encode failed');
    try { fs.rmdirSync(tmpDirLocal, { recursive: true }); } catch(e) {}
    return {};
  }

  // Build map entries
  const mapEntries = {};
  let offsetLocal = 0.0;
  for (const w of tmpWavsLocal) {
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
    const spriteRel = `./audios/sprites/${path.basename(outSpritePath)}`;
    mapEntries[midiKey] = { sprite: spriteRel, offset: Math.round(offsetLocal * 1000) / 1000, duration: Math.round(w.duration * 1000) / 1000 };
    offsetLocal += w.duration;
  }

  // write per-group map
  try {
    const groupMapPath = outSpritePath.replace(/\.(mp3|wav)$/i, '.map.json');
    fs.writeFileSync(groupMapPath, JSON.stringify(mapEntries, null, 2), 'utf8');
    console.log('Wrote group map to', groupMapPath);
  } catch (e) {
    console.warn('Unable to write group map file', e.message);
  }

  // cleanup
  try { fs.unlinkSync(concatListLocal); tmpWavsLocal.forEach(w => fs.unlinkSync(w.path)); fs.unlinkSync(spriteWavLocal); fs.rmdirSync(tmpDirLocal); } catch(e) {}
  return mapEntries;
}

// Build sprites for groups: easy / medium / hard
const groups = {
  easy: ['Maj','Men'],
  medium: ['Maj','Men','Aug','Dim']
};

const groupItems = { easy: [], medium: [], hard: [] };
// Distribute items into groups
items.forEach(it => {
  const chord = it.chord;
  if (!chord) return;
  if (groups.easy.includes(chord)) groupItems.easy.push(it);
  if (groups.medium.includes(chord)) groupItems.medium.push(it);
  groupItems.hard.push(it); // hard contains everything
});

const mergedMap = {};

// Ensure out dir
if (!fs.existsSync(path.dirname(OUT_SPRITE))) fs.mkdirSync(path.dirname(OUT_SPRITE), { recursive: true });

// Helper to resolve out name per group
function outForGroup(name) {
  return path.join(path.dirname(OUT_SPRITE), `${name}.mp3`);
}

['easy','medium','hard'].forEach(g => {
  console.log('Building sprite for group:', g, 'items:', groupItems[g].length);
  if (!groupItems[g].length) { console.log('No items for group', g); return; }
  const outPath = outForGroup(g);
  const mapForGroup = buildSpriteFor(groupItems[g], outPath);
  Object.assign(mergedMap, mapForGroup);
});

// write merged map.json
fs.writeFileSync(OUT_MAP, JSON.stringify(mergedMap, null, 2), 'utf8');
console.log('Merged map written to', OUT_MAP);

console.log('Done.');
