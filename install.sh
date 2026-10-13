#!/bin/sh
# Build and install the plugin into a DSH profile, and install the two skills.
#
#   ./install.sh                      # -> --profile desktop
#   ./install.sh --profile web
#   DSH_BIN=/path/to/dsh ./install.sh
#
# Safe to re-run. Restart DSH afterwards: a changed plugin needs a fresh module generation.
set -e

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROFILE=desktop
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE=${2:?--profile needs a name}; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# 1. the dsh CLI: env override, then PATH, then the Desktop app bundle
DSH_BIN=${DSH_BIN:-}
if [ -z "$DSH_BIN" ]; then
  if command -v dsh >/dev/null 2>&1; then
    DSH_BIN=$(command -v dsh)
  elif [ -x "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" ]; then
    DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  else
    echo "找不到 dsh。把它放进 PATH，或用 DSH_BIN=/path/to/dsh 指出位置。" >&2
    exit 1
  fi
fi
echo "dsh: $DSH_BIN"

# 2. build dependencies, then the build
#    一次全新 clone 没有任何 node_modules，而 tsconfig 需要 @types/node —— 所以先装再编译。
if [ ! -d "$HERE/node_modules/typescript" ] || [ ! -d "$HERE/node_modules/@types/node" ]; then
  echo "安装构建依赖（typescript、@types/node）…"
  if command -v npm >/dev/null 2>&1; then
    (cd "$HERE" && npm install --no-audit --no-fund --loglevel=error)
  elif command -v pnpm >/dev/null 2>&1; then
    (cd "$HERE" && pnpm install --silent)
  else
    echo "找不到 npm 或 pnpm。" >&2
    exit 1
  fi
fi

# 用仓库里那份 tsc；没有才退回 PATH 上的
TSC="$HERE/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
  TSC=$(command -v tsc) || { echo "找不到 tsc。" >&2; exit 1; }
fi

echo "构建中…"
(cd "$HERE" && "$TSC" -p tsconfig.json)
(cd "$HERE" && node scripts/copy-editor-assets.mjs)
[ -f "$HERE/dist/index.js" ] || { echo "构建没有产出 dist/index.js" >&2; exit 1; }

# 3. skills -> <dsh home>/skills
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
mkdir -p "$DSH_HOME/skills"
for skill in design design-system; do
  rm -rf "$DSH_HOME/skills/$skill"
  cp -r "$HERE/skills/$skill" "$DSH_HOME/skills/$skill"
  echo "skill: $DSH_HOME/skills/$skill"
done

# 4. the plugin -> the profile
echo "安装插件到 profile \"$PROFILE\"…"
"$DSH_BIN" plugin --profile "$PROFILE" add "$HERE"

cat <<EOF

装好了。接下来：

  1. 完全退出并重启 DSH —— 插件模块要重新加载，新的工具才会出现。
  2. 随便说一句「做一版咖啡店的春季菜单海报」，看整条链路跑起来。

skill 是热加载的，重启前就已经生效；只有工具需要重启。
EOF
