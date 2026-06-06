#!/usr/bin/env bash
# Generate an SBOM (SPDX JSON) for the vanguard sandbox image with syft.
#   docker/sbom.sh [image] [output]
set -euo pipefail
IMAGE="${1:-vanguard-sandbox:latest}"
OUT="${2:-docker/sbom.spdx.json}"

if ! command -v syft >/dev/null 2>&1; then
  echo "syft is required to generate the SBOM." >&2
  echo "Install: brew install syft  |  curl -sSfL https://get.anchore.io/syft | sh -s -- -b /usr/local/bin" >&2
  exit 1
fi

syft "${IMAGE}" -o "spdx-json=${OUT}"
echo "Wrote SBOM for ${IMAGE} to ${OUT}"
