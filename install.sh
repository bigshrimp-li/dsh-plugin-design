#!/bin/sh
# 无参数继续安装 Design；--plugin ID 选择插件；--all 安装全部。
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$task_root/scripts/install-plugins.mjs" "$@"
