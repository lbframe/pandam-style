#!/usr/bin/env bash
# Regenerates the CE-00.1 upstream observation and registry from isolated
# upstream downloads. Upstream data stays outside the repository; this script
# and the tools it runs stay inside it and receive upstream paths as arguments.
#
#   tests/core-evolution/tools/regenerate.sh <upstream-root> <work-dir>
#
# <upstream-root> must contain the layout described in tests/core-evolution/README.md:
#   pack/<package>_<version>/*.tgz   npm pack output, one new directory each
#   unpacked/_mdn_browser-compat-data_8.1.6/package/data.json
#   src/{stylex,panda,bcd}/          pinned source archives, extracted
#   src-archive/{stylex,panda,bcd}/  the downloaded archives
#   run-stylex/, run-panda/          npm install --ignore-scripts of the comparator
# <work-dir> receives the raw extraction and probe outputs.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <upstream-root> <work-dir>" >&2
  exit 2
fi
upstream=$(cd "$1" && pwd)
work=$2
repo=$(cd "$(dirname "$0")/../../.." && pwd)
tools="$repo/tests/core-evolution/tools"
mkdir -p "$work"
work=$(cd "$work" && pwd)
bcd_data="$upstream/unpacked/_mdn_browser-compat-data_8.1.6/package/data.json"
probe_project="$work/panda-probe-project"
rm -rf "$probe_project"

cd "$repo"
node "$tools/extract-upstream-keys.mjs" \
  --stylex-src "$upstream/src/stylex" --panda-src "$upstream/src/panda" \
  --bcd-data "$bcd_data" --out "$work/keys.json"
node "$tools/probe-stylex-emission.mjs" --install "$upstream/run-stylex" \
  --inventory docs/research/core-evolution-inventory.json \
  --keys "$work/keys.json" --out "$work/stylex-probe.json"
node "$tools/probe-panda-emission.mjs" --install "$upstream/run-panda" \
  --project "$probe_project" \
  --inventory docs/research/core-evolution-inventory.json \
  --keys "$work/keys.json" --out "$work/panda-probe.json"
node "$tools/observe-upstreams.mjs" \
  --evidence docs/research/core-evolution-evidence.json \
  --pack-root "$upstream/pack" --src-root "$upstream/src" \
  --archive-root "$upstream/src-archive" --bcd-data "$bcd_data" \
  --keys "$work/keys.json" \
  --stylex-probe "$work/stylex-probe.json" --panda-probe "$work/panda-probe.json" \
  --stylex-install "$upstream/run-stylex" --panda-install "$upstream/run-panda" \
  --repo "$repo" \
  --out docs/research/core-evolution-upstream-observations.v1.json
node "$tools/build-registry.mjs" --keys "$work/keys.json" \
  --stylex-probe "$work/stylex-probe.json" --panda-probe "$work/panda-probe.json" \
  --bcd-data "$bcd_data" --out docs/research/core-evolution-registry.v1.json
node tests/core-evolution/validate.mjs --self-test
