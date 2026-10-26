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

node --test "$here/test/independence.test.mjs"

# client-*: 浏览器入口与它与宿主之间的桥；editor-*: 编辑器本体。
ELECTRON_RUN_AS_NODE=1 "$harness" --test --test-timeout=15000 "$here"/test/client-*.test.mjs
ELECTRON_RUN_AS_NODE=1 "$harness" --test --test-timeout=15000 "$here"/test/editor-*.test.mjs
ELECTRON_RUN_AS_NODE=1 "$harness" --expose-internals "$here/test/run.mjs"
