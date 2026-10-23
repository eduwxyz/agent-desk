#!/bin/sh
# Builds the .dmg and .zip for Apple Silicon and publishes them as a GitHub
# release, tagged with package.json's version. No Apple certificate: the app
# gets an ad-hoc signature, the least an Apple Silicon Mac runs. People install
# with install.sh (no Gatekeeper warning) or open the .dmg and allow it once in
# System Settings. --sem-publicar builds and stops, for testing.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
OUT="$HOME/Library/Caches/agent-desk/release"

if [ "$1" != "--sem-publicar" ]; then
  [ -z "$(git status --porcelain)" ] || { echo "Há mudanças não commitadas." >&2; exit 1; }
  gh release view "$TAG" >/dev/null 2>&1 && { echo "A release $TAG já existe: suba a versão no package.json." >&2; exit 1; }
fi

npm run build
npx electron-builder --mac dmg zip --arm64 --publish never \
  --config.directories.output="$OUT" \
  --config.mac.identity=- \
  --config.artifactName='${productName}-mac-${arch}.${ext}'

codesign --verify --deep --strict "$OUT/mac-arm64/agent-desk.app"
echo "Assinatura local ok. Arquivos em $OUT:"
ls -lh "$OUT"/agent-desk-mac-arm64.*

[ "$1" = "--sem-publicar" ] && exit 0
git push origin HEAD
gh release create "$TAG" "$OUT/agent-desk-mac-arm64.dmg" "$OUT/agent-desk-mac-arm64.zip" install.sh \
  --target "$(git rev-parse HEAD)" --title "agent-desk $VERSION" --notes-file docs/release-notes.md
