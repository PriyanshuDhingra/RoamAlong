#!/usr/bin/env bash
# Build the iOS app for a device or simulator, working around iCloud "Desktop & Documents" sync: the file provider
# tags folders it sees (com.apple.FinderInfo, fileprovider), and codesign rejects bundles carrying those tags
# ("resource fork, Finder information, or similar detritus not allowed"). Expo builds ExpoModulesJSI.framework
# inside node_modules during the build, so the tags can appear mid-build: strip them and retry.
#
#   scripts/ios-build.sh device <udid> [Debug|Release]
#   scripts/ios-build.sh sim <simulator-udid> [Debug|Release]
set -uo pipefail
cd "$(dirname "$0")/.."
kind="${1:?device|sim}"; udid="${2:?udid}"; config="${3:-Debug}"
dd="$HOME/Library/Developer/Xcode/DerivedData/Wander-$kind"
log="${LOG:-/tmp/wander-ios-build-$kind.log}"
export LANG=en_US.UTF-8
extra=(); [[ "$kind" == device ]] && extra=(-allowProvisioningUpdates)

for attempt in 1 2 3; do
  xattr -cr ios/Pods node_modules/expo-modules-jsi "$dd/Build/Products" 2>/dev/null
  xcodebuild -workspace ios/Wander.xcworkspace -scheme Wander -configuration "$config" -destination "id=$udid" \
    ${extra[@]+"${extra[@]}"} -derivedDataPath "$dd" build > "$log" 2>&1
  status=$?
  if [[ $status -eq 0 ]]; then
    echo "BUILD SUCCEEDED (attempt $attempt): $(ls -d "$dd"/Build/Products/*/Wander.app | head -1)"
    exit 0
  fi
  if ! grep -q "detritus not allowed" "$log"; then
    grep -E "error:|BUILD FAILED" "$log" | head -10
    exit $status
  fi
  echo "attempt $attempt: codesign rejected iCloud file tags; stripping and retrying"
done
echo "BUILD FAILED after 3 attempts (see $log)"; exit 1
