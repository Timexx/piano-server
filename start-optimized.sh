#!/bin/bash
# Optimized startup script for Piano Sheets
# Enables garbage collection control and memory monitoring

echo "Starting Piano Sheets with performance optimizations..."

# Set Node.js memory options for better iPad compatibility
export NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=64 --expose-gc"

# Enable garbage collection logging (optional, comment out for production)
# export NODE_OPTIONS="$NODE_OPTIONS --trace-gc"

# Set process priority (macOS)
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo "Setting process priority for macOS..."
    nice -n -5 node server.js
else
    node server.js
fi