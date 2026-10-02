#!/bin/bash
# Relay Dev Server - Runs Next.js and Relay concurrently

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🚀 Relay - Development Server${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${GREEN}Starting:${NC}"
echo "  • Next.js dev server (port 3000)"
echo "  • Relay server (port 8080)"
echo ""
echo -e "${BLUE}Press Ctrl+C to stop both servers${NC}"
echo ""

# Kill any stale process on port 8080 before starting
EXISTING_PID=$(lsof -ti:8080 2>/dev/null | head -1)
if [ -n "$EXISTING_PID" ]; then
  echo -e "${BLUE}Killing stale relay (pid $EXISTING_PID) on port 8080...${NC}"
  kill "$EXISTING_PID" 2>/dev/null
  sleep 1
fi

# Start relay server in background
echo -e "${GREEN}[1/2]${NC} Starting relay server..."
./node_modules/.bin/ts-node --project tsconfig.server.json server/relay-node.ts &
RELAY_PID=$!

# Give relay a moment to start
sleep 2

# Start Next.js custom dev server (port 3000) with WebSocket proxy (→ port 8080)
echo -e "${GREEN}[2/2]${NC} Starting Next.js dev server with WebSocket proxy..."
echo ""

# Function to cleanup on exit
cleanup() {
  echo ""
  echo -e "${BLUE}Shutting down...${NC}"
  kill $RELAY_PID 2>/dev/null
  exit 0
}

# Set up trap to catch SIGINT and SIGTERM
trap cleanup SIGINT SIGTERM

# Run custom server (Next.js + WS proxy) in foreground
node server.js

# If server exits, clean up relay
cleanup
