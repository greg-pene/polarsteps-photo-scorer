#!/usr/bin/env bash
# Usage: ./analyze_photos.sh input.csv [output.csv]
#   input.csv  — CSV with image URLs in the first column (header row optional)
#   output.csv — defaults to input filename with _scored suffix
#
# Credentials are read from environment variables or a .env file:
#   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
#
# Copy .env.example to .env and fill in your values, or export them beforehand.

set -euo pipefail

SCRIPT_DIR="$(dirname "$0")"

# Load .env if present
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

INPUT="${1:?Usage: $0 <input.csv> [output.csv]}"
OUTPUT="${2:-${INPUT%.csv}_scored.csv}"

node "$SCRIPT_DIR/analyze_csv.mjs" "$INPUT" "$OUTPUT"
