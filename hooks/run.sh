#!/bin/sh
# agy-purge hook 启动器（macOS / Linux）
# 用法：hooks/run.sh pre-invocation.mjs
HERE=$(cd "$(dirname "$0")" && pwd)
NAME="$1"
if [ -z "$NAME" ]; then printf '{}\n'; exit 0; fi

if command -v node >/dev/null 2>&1; then
  exec node "$HERE/$NAME"
fi

for candidate in \
  "$HOME/Library/Application Support/Antigravity/bin/agy-node" \
  "$HOME/Library/Application Support/Antigravity/bin/agy-node.sh" \
  "/Applications/Antigravity.app/Contents/MacOS/Antigravity" \
  "/opt/Antigravity/antigravity" \
  "/usr/share/antigravity/antigravity"
do
  if [ -x "$candidate" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$candidate" "$HERE/$NAME"
  fi
done

printf '{}\n'
exit 0
