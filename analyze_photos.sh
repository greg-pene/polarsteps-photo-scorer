#!/usr/bin/env bash
# Usage: ./analyze_photos.sh input.csv [output.csv]
#   input.csv  — CSV with image URLs in the first column (header row optional)
#   output.csv — defaults to input filename with _scored suffix

set -euo pipefail

INPUT="${1:?Usage: $0 <input.csv> [output.csv]}"
OUTPUT="${2:-${INPUT%.csv}_scored.csv}"

CLOUDINARY_CLOUD_NAME=${CLOUDINARY_CLOUD_NAME} \
CLOUDINARY_API_KEY=${CLOUDINARY_API_KEY} \
CLOUDINARY_API_SECRET=${CLOUDINARY_API_SECRET} \
  node "$(dirname "$0")/analyze_csv.mjs" "$INPUT" "$OUTPUT"
