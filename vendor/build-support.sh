#!/bin/sh
# 重新打包 vendor/support.js。
#
#   ./build-support.sh <baocut 检出目录> <含 react@18.3.1 的 node_modules 目录>
#
# 画板运行时的入口 runtime/index.tsx 是自包含的：它只 import react / react-dom / react-dom/client，
# 然后挂到 window.React / window.ReactDOM 再 boot。所以一个 esbuild 调用就够，不需要别的依赖。
set -e

BAOCUT=${1:?用法: ./build-support.sh <baocut 检出目录> <node_modules 目录>}
NODE_MODULES=${2:?用法: ./build-support.sh <baocut 检出目录> <node_modules 目录>}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RUNTIME="$BAOCUT/packages/design-runtime/src/runtime"

[ -f "$RUNTIME/index.tsx" ] || { echo "找不到 $RUNTIME/index.tsx" >&2; exit 1; }

REACT_VERSION=$(node -p "require('$NODE_MODULES/react/package.json').version")
[ "$REACT_VERSION" = "18.3.1" ] || echo "注意：react 是 $REACT_VERSION，这套运行时预期 18.3.1" >&2

ESBUILD="$NODE_MODULES/.bin/esbuild"
[ -x "$ESBUILD" ] || ESBUILD=$(command -v esbuild) || { echo "找不到 esbuild" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp -r "$RUNTIME" "$WORK/runtime"
mkdir -p "$WORK/node_modules"
for pkg in react react-dom scheduler loose-envify js-tokens; do
  [ -e "$NODE_MODULES/$pkg" ] && ln -sfn "$NODE_MODULES/$pkg" "$WORK/node_modules/$pkg"
done

# 只 resolve 到 react —— 其余（设计系统 bundle、Babel）运行时按需加载，不打进来。
( cd "$WORK" && "$ESBUILD" runtime/index.tsx \
    --bundle --format=iife --platform=browser --target=es2022 \
    --outfile="$HERE/support.js" --log-level=warning )

echo "写出 $HERE/support.js ($(wc -c < "$HERE/support.js") 字节)"
shasum -a 256 "$HERE/support.js"
