#!/bin/sh
# 兼容旧入口：执行 Design 的完整宿主测试。
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$task_root/plugins/design"
exec ./test.sh "$@"
