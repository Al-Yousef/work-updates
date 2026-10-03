#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Install Xcode from the Mac App Store and launch it once, then run this again."
  exit 1
fi
if ! command -v xcodegen >/dev/null; then
  if command -v brew >/dev/null; then
    echo "Installing the project generator from Homebrew."
    brew install xcodegen
  else
    echo "Install XcodeGen from https://github.com/yonaskolb/XcodeGen, then run this again."
    exit 1
  fi
fi
xcodegen generate
echo "Select your Personal Team in Signing & Capabilities, select your connected iPhone, and click Run."
open WorkUpdates.xcodeproj
