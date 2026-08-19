#!/usr/bin/env bash
# Runs the Playwright E2E suite inside the official Playwright Docker image so
# that font packages and every other rendering-relevant OS detail are identical
# no matter which host (Debian devcontainer, Ubuntu CI runner, ...) launches it.
#
# The image tag is derived from the locally installed @playwright/test version,
# so the image and the test runner can never drift apart.
#
# Usage: tools/e2e-in-container.sh [playwright test args...]
#   e.g. tools/e2e-in-container.sh e2e/readonly.spec.ts
#        tools/e2e-in-container.sh --update-snapshots=all
#
# Environment passthrough: CI, STARGANTT_E2E_PORT, STARGANTT_SKIP_VISUAL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Error: the "docker" command is not available in this environment.

The E2E suite must run inside the pinned Playwright container image so that
screenshot baselines render identically on every machine. To fix this:

  - In the devcontainer: rebuild the container so the docker-in-docker feature
    declared in .devcontainer/devcontainer.json takes effect
    (VS Code: "Dev Containers: Rebuild Container").
  - On any other machine: please install Docker and try again.

If you only need the non-visual parts of the suite for quick local debugging,
you can still run "pnpm exec playwright test" directly on the host, but please
note that screenshot comparisons on the host are not authoritative and
baselines must never be updated there.
EOF
  exit 1
fi

VERSION="$(node -p "require('@playwright/test/package.json').version" 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  echo "Error: could not resolve the installed @playwright/test version." >&2
  echo "Please run \"pnpm install\" at the repository root first, then try again." >&2
  exit 1
fi
IMAGE="mcr.microsoft.com/playwright:v${VERSION}-noble"

ARCH="$(uname -m)"
UPDATING_SNAPSHOTS=""
for arg in "$@"; do
  case "$arg" in
    --update-snapshots=all) UPDATING_SNAPSHOTS="all" ;;
    --update-snapshots | --update-snapshots=* | -u)
      cat >&2 <<'EOF'
Error: baseline screenshots may only be regenerated with --update-snapshots=all.

The default "changed" mode only rewrites baselines for tests that failed, which
can silently leave stale baselines in place (this repository has a documented
incident where a real rendering regression stayed hidden that way — see
CLAUDE.md, section 6). Please re-run with:

  pnpm run test:e2e --update-snapshots=all
EOF
      exit 1
      ;;
  esac
done

if [ "$ARCH" != "x86_64" ]; then
  if [ -n "$UPDATING_SNAPSHOTS" ]; then
    cat >&2 <<EOF
Error: baseline screenshots must be generated on x86_64 (amd64), but this
machine is "$ARCH".

The committed baselines form a single amd64 lineage — CI compares against them
on amd64, and Chromium's rendering differs slightly between CPU architectures,
so baselines generated here would fail everywhere else.

To update baselines from this machine, please use the baseline-regeneration CI
workflow (or any amd64 machine) instead. Thank you!
EOF
    exit 1
  fi
  if [ -z "${STARGANTT_SKIP_VISUAL:-}" ]; then
    export STARGANTT_SKIP_VISUAL=1
    cat >&2 <<EOF
Note: this machine is "$ARCH", not x86_64, so screenshot comparisons are being
skipped automatically (STARGANTT_SKIP_VISUAL=1). Functional assertions still
run and are trustworthy here; the visual verdict comes from CI, which runs on
amd64 against the committed baselines.
EOF
  fi
fi

# --ipc=host is the Playwright-documented way to keep Chromium from crashing
# under Docker's default small /dev/shm. The container user mirrors the host
# user so that test-results/, playwright-report/ and regenerated baselines are
# not left behind as root-owned files. HOME=/tmp gives npx a writable cache.
ENV_ARGS=()
for var in CI STARGANTT_E2E_PORT STARGANTT_SKIP_VISUAL; do
  if [ -n "${!var:-}" ]; then
    ENV_ARGS+=(-e "$var=${!var}")
  fi
done

exec docker run --rm --init --ipc=host \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  "${ENV_ARGS[@]}" \
  -v "$ROOT:/work" \
  -w /work \
  "$IMAGE" \
  npx playwright test "$@"
