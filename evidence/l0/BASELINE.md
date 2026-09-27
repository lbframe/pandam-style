# L0 — Baseline exécutée (AC-001)

**Date : 2026-09-28 · machine : macOS Darwin 24.6.0 (arm64)**

## Sources épinglées

| Dépôt | Commit | Rôle | Checkout |
|---|---|---|---|
| facebook/stylex | `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2` | base du fork | `upstream/stylex` (fetch --depth 1, rev-parse vérifié) |
| chakra-ui/panda | `1a310482ff18102c44b2a478b7644b064a80d7c6` | donneur | `upstream/panda` (fetch --depth 1, rev-parse vérifié) |

## Environnement

- node `v26.10.0`, npm `11.19.1`, yarn `1.22.22` (installé pour le lockfile upstream ; repo déclare `packageManager: yarn@1.22.22`)
- Pas de pnpm installé ; la suite Panda n'a pas été exécutée (donneur de code, tests de référence = lecture, cf. LIMITES ci-dessous).

## Install et déviations consignées

- `yarn install --frozen-lockfile` : **échec** — `waku@1.0.0-alpha.0` exige node `^24|^22.12|^20.19`, node 26 installé. Relancé avec `--ignore-engines` → link complet.
- `postinstall` (`npm run build --workspaces`) : **échecs préexistants sous node 26**, non corrigés pour préserver la baseline :
  - `gen-types` (yargs CJS/ESM) échoue sur plusieurs packages → types `.d.ts` non générés.
  - `devtools-extension`, `docs` (waku), `example-sveltekit` : builds en échec.
  - Les `lib/` nécessaires aux tests ont été produites manuellement avec les outils du repo : `babel` (style-value-parser, shared) et `rollup` (stylex cjs+esm, babel-plugin). `@stylexjs/atoms` expose `src/` directement.

## Suites de référence exécutées (avant tout code PandamStyle)

| Suite | Commande | Résultat | Log |
|---|---|---|---|
| `@stylexjs/babel-plugin` | `jest --ci` (config du package) | **exit 0** — 42/43 suites, 1007 tests passés, 1 suite + 64 tests skipped, 887 snapshots | `jest-babel-plugin.log` |
| `@stylexjs/stylex` | `BABEL_ENV=test jest --ci` | **exit 0** — 4/4 suites, 99 tests passés, 74 snapshots | `jest-stylex.log` |

Après ajout du code PandamStyle (`pandamstyle/` + `__tests__/pandamstyle/`), relance complète :
**44/45 suites, 1026 tests passés (1007 + 19), 0 régression** → `jest-babel-plugin-after-pms.log`.

## Inventaire donneur (Panda @ 1a310482)

| Fichier | Lignes | Usage prévu |
|---|---|---|
| `packages/token-dictionary/src/dictionary.ts` | 677 | sémantique registre/références (portée, adaptée) |
| `packages/token-dictionary/src/token.ts` | 250 | identité/catégorie des tokens |
| `packages/core/src/utility.ts` | 572 | modèle propriété/catégorie (référence politique) |
| `packages/generator/src/artifacts/js/cva.ts` | 104 | sélection/défauts de recipe (porté dans `pandamstyle/recipe.js`) |
| `packages/preset-base/src/conditions.ts` | 124 | conditions `hover`/`disabled` avec `data-*`/ARIA |
| `packages/core/__tests__/atomic-recipe.test.ts` | 82 | référence de comportement recipe |
| `LICENSE.md` | MIT (Segun Adebayo) | obligations conservées |

Licence StyleX : MIT (Meta Platforms). Inventaire transitif : non exhaustif à ce stade (H-06 reste ouverte).

## Limites

- Suite Panda non exécutée : son fichier de test recipe sert de référence comportementale, pas de baseline exécutée (l'install pnpm n'a pas été tentée).
- Échecs de build postinstall documentés ci-dessus = préexistants sous cet environnement, distincts des régressions.
