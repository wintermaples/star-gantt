#!/usr/bin/env bash
set -euxo pipefail

sudo corepack enable

mkdir -p ~/.ssh && chmod 700 ~/.ssh
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null


if [ -f package.json ]; then
  corepack install
  pnpm install
  pnpm exec playwright install --with-deps chromium
fi
