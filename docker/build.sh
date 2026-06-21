#!/usr/bin/env bash
set -euo pipefail
VERSION="${CLAUDE_CLI_VERSION:-2.1.165}"
TAG="${TAG:-vanguard-sandbox:latest}"
HERE="$(cd "$(dirname "$0")" && pwd)"
docker build --build-arg "CLAUDE_CLI_VERSION=${VERSION}" -t "${TAG}" "${HERE}"
echo "Zbudowano ${TAG} (claude ${VERSION})"
# Weryfikacja kontraktu CLI (R4): obecność narzędzi i flag.
docker run --rm "${TAG}" sh -lc 'claude --version && git --version && bun --version'
