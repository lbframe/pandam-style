# Sources et périmètre de lecture

**Date : 27 septembre 2026. Méthode : plugin GitHub, lecture seule des dépôts.**

Les références ci-dessous pointent vers des commits immuables. « Fichier complet » signifie contenu lu, pas exécution ni certification exhaustive. Les parcours incomplets sont indiqués. Les répertoires ont également été parcourus via les arbres Git et l’API Contents ; seuls les fichiers utilisés comme preuves sont indexés ici.

## Révisions

| Dépôt / canal | Référence auditée | Commit |
|---|---|---|
| StyleX | `main` | `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2` |
| Panda stable v1 | tag `@pandacss/postcss@1.12.1` | `1a310482ff18102c44b2a478b7644b064a80d7c6` |
| Panda développement v2 | branche `v2` | `c171f630adc6dec4a1f9e4b9a79ef706d8278aae` |

Le tag annoté Panda a été résolu jusqu’au commit, et non confondu avec son objet Git `0eeeb891145622b7737a96dc402ef14208851f16`. La branche par défaut Panda et le snapshot stable ne sont pas interchangeables. Ce dossier n’affirme pas que chaque fonctionnalité de la branche est publiée sur le canal stable.

## Pièces fournies et autorité des décisions

Le bundle `lbframe-stylex-panda-fork-bundle.zip` fournit le besoin, le classement P0/P1/P2 et le format du dossier. `Texto colado(5).txt` fournit le cheminement et le principe « composition, not micro-design ». Les échanges suivants imposent le nom **PandamStyle**, le **véritable fork**, et le **portage de pièces de Panda** : ils remplacent les formulations historiques « couche LB Frame » et « simples idées de Panda ».

Ce sont des sources d’intention produit, pas des preuves du comportement actuel des compilateurs. Les chemins de fichiers du bundle sont référencés tels quels dans l’analyse ; ils ne sont pas présentés comme des URLs GitHub.

## Sources primaires citées

### SX-01

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/index.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/index.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Entrée et traversées reçues dans le premier extrait ; émission CSS relue explicitement aux lignes 500–915.

### SX-02

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Lignes 1–255.

### SX-03

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/stylex-create.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Fichier complet.

### SX-04

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Fichier complet.

### SX-05

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/utils/state-manager.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/utils/state-manager.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Lignes 1–220.

### SX-06

[facebook/stylex — `packages/@stylexjs/stylex/src/stylex.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Lignes 1–285.

### SX-07

[facebook/stylex — `packages/@stylexjs/stylex/__tests__/stylex-test.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/__tests__/stylex-test.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : test. Lecture : Fichier complet ; tests lus, non exécutés.

### SX-08

[facebook/stylex — `packages/@stylexjs/atoms/README.md`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/atoms/README.md)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : documentation. Lecture : Fichier complet ; invocation de la transformation recoupée dans SX-01.

### SX-09

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Fichier complet.

### SX-10

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Fichier complet.

### SX-11

[facebook/stylex — `packages/@stylexjs/unplugin/src/core.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lecture : Lignes 1–500 ; adaptateurs individuels non audités intégralement.

### SX-12

[facebook/stylex — `LICENSE`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/LICENSE)

Révision : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : license. Lecture : Fichier complet.

### PD-01

[chakra-ui/panda — `packages/generator/src/artifacts/types/style-props.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/types/style-props.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Fichier complet.

### PD-02

[chakra-ui/panda — `packages/core/src/utility.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Lignes 1–530.

### PD-03

[chakra-ui/panda — `packages/token-dictionary/src/dictionary.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Lignes 1–545 ; fin des vues dérivées non lue.

### PD-04

[chakra-ui/panda — `packages/token-dictionary/src/token.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/token.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Lignes 1–240.

### PD-05

[chakra-ui/panda — `packages/generator/src/artifacts/js/cva.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Fichier complet.

### PD-06

[chakra-ui/panda — `packages/generator/src/artifacts/js/sva.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/sva.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Fichier complet.

### PD-07

[chakra-ui/panda — `packages/core/src/recipes.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/recipes.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Lignes 1–300.

### PD-08

[chakra-ui/panda — `packages/preset-base/src/patterns.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Lignes 1–270 ; principaux patterns de layout.

### PD-09

[chakra-ui/panda — `packages/types/src/pattern.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/types/src/pattern.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Fichier complet.

### PD-10

[chakra-ui/panda — `packages/preset-base/src/conditions.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/conditions.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lecture : Fichier complet.

### PD-11

[chakra-ui/panda — `packages/core/__tests__/atomic-recipe.test.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/__tests__/atomic-recipe.test.ts)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : test. Lecture : Fichier complet ; test lu, non exécuté.

### PD-12

[chakra-ui/panda — `LICENSE.md`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/LICENSE.md)

Révision : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : license. Lecture : Fichier complet.

### PV2-01

[chakra-ui/panda — `V2_MIGRATION.md`](https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/V2_MIGRATION.md)

Révision : `c171f630adc6dec4a1f9e4b9a79ef706d8278aae`. Nature : documentation. Lecture : Lignes 1–200 ; document upstream, pas une mesure indépendante.

### PV2-02

[chakra-ui/panda — `packages/mcp/src/server.ts`](https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/packages/mcp/src/server.ts)

Révision : `c171f630adc6dec4a1f9e4b9a79ef706d8278aae`. Nature : code. Lecture : Fichier complet.

### PV2-03

[chakra-ui/panda — `crates/pandacss_codegen/tests/types_artifact.rs`](https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/crates/pandacss_codegen/tests/types_artifact.rs)

Révision : `c171f630adc6dec4a1f9e4b9a79ef706d8278aae`. Nature : test. Lecture : Lignes 1–240 et portion reçue des lignes 260–590. Initialisation stricte et types générés ; pas une preuve de rejet CSS strict. Tests non exécutés.

## Limites

Aucun test n’a été exécuté. Aucun prototype n’a été compilé. Les tailles, temps de compilation, performances éditeur et garanties navigateur ne sont pas mesurés. L’existence d’un test ne prouve ni son succès au commit audité, ni le succès d’un futur portage. L’absence d’un mécanisme dans un chemin inspecté n’est pas extrapolée à tous les chemins non lus.

`source-map.json` fournit les mêmes ancrages sous forme structurée. Les choix signalés **PROPOSITION** dans les documents sont des déductions d’architecture, pas des fonctionnalités déjà présentes dans PandamStyle.
