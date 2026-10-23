#!/bin/sh
# Installs or updates agent-desk:
#   curl -fsSL https://github.com/eduwxyz/agent-desk/releases/latest/download/install.sh | sh
# The app has no Apple certificate. A file curl downloads doesn't get the
# "from the internet" mark, so macOS opens it without the Gatekeeper warning
# a browser download would get. AGENT_DESK_ZIP points at another zip (a URL or
# a local file) and AGENT_DESK_DEST another folder, for testing a build
# before it is released (then it doesn't open the app).
set -e
REPO=eduwxyz/agent-desk
ZIP="${AGENT_DESK_ZIP:-https://github.com/$REPO/releases/latest/download/agent-desk-mac-arm64.zip}"

[ "$(uname -s)" = Darwin ] || { echo "O agent-desk é só pra macOS." >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "Por enquanto o agent-desk é só pra Macs com chip Apple (M1 em diante)." >&2; exit 1; }

DEST="${AGENT_DESK_DEST:-/Applications}"
[ -w "$DEST" ] || [ -n "$AGENT_DESK_DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
APP="$DEST/agent-desk.app"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Baixando o agent-desk…"
case "$ZIP" in
  http*) curl -fL --progress-bar -o "$TMP/agent-desk.zip" "$ZIP" ;;
  *) cp "$ZIP" "$TMP/agent-desk.zip" ;;
esac
ditto -x -k "$TMP/agent-desk.zip" "$TMP/app"
[ -d "$TMP/app/agent-desk.app" ] || { echo "O arquivo baixado não tem o agent-desk.app." >&2; exit 1; }

# Copying over a running app leaves it unable to quit normally: close it first.
running() { pgrep -f "$APP/Contents/MacOS/agent-desk\$" >/dev/null; }
if running; then
  echo "Fechando o agent-desk aberto…"
  osascript -e 'with timeout of 20 seconds' -e 'tell application "agent-desk" to quit' -e 'end timeout' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do running || break; sleep 1; done
  if running; then echo "O agent-desk não fechou. Feche com ⌘Q e rode de novo." >&2; exit 1; fi
fi

rm -rf "$APP"
ditto "$TMP/app/agent-desk.app" "$APP"
xattr -r -d com.apple.quarantine "$APP" >/dev/null 2>&1 || true
echo "Instalado em $APP"
[ -n "$AGENT_DESK_DEST" ] || open "$APP"
