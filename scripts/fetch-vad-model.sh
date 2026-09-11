#!/bin/sh
# Fetches the Silero VAD ONNX model used by the streaming loop's Endpointing.
set -eu
cd "$(dirname "$0")/.."
mkdir -p models
V5_URL="https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx"
V4_URL="https://raw.githubusercontent.com/snakers4/silero-vad/v4.0/files/silero_vad.onnx"
if curl -sSLf -o models/silero_vad.onnx "$V5_URL"; then
  echo "fetched v5 model"
else
  curl -sSLf -o models/silero_vad.onnx "$V4_URL"
  echo "fetched v4 fallback model"
fi
ls -la models/silero_vad.onnx
