#!/bin/bash

# Relay - Development Startup Script
# Thin wrapper around `npm run dev` (dev-server.sh), which already starts
# both the relay server (:8080) and the Next.js dev server (:3000) together.
# Don't start a second relay server here — it'll fight dev-server.sh for the port.

set -e

cd "$(dirname "$0")"

echo "🚀 Relay Startup"
echo "============================"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  npm install
  echo ""
fi

echo "📱 Starting Relay + Relay Server (http://localhost:3000, ws://localhost:8080)..."
echo ""

exec npm run dev
