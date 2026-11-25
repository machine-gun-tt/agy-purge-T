#!/bin/sh
# agy-purge 一键安装 / 卸载（macOS / Linux）
#   ./install.sh                     安装到用户级
#   ./install.sh --scope project     安装到当前仓库
#   ./install.sh --grants            同时写全局 Always Allow
#   ./install.sh --uninstall [--purge-prompt]
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
CLI="$ROOT/bin/agy-purge.mjs"

find_node() {
  if [ -n "${AGY_PURGE_NODE:-}" ] && [ -x "$AGY_PURGE_NODE" ]; then printf '%s' "$AGY_PURGE_NODE"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  for candidate in \
    "$HOME/Library/Application Support/Antigravity/bin/agy-node" \
    "/Applications/Antigravity.app/Contents/MacOS/Antigravity" \
    "/opt/Antigravity/antigravity"
  do
    if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  done
  return 1
}

NODE=$(find_node) || {
  echo "未找到可用的 Node.js（>=18）。装一个 Node，或设置 AGY_PURGE_NODE。" >&2
  exit 1
}

case "$NODE" in
  *Antigravity*|*antigravity*) export ELECTRON_RUN_AS_NODE=1 ;;
esac

MAJOR=$("$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "${MAJOR:-0}" -lt 18 ]; then
  echo "Node 版本过低（$MAJOR），需要 >= 18。" >&2
  exit 1
fi

echo "运行时: $NODE"
exec "$NODE" "$CLI" "$@"
