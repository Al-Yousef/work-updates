#!/bin/bash
# Local synthetic checks only: no Codex account, publication or physical-device signing.
set -euo pipefail
task_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$task_root"
for task_tool in node swift xcodegen xcrun xcodebuild; do
  command -v "$task_tool" >/dev/null || { echo "Missing $task_tool. Install Xcode, Node and XcodeGen before running these checks."; exit 1; }
done
test -d node_modules/selfsigned || { echo "Run npm ci in the source folder first."; exit 1; }
export WU_TEST_CODE_FILE=/tmp/work-updates-ios-pairing-code
test ! -e "$WU_TEST_CODE_FILE" || { echo "A synthetic fixture is already present. Finish that check before starting another."; exit 1; }
task_output="$task_root/artifacts/apple-candidate-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$task_output"
node scripts/ios-fixture.cjs > "$task_output/fixture.log" 2>&1 &
task_fixture_pid=$!
task_cleanup() {
  kill "$task_fixture_pid" 2>/dev/null || true
  wait "$task_fixture_pid" 2>/dev/null || true
}
trap task_cleanup EXIT
for task_attempt in {1..30}; do
  test -f "$WU_TEST_CODE_FILE" && break
  kill -0 "$task_fixture_pid" 2>/dev/null || { cat "$task_output/fixture.log"; exit 1; }
  sleep 1
done
test -f "$WU_TEST_CODE_FILE" || { cat "$task_output/fixture.log"; exit 1; }
swift test --package-path ios/Core 2>&1 | tee "$task_output/core.log"
(cd ios && xcodegen generate)
task_simulator=$(xcrun simctl list devices available -j | node -e 'let input="";process.stdin.on("data",d=>input+=d);process.stdin.on("end",()=>{const phone=Object.values(JSON.parse(input).devices).flat().find(d=>d.name.startsWith("iPhone"));if(!phone)process.exit(1);process.stdout.write(phone.udid);});')
xcodebuild -project ios/WorkUpdates.xcodeproj -scheme WorkUpdates \
  -destination "platform=iOS Simulator,id=$task_simulator" \
  -derivedDataPath "$task_output/DerivedData" -resultBundlePath "$task_output/regression.xcresult" \
  CODE_SIGNING_ALLOWED=NO test 2>&1 | tee "$task_output/simulator.log"
echo "Apple checks passed. Evidence: $task_output"
