#!/usr/bin/env bash
# PandamStyle — reproduction de la baseline + exécution des preuves.
# Usage: ./verify-pms.sh   (depuis la racine du repo)
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/4 install (yarn 1, lockfile upstream) =="
yarn install --frozen-lockfile --non-interactive --ignore-engines

echo "== 2/4 build des lib/ moteur (postinstall upstream incomplet sous node >= 25) =="
(cd packages/style-value-parser && ../../node_modules/.bin/babel src --out-dir lib --ignore "**/__tests__/**","**/__benchmarks__/**")
(cd packages/@stylexjs/shared && ../../node_modules/.bin/babel src/ --out-dir lib/)
(cd packages/@stylexjs/stylex \
  && ../../node_modules/.bin/cross-env BABEL_ENV=cjs ../../node_modules/.bin/rollup -c ./rollup.config.mjs \
  && ../../node_modules/.bin/cross-env BABEL_ENV=esm ../../node_modules/.bin/rollup -c ./rollup.config.mjs)
(cd packages/@stylexjs/babel-plugin && ../../node_modules/.bin/rollup --config ./rollup.config.mjs)

echo "== 3/4 suites de référence upstream =="
(cd packages/@stylexjs/babel-plugin && ../../node_modules/.bin/jest --ci)
(cd packages/@stylexjs/stylex && ../../node_modules/.bin/cross-env BABEL_ENV=test ../../node_modules/.bin/jest --ci)

echo "== 4/4 chaîne PandamStyle (tokens -> recipe -> CSS + rejets) =="
(cd packages/@stylexjs/babel-plugin \
  && PMS_OUT_DIR="${PMS_OUT_DIR:-./out-pandamstyle}" ../../node_modules/.bin/jest __tests__/pandamstyle/ --ci)

echo "OK — artefacts PandamStyle dans ${PMS_OUT_DIR:-packages/@stylexjs/babel-plugin/out-pandamstyle}"
