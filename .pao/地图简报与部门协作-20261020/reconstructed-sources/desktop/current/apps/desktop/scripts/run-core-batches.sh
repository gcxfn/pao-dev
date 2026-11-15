#!/bin/bash
# core 套件分批串行跑（每批独立 playwright 进程=新 worker，防 0xC0000142 长跑衰减）
# 批清单在 scripts/core-batches/core-batch-00..11（T09 定稿划分，共 112 个 spec 入口）
# 用法: 自 apps/desktop 运行 bash scripts/run-core-batches.sh [起批号] [止批号]   （批号 00-11，含止批号）
# 日志: 默认写当前目录 core-batches-<时间戳>.log，可用 CORE_BATCH_LOG=<路径> 指定
FROM=${1:-0}
TO=${2:-11}
APP="$(cd "$(dirname "$0")/.." && pwd)"
BATCHDIR="$APP/scripts/core-batches"
LOG=${CORE_BATCH_LOG:-"$APP/core-batches-$(date +%Y%m%d-%H%M%S).log"}
cd "$APP" || exit 9
for i in $(seq -f "%02g" "$FROM" "$TO"); do
  FILES=""
  while read -r f; do FILES="$FILES tests/core/$f"; done < "$BATCHDIR/core-batch-$i"
  echo "===== BATCH $i START $(date +%H:%M:%S) =====" >> "$LOG"
  PI_APP_TEST_LANE=core PI_APP_REAL_AUTH=0 PI_APP_TEST_MODE=background \
    pnpm exec playwright test -c playwright.config.ts $FILES >> "$LOG" 2>&1
  echo "===== BATCH $i EXIT=$? $(date +%H:%M:%S) =====" >> "$LOG"
done
echo "ALL_BATCHES_DONE" >> "$LOG"
