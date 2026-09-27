# PandamStyle

Bibliothèque de styling à vocabulaire contraint : **fork de StyleX + modules
Panda CSS portés**. Objectif : les agents composent avec un vocabulaire de
design autorisé au lieu de réinventer les micro-décisions.

## Contenu du repo

| Chemin | Contenu |
|---|---|
| `packages/@stylexjs/*` | Code du fork StyleX (base `fe0be7f`, remote `upstream` → facebook/stylex) |
| `packages/@stylexjs/babel-plugin/pandamstyle/` | Modules PandamStyle : registre, politique, compilateur, recipe (portage `cva`), fixture `conformance` |
| `packages/@stylexjs/babel-plugin/__tests__/pandamstyle/` | 19 tests démontrant la chaîne tokens → recipe → CSS et les rejets `PMS_*` |
| `docs/pandamstyle-specification-v0.1/` | Spécification v0.1 (architecture, périmètre P0, acceptation, décisions) |
| `evidence/` | Baseline L0 (logs, rapport) + artefacts générés (CSS, manifeste, diagnostics, demo.html) |
| `upstream/panda/` | Donneur Panda CSS vendorisé @ `1a310482` (comparaison de portage) |
| `verify-pms.sh` | Script de vérification end-to-end |

## Vérifier le travail

```bash
./verify-pms.sh
```

Le script installe les deps (yarn 1, `--ignore-engines` requis sous node ≥ 25),
construit les `lib/` moteur (le postinstall upstream échoue partiellement sous
node 26 — déviations consignées dans `evidence/l0/BASELINE.md`), exécute les
suites upstream, puis la suite PandamStyle qui écrit les artefacts dans
`out-pandamstyle/` (configurable via `PMS_OUT_DIR`).

Références de réussite : 1007 tests upstream babel-plugin + 99 stylex +
19 pandamstyle, zéro échec. Logs de référence : `evidence/l0/` et
`evidence/demo/jest-pandamstyle.log`.

## Statut

**Prototype démontré** (voir `evidence/demo/REPORT.md`) — pas encore P0
conforme : traversée AST consommateur, unplugin/couverture, SSR, types générés
et mesures restent aux lots suivants (spec `02-P0-SCOPE.md` §8).
