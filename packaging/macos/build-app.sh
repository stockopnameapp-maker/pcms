#!/bin/bash
# Assembles PCMS.app (universal: Apple Silicon + Intel) from the repo. Runs on Linux.
set -euo pipefail
REPO=/home/claude/pcms
B=/tmp/claude-0/dmg/build
DL=/tmp/claude-0/dmg/dl
VERSION=1.0.2
NODEV=v22.23.3
PGV=16.14.0-beta.17
OUT=$B/out
APP=$OUT/PCMS.app
rm -rf "$OUT"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app" "$DL"
RES=$APP/Contents/Resources

# ---- 1. web build + API bundle (all JS deps inlined except native argon2 and pdfkit, which reads font files)
(cd "$REPO" && npm run build -w @pcms/web >/dev/null)
cp -R "$REPO/apps/web/dist" "$RES/app/web"
ESB="$REPO/node_modules/.bin/esbuild"
SHIM='import { createRequire as __cr } from "module"; import { fileURLToPath as __fu } from "url"; import { dirname as __dn } from "path"; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);'
EXT="--external:@node-rs/argon2 --external:pdfkit --external:pg-native"
"$ESB" "$REPO/apps/api/src/index.ts" --bundle --platform=node --target=node22 --format=esm $EXT --banner:js="$SHIM" \
  --outfile="$RES/app/api/server.mjs" --log-level=warning --legal-comments=none

# ---- 2. database scripts, bundled in place (same relative layout: scripts/, seed/, migrations/)
mkdir -p "$RES/app/db"
cp -R "$REPO/packages/db/migrations" "$RES/app/db/"
for f in scripts/reset.mjs scripts/migrate.mjs seed/seed.mjs; do
  "$ESB" "$REPO/packages/db/$f" --bundle --platform=node --target=node22 --format=esm $EXT --banner:js="$SHIM" \
    --outfile="$RES/app/db/$f" --log-level=warning --legal-comments=none
done
echo '{"type":"module","private":true}' > "$RES/app/db/package.json"

# ---- 3. the two non-bundleable packages, for macOS (both architectures)
mkdir -p "$B/deps" && cd "$B/deps" && rm -rf node_modules package-lock.json
node -e '
const v = (n) => require(process.argv[1] + "/node_modules/" + n + "/package.json").version;
const deps = { "@node-rs/argon2": v("@node-rs/argon2"), "pdfkit": v("pdfkit") };
require("fs").writeFileSync("package.json", JSON.stringify({ name: "pcms-runtime", private: true, type: "module", dependencies: deps }, null, 2));
' "$REPO"
npm install --omit=dev --os=darwin --cpu=arm64 --no-audit --no-fund --loglevel=error >/dev/null
A2=$(node -p "require('$REPO/node_modules/@node-rs/argon2/package.json').version")
npm install --no-save --force --os=darwin --cpu=x64 --no-audit --no-fund --loglevel=error "@node-rs/argon2-darwin-x64@$A2" "@node-rs/argon2-darwin-arm64@$A2" >/dev/null
rm -rf node_modules/@node-rs/argon2-linux-* node_modules/.package-lock.json
cp -R node_modules "$RES/app/node_modules"
cp package.json "$RES/app/package.json"

# ---- 4. runtimes (Node.js, PostgreSQL) are downloaded by the launcher on first launch, checksum-verified

# ---- 5. bundle metadata
cp "$B/PCMS.sh" "$APP/Contents/MacOS/PCMS"; chmod 755 "$APP/Contents/MacOS/PCMS"
cp "$B/AppIcon.icns" "$RES/AppIcon.icns"
echo "$VERSION" > "$RES/VERSION"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>PCMS</string>
  <key>CFBundleDisplayName</key><string>PCMS</string>
  <key>CFBundleIdentifier</key><string>id.pcms.clinic</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>PCMS</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.medical</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
du -sh "$APP" "$RES/app/"*
