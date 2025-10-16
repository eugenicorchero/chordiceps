#!/usr/bin/env bash
# Simple helper script example to build an audio sprite using ffmpeg.
# Adjust the inputs and offsets according to your filenames and desired ordering.
# Requires ffmpeg installed on your machine.

# Example: concatenate a few mp3 files into a single sprite (lossless concat not trivial for mp3)
# A safer approach is to re-encode to WAV, concat, then encode back to mp3.

set -euo pipefail

OUT_DIR="./audios/sprites"
mkdir -p "$OUT_DIR"

# List your source files in the desired order
FILES=(
  "./audios/C3-Maj.mp3"
  "./audios/Cs3-Maj.mp3"
  "./audios/D3-Maj.mp3"
)

# Temporary wavs
TMP_WAVS=()
for f in "${FILES[@]}"; do
  tmp="$(mktemp -u).wav"
  ffmpeg -y -i "$f" -ar 44100 -ac 1 "$tmp"
  TMP_WAVS+=("$tmp")
done

# Create a file list for ffmpeg concat
CONCAT_LIST="concat_list.txt"
rm -f "$CONCAT_LIST"
for w in "${TMP_WAVS[@]}"; do
  echo "file '$w'" >> "$CONCAT_LIST"
done

# concatenate into a single wav
ffmpeg -y -f concat -safe 0 -i "$CONCAT_LIST" -c copy "${OUT_DIR}/sprite_full.wav"

# encode to mp3 (or keep wav if you prefer)
ffmpeg -y -i "${OUT_DIR}/sprite_full.wav" -codec:a libmp3lame -qscale:a 2 "${OUT_DIR}/part1.mp3"

# cleanup
rm -f "$CONCAT_LIST"
for w in "${TMP_WAVS[@]}"; do rm -f "$w"; done
rm -f "${OUT_DIR}/sprite_full.wav"

echo "Sprite created at ${OUT_DIR}/part1.mp3"

echo "Now create a map.json listing offsets and durations for each original file."
