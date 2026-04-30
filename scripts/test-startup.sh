#!/bin/sh
# Startup integration tests run inside the Docker tester stage.
#
# Each test confirms the app exits (or starts) as expected for a given config.
# Any failure causes this script to exit non-zero, which fails the Docker build.
#
# Exit-code contract (mirrors src/credentials.ts EXIT_CODES):
#   1  – CREDENTIALS_FILE not set
#   2  – credentials file is unreadable
#   3  – credentials file is not valid JSON
#   4  – credentials file is empty or structurally invalid
#   5  – a proxyToken matches a real githubPat in the file

set -eu

PASS=0
FAIL=0
STARTUP_TIMEOUT_SECONDS=10
STARTUP_POLL_INTERVAL=0.5
# Number of poll iterations derived from the two constants above (integer math: 10 / 0.5 = 20)
STARTUP_MAX_POLLS=20

# ── helpers ──────────────────────────────────────────────────────────────────

# assert_exits_nonzero <label> <expected-exit-code> [env-overrides] node dist/index.js
# Runs the app and checks that it exits with the given non-zero code.
assert_exits_nonzero() {
  label="$1"
  expected_code="$2"
  shift 2
  printf "  Testing: %s ... " "$label"
  actual_code=0
  timeout 5 "$@" >/dev/null 2>&1 || actual_code=$?
  if [ "$actual_code" -eq "$expected_code" ]; then
    echo "PASS (exit $actual_code)"
    PASS=$((PASS + 1))
  else
    echo "FAIL (expected exit $expected_code, got $actual_code)"
    FAIL=$((FAIL + 1))
  fi
}

# assert_starts_ok <label> -- <command...>
# Runs the app in the background, waits up to STARTUP_TIMEOUT_SECONDS for the
# "listening" message, then kills it.  Fails if the message never appears.
assert_starts_ok() {
  label="$1"
  shift
  printf "  Testing: %s ... " "$label"
  LOG=/tmp/startup-test-valid.log
  : >"$LOG"

  "$@" >"$LOG" 2>&1 &
  APP_PID=$!
  FOUND=0
  i=0
  while [ $i -lt $STARTUP_MAX_POLLS ]; do
    sleep $STARTUP_POLL_INTERVAL
    if grep -q "GitHub API proxy listening" "$LOG" 2>/dev/null; then
      FOUND=1
      break
    fi
    # Stop waiting if the process has already exited
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
  done

  kill "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true

  if [ "$FOUND" -eq 1 ]; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL (ready message not seen within ${STARTUP_TIMEOUT_SECONDS} s)"
    echo "  -- captured output --"
    cat "$LOG" || true
    FAIL=$((FAIL + 1))
  fi
}

# ── failure cases ─────────────────────────────────────────────────────────────

echo "=== Startup integration tests ==="
echo ""
echo "--- Failure cases (app should NOT start) ---"

# 1. No CREDENTIALS_FILE set → exit 1
assert_exits_nonzero \
  "No CREDENTIALS_FILE env var" 1 \
  env -i PATH="$PATH" node dist/index.js

# 2a. CREDENTIALS_FILE points to a non-existent file → exit 2
assert_exits_nonzero \
  "Credentials file does not exist" 2 \
  env -i PATH="$PATH" CREDENTIALS_FILE=/tmp/no-such-file.json node dist/index.js

# 2b. CREDENTIALS_FILE points to a file that exists but is not readable → exit 2
touch /tmp/test-unreadable.json
chmod 000 /tmp/test-unreadable.json
assert_exits_nonzero \
  "Credentials file exists but is not readable (EACCES)" 2 \
  env -i PATH="$PATH" CREDENTIALS_FILE=/tmp/test-unreadable.json node dist/index.js
rm -f /tmp/test-unreadable.json

# 3. Credentials file contains invalid JSON → exit 3
printf 'not valid json{{' >/tmp/test-invalid-json.json
assert_exits_nonzero \
  "Credentials file contains invalid JSON" 3 \
  env -i PATH="$PATH" CREDENTIALS_FILE=/tmp/test-invalid-json.json node dist/index.js

# 4. Credentials file contains an empty array → exit 4
printf '[]' >/tmp/test-empty.json
assert_exits_nonzero \
  "Credentials file is an empty array" 4 \
  env -i PATH="$PATH" CREDENTIALS_FILE=/tmp/test-empty.json node dist/index.js

# 5. proxyToken equals githubPat → exit 5
printf '[{"proxyToken":"same-token-abc","githubPat":"same-token-abc"}]' >/tmp/test-collision.json
assert_exits_nonzero \
  "proxyToken matches githubPat" 5 \
  env -i PATH="$PATH" CREDENTIALS_FILE=/tmp/test-collision.json node dist/index.js

# ── success case ──────────────────────────────────────────────────────────────

echo ""
echo "--- Success case (app SHOULD start) ---"

printf '[{"proxyToken":"fake-proxy-token-abc123","githubPat":"ghp_realValidToken456xyz"}]' >/tmp/test-valid.json
assert_starts_ok \
  "Valid credentials file" \
  env -i PATH="$PATH" CREDENTIALS_FILE=/tmp/test-valid.json PORT=3099 node dist/index.js

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
