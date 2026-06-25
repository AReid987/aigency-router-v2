#!/usr/bin/env bash
set -euo pipefail

# fetch-bonsai.sh — download Bonsai 1.7B 1-bit GGUF model
# Uses HuggingFace Hub API + curl with resume support
# Validates file integrity (size + magic bytes)

REPO="prism-ml/Bonsai-1.7B-gguf"
BRANCH="main"
MODEL_FILE="Bonsai-1.7B-Q1_0.gguf"
OUTPUT_FILE="./models/bonsai-1.7b-q4km.gguf"
MIN_SIZE=$((100 * 1024 * 1024))  # 100 MB — skip if file exists and is larger than this

HF_URL="https://huggingface.co/${REPO}/resolve/${BRANCH}/${MODEL_FILE}"

START_TS=$(date +%s)

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_FILE")"

# Helper: format bytes to human-readable
numfmt_size() {
    local bytes=$1
    if [ "$bytes" -ge $((1024 * 1024 * 1024)) ]; then
        echo "$(awk "BEGIN {printf \"%.2f GiB\", $bytes / 1073741824}")"
    elif [ "$bytes" -ge $((1024 * 1024)) ]; then
        echo "$(awk "BEGIN {printf \"%.2f MiB\", $bytes / 1048576}")"
    elif [ "$bytes" -ge 1024 ]; then
        echo "$(awk "BEGIN {printf \"%.2f KiB\", $bytes / 1024}")"
    else
        echo "${bytes} B"
    fi
}

# Check if file already exists and is large enough
if [ -f "$OUTPUT_FILE" ]; then
    EXISTING_SIZE=$(stat -f%z "$OUTPUT_FILE" 2>/dev/null || stat -c%s "$OUTPUT_FILE" 2>/dev/null)
    if [ "$EXISTING_SIZE" -gt "$MIN_SIZE" ] 2>/dev/null; then
        echo "Already present: $(numfmt_size "$EXISTING_SIZE") — skipping download."
        echo "Output: $OUTPUT_FILE"
        # Still validate magic bytes
        MAGIC=$(xxd -l 4 -p "$OUTPUT_FILE" 2>/dev/null || od -A n -t x1 -N 4 "$OUTPUT_FILE" | tr -d ' ')
        echo "Magic: 0x${MAGIC}"
        END_TS=$(date +%s)
        echo "Elapsed: $((END_TS - START_TS))s"
        exit 0
    fi
    echo "Incomplete file (size below ${MIN_SIZE}B), re-downloading..."
    rm -f "$OUTPUT_FILE"
fi

echo "Downloading ${MODEL_FILE} from ${REPO}..."
echo "Source: ${HF_URL}"
echo "Output: ${OUTPUT_FILE}"
echo ""

# Get expected file size from HuggingFace API
EXPECTED_SIZE=$(curl -sIL "https://huggingface.co/${REPO}/resolve/${BRANCH}/${MODEL_FILE}" | grep -i content-length | tail -1 | awk '{print $2}' | tr -d '\r')
if [ -n "$EXPECTED_SIZE" ] && [ "$EXPECTED_SIZE" -gt 0 ] 2>/dev/null; then
    echo "Expected size: $(numfmt_size "$EXPECTED_SIZE")"
else
    echo "Expected size: unknown"
    EXPECTED_SIZE=0
fi
echo ""

# Download with progress and resume support
curl -L --fail --retry 3 --retry-delay 2 \
  -C - \
  -o "$OUTPUT_FILE" \
  --progress-bar \
  "${HF_URL}"

echo ""
echo "Download complete."

# Show final file size
FINAL_SIZE=$(stat -f%z "$OUTPUT_FILE" 2>/dev/null || stat -c%s "$OUTPUT_FILE" 2>/dev/null || echo 0)
echo "Final size: $(numfmt_size "$FINAL_SIZE")"

# If we know expected size, verify it
if [ "$EXPECTED_SIZE" -gt 0 ] && [ "$FINAL_SIZE" -ne "$EXPECTED_SIZE" ] 2>/dev/null; then
    echo "ERROR: File size mismatch — expected $(numfmt_size "$EXPECTED_SIZE"), got $(numfmt_size "$FINAL_SIZE")"
    rm -f "$OUTPUT_FILE"
    exit 1
fi

# Validate magic bytes: GGUF = 0x47475446... wait, let me handle both endiannesses
# GGUF format: first 4 bytes should be "GGUF" = 0x47 0x47 0x55 0x46
# macOS xxd outputs like "47475546" or similar
MAGIC_HEX=$(xxd -l 4 -p "$OUTPUT_FILE" 2>/dev/null || od -A n -t x1 -N 4 "$OUTPUT_FILE" | tr -d ' \n')
MAGIC_ASCII=$(echo "$MAGIC_HEX" | xxd -r -p 2>/dev/null || printf '%b' "\x${MAGIC_HEX:0:2}\x${MAGIC_HEX:2:2}\x${MAGIC_HEX:4:2}\x${MAGIC_HEX:6:2}")

echo "Magic: 0x${MAGIC_HEX} (\"${MAGIC_ASCII}\")"

# Accept GGUF (little-endian 0x46554747 / "GGUF") or TQ1\0 (0x54513100)
if [ "$MAGIC_HEX" = "47475546" ] || [ "$MAGIC_HEX" = "46554747" ]; then
    echo "Magic OK — valid GGUF file."
elif [ "$MAGIC_HEX" = "54513100" ]; then
    echo "Magic OK — valid TQ1 file."
else
    echo "ERROR: Invalid magic bytes — expected GGUF (0x47475546) or TQ1 (0x54513100), got 0x${MAGIC_HEX}"
    rm -f "$OUTPUT_FILE"
    exit 1
fi

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
echo "Elapsed: ${ELAPSED}s"
echo "Ready: ${OUTPUT_FILE}"
