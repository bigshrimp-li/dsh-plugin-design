#!/bin/sh
# 用 DSH 自带的 Electron Node 跑四个工具的端到端自测。
# 需要 ELECTRON_RUN_AS_NODE：defineTool 在 app.asar 里，只有 Electron 的 Node 能读 asar。
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
harness="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"

if [ ! -x "$harness" ]; then
  echo "找不到 DeepSeek Harness：$harness" >&2
  exit 1
fi
(cd "$here" && npm run build)

ELECTRON_RUN_AS_NODE=1 "$harness" --test "$here/test/client-boot.test.mjs"
ELECTRON_RUN_AS_NODE=1 "$harness" --test "$here/test/editor-source.test.mjs" "$here/test/editor-server.test.mjs" "$here/test/editor-host.test.mjs"
ELECTRON_RUN_AS_NODE=1 "$harness" --expose-internals "$here/test/run.mjs"
