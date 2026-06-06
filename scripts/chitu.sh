#!/usr/bin/env bash
#
# chitu — 赤兔入口脚本
#
set -e

SCRIPT_SRC="$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")/.." && pwd)"
cd "$SCRIPT_DIR"

NEED_BUILD=false
if [ ! -d "$SCRIPT_DIR/dist" ]; then
  NEED_BUILD=true
else
  SRC_NEWEST=$(find src -name "*.ts" -type f -exec stat -f "%m" {} + 2>/dev/null | sort -rn | head -1)
  DIST_OLDEST=$(find dist -name "*.js" -type f -exec stat -f "%m" {} + 2>/dev/null | sort -rn | head -1)
  if [ -n "$SRC_NEWEST" ] && [ -n "$DIST_OLDEST" ] && [ "$SRC_NEWEST" -gt "$DIST_OLDEST" ] 2>/dev/null; then
    NEED_BUILD=true
  fi
fi

if [ "$NEED_BUILD" = true ]; then
  echo "🔨 构建赤兔..."
  node scripts/build.mjs 2>&1 | tail -5
fi

CHITU_MODE=normal exec node dist/entry.js "$@"
