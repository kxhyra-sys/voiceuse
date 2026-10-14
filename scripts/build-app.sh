#!/bin/zsh
# Builds build/VoiceUse.app (release) and signs it. Voice, screen capture and input need a real
# app bundle: macOS only shows the Microphone / Speech / Screen Recording prompts for bundles that
# carry the usage strings below.
#
#   scripts/build-app.sh                         # ad-hoc signature (permissions reset on every rebuild)
#   SIGN_IDENTITY="Apple Development: …" scripts/build-app.sh   # stable signature keeps permissions
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release
BIN="$(swift build -c release --show-bin-path)/VoiceUse"

APP="build/VoiceUse.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/VoiceUse"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.voiceuse.app</string>
  <key>CFBundleName</key><string>VoiceUse</string>
  <key>CFBundleDisplayName</key><string>VoiceUse</string>
  <key>CFBundleExecutable</key><string>VoiceUse</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>VoiceUse listens for your spoken commands.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>VoiceUse turns your spoken commands into text on this Mac.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>VoiceUse needs to see the screen to act on your behalf.</string>
</dict>
</plist>
PLIST

codesign --force --sign "${SIGN_IDENTITY:--}" --identifier dev.voiceuse.app "$APP"
echo "Built $APP"
echo "Run:  open $APP"
