#!/bin/bash
# Patch Electron's helper app Info.plist files with NSMicrophoneUsageDescription
# and NSCameraUsageDescription keys. Required for macOS TCC to allow getUserMedia
# in dev mode (the renderer helper process calls getUserMedia, not the main process).
#
# Without these keys, macOS kills the process with SIGABRT before any JS error
# handling can kick in. This runs automatically via npm postinstall.

set -euo pipefail

ELECTRON_APP="node_modules/electron/dist/Electron.app"

if [ ! -d "$ELECTRON_APP" ]; then
  echo "[patch-electron-plist] Electron.app not found, skipping"
  exit 0
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "[patch-electron-plist] Not macOS, skipping"
  exit 0
fi

MIC_DESC="This app needs microphone access for voice calls."
CAM_DESC="This app needs camera access for video calls."

PATCHED=0
for plist in $(find "$ELECTRON_APP" -name "Info.plist" 2>/dev/null); do
  CHANGED=false
  if ! /usr/libexec/PlistBuddy -c "Print :NSMicrophoneUsageDescription" "$plist" &>/dev/null; then
    /usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string '$MIC_DESC'" "$plist"
    CHANGED=true
  fi
  if ! /usr/libexec/PlistBuddy -c "Print :NSCameraUsageDescription" "$plist" &>/dev/null; then
    /usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string '$CAM_DESC'" "$plist"
    CHANGED=true
  fi
  if [ "$CHANGED" = true ]; then
    PATCHED=$((PATCHED + 1))
  fi
done

if [ "$PATCHED" -gt 0 ]; then
  echo "[patch-electron-plist] Patched $PATCHED Info.plist file(s), re-signing..."
  codesign --force --deep --sign - "$ELECTRON_APP" 2>/dev/null || true
  echo "[patch-electron-plist] Done"
else
  echo "[patch-electron-plist] All Info.plist files already have usage descriptions"
fi
