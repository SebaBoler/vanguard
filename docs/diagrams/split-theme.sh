#!/bin/sh
# Splits an archify "Export → SVG" file (one auto-theme SVG) into <name>-light.svg and <name>-dark.svg
# next to this script, for the README's <picture> tags. The light copy also darkens the accent colours
# so the 8-9px labels keep a 4.5:1 contrast on GitHub's white background.
# Usage: docs/diagrams/split-theme.sh ~/Downloads/vanguard-factory-loop.svg factory-loop
set -eu
src=$1
out=$(dirname "$0")/$2
media='@media (prefers-color-scheme: light)'
sed -e "s/$media/@media all/" \
  -e 's/--cloud-stroke: #d97706/--cloud-stroke: #b45309/g' \
  -e 's/--messagebus-stroke: #ea580c/--messagebus-stroke: #c2410c/g' \
  -e 's/--backend-stroke: #059669/--backend-stroke: #047857/g' \
  -e 's/--security-stroke: #e11d48/--security-stroke: #be123c/g' \
  -e 's/--frontend-stroke: #0891b2/--frontend-stroke: #0e7490/g' \
  "$src" > "$out-light.svg"
sed "s/$media/@media not all/" "$src" > "$out-dark.svg"
