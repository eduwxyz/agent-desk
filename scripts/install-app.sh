#!/bin/sh
# Installs the built app in /Applications. Copying over a running app leaves
# it unable to quit normally, so it is closed first (after its replies end).
set -e
APP=/Applications/agent-desk.app
BUILT="$HOME/Library/Caches/agent-desk/dist/mac-arm64/agent-desk.app"
running() { pgrep -f "$APP/Contents/MacOS/agent-desk\$" >/dev/null; }
if running; then
  echo "Fechando o agent-desk aberto…"
  osascript -e 'with timeout of 20 seconds' -e 'tell application "agent-desk" to quit' -e 'end timeout' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do running || break; sleep 1; done
  if running; then echo "O agent-desk não fechou. Feche com ⌘Q e rode de novo." >&2; exit 1; fi
fi
ditto "$BUILT" "$APP"
echo "Instalado em $APP"
