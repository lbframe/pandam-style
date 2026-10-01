#!/usr/bin/env bash
# PandamStyle pilot - packs the built packages and installs them OUTSIDE the
# workspace, then runs the real Vite build.
#
# Why outside the workspace: a workspace alias can silently satisfy an import
# that a published package would not export. The pilot must consume the tarballs
# that npm would actually produce.
#
# Usage: tools/pilot/run-pilot.sh [work-dir]
# Exits non-zero on any failure; no step is allowed to hide an error.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${1:-${PMS_PILOT_DIR:-/tmp/pandamstyle-pilot}}"
# The pilot lives outside every workspace glob on purpose: as a workspace
# member, the root install would try to resolve @pandamstyle/compiler from
# the registry instead of linking the local workspace copy.
PILOT_SRC="${REPO_ROOT}/pilot/vite-react"

echo "== 1/6 pack the PandamStyle compiler and core =="
rm -rf "${WORK_DIR}"
mkdir -p "${WORK_DIR}"
PACK_DIR="${WORK_DIR}/.tarballs"
mkdir -p "${PACK_DIR}"

cd "${REPO_ROOT}/packages/compiler"
PMS_TARBALL=$(npm pack --pack-destination "${PACK_DIR}" --silent)
echo "packed ${PMS_TARBALL}"

cd "${REPO_ROOT}/packages/core"
CORE_TARBALL=$(npm pack --pack-destination "${PACK_DIR}" --silent)
echo "packed ${CORE_TARBALL}"

echo "== 2/6 verify the tarball contents and exports =="
for tgz in "${PACK_DIR}"/*.tgz; do
  echo "--- $(basename "${tgz}")"
  tar -tzf "${tgz}" | sort | sed 's/^/    /'
done

# The exports actually declared by the packed package, read from the tarball
# itself rather than from the source tree.
EXTRACT_DIR="${WORK_DIR}/.unpacked"
mkdir -p "${EXTRACT_DIR}"
PMS_TGZ="${PACK_DIR}/${PMS_TARBALL}"
tar -xzf "${PMS_TGZ}" -C "${EXTRACT_DIR}"
# Vite is the temporary Phase 8 verifier seam.
node -e '
const fs = require("fs");
const path = require("path");
const pkgDir = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
for (const key of [".", "./config", "./host", "./vite", "./package.json"]) {
  if (pkg.exports[key] == null) {
    console.error("MISSING EXPORT in the packed package: " + key);
    process.exit(1);
  }
}
// Every declared export target must really be inside the tarball.
for (const [key, value] of Object.entries(pkg.exports)) {
  const targets = typeof value === "string" ? [value] : Object.values(value);
  for (const t of targets) {
    if (!fs.existsSync(path.join(pkgDir, t))) {
      console.error("declared export target missing from the tarball: " + key + " -> " + t);
      process.exit(1);
    }
  }
}
console.log("packed exports ok:", Object.keys(pkg.exports).join(", "));
' "${EXTRACT_DIR}/package"

echo "== 3/6 copy the pilot app outside the workspace =="
APP_DIR="${WORK_DIR}/app"
cp -R "${PILOT_SRC}" "${APP_DIR}"
rm -rf "${APP_DIR}/node_modules" "${APP_DIR}/dist" "${APP_DIR}/.pandamstyle"

echo "== 4/6 install the packed tarballs into the app =="
cd "${APP_DIR}"
node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
const dir = process.argv[1];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"));
const pms = files.find((f) => f.startsWith("pandamstyle-compiler"));
const core = files.find((f) => f.startsWith("pandamstyle-core"));
if (pms == null || core == null) {
  console.error("missing expected tarballs:", files);
  process.exit(1);
}
p.dependencies["@pandamstyle/compiler"] = "file:" + path(dir, pms);
p.dependencies["@pandamstyle/core"] = "file:" + path(dir, core);
fs.writeFileSync("package.json", JSON.stringify(p, null, 2) + "\n");
console.log("dependencies pinned to local tarballs");
function path(a, b) { return a + "/" + b; }
' "${PACK_DIR}"

npm install --no-audit --no-fund --loglevel=error

echo "== 5/6 prove the app resolves the INSTALLED package, not the sources =="
node -e '
const fs = require("fs");
const path = require("path");
const pkgDir = path.dirname(require.resolve("@pandamstyle/compiler/package.json"));
const real = fs.realpathSync(pkgDir);
if (real.includes("/packages/@stylexjs/babel-plugin/")) {
  console.error("resolved to monorepo sources: " + real);
  process.exit(1);
}
if (!fs.existsSync(path.join(pkgDir, "lib", "vite.mjs"))) {
  console.error("installed package is missing lib/vite.mjs");
  process.exit(1);
}
const manifest = require("@pandamstyle/compiler/package.json");
console.log("resolved tarball at:", real);
console.log("version:", manifest.version);
const coreDir = path.dirname(require.resolve("@pandamstyle/core/package.json"));
const coreReal = fs.realpathSync(coreDir);
if (coreReal.includes("/packages/core/")) {
  console.error("core resolved to monorepo sources: " + coreReal);
  process.exit(1);
}
console.log("resolved packed core at:", coreReal);
'

node --input-type=module -e '
await import("@pandamstyle/compiler");
await import("@pandamstyle/compiler/config");
await import("@pandamstyle/compiler/host");
await import("@pandamstyle/core");
await import("@pandamstyle/compiler/vite");
console.log("installed compiler SDK, core and Vite verifier subpath import successfully");
'

echo "== 6/6 run the real Vite production build =="
npx vite build --logLevel warn

echo
echo "== pilot artifacts =="
find "${APP_DIR}/dist" -type f | sort | sed 's/^/  /'
echo
echo "== extracted PandamStyle stylesheet (head) =="
head -c 1200 "${APP_DIR}/dist/pandamstyle.css" || true
echo
echo "PILOT OK"
