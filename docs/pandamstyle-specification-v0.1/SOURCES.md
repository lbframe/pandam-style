# Sources et traçabilité de la spécification

**Rédaction : 28 septembre 2026.** L’audit précédent reste daté du 27 septembre 2026 ; sa date et ses fichiers sont conservés tels quels. Les constats upstream sont liés à des commits immuables, sans prétendre représenter la dernière version publiée.

## Hiérarchie des sources

Les décisions explicites de la conversation définissent l’identité du projet. Le bundle et le cheminement expriment les besoins. Le dossier d’audit documente les constats et leurs limites. Les documents `specs/` ajoutent des propositions identifiées `D-*` : ce sont des contrats à vérifier, pas des capacités attribuées aux sources.

## U-01

Corrections explicites dans cette conversation : « c’est pas une couche lbframe », « une vraie librairie, basé sur le fork de stylex, à laquelle on rajoute les pièces de Pandacss », puis le nom « PandamStyle ». Instruction ultérieure : analyser les deux dépôts en profondeur et utiliser le plugin GitHub. Ces décisions priment sur les formulations historiques « couche LB Frame » et « idées de Panda ».

Ces messages sont la source d’autorité ; cette entrée en conserve le sens pour rendre le dossier autonome. Elle n’est pas présentée comme une nouvelle décision ni un verbatim complet de la conversation.

## U-02

[Cheminement fourni](evidence/rationale.txt), fichier original `Texto colado(5).txt` : vocabulaire autorisé, tokens sémantiques, recipes, slots, patterns, diagnostics et principe « The page-generation LLM performs composition, not micro-design. » Les références historiques à LB Frame sont conservées dans l’original, sans les rétablir comme architecture de la bibliothèque.

## Documents fournis

[Bundle initial](evidence/original-brief/README.md) : onze fichiers conservés. [Contrat fondateur antérieur](evidence/founding-contract-v0.1.md) : version de cadrage, antérieure à l’audit. [Dossier d’audit](evidence/audit/README.md) : source des observations techniques, dix analyses, références et limites de lecture.

L’archive d’audit a été lue depuis ses octets joints car l’outil Files n’en fournissait pas de texte. Son contenu n’a pas été remplacé par un résumé d’un autre document.

## Références primaires

Les codes `SX-*`, `PD-*` et `PV2-*` réemploient l’index de l’audit. `SX-13` est une lecture complémentaire effectuée pendant cette rédaction via le plugin GitHub, au même commit StyleX. Elle établit une différence de représentation entre conditions orientées propriété et blocs conditionnels ; la normalisation D-05 qui en découle reste une proposition.

Les références ci-dessous ne constituent pas des tests exécutés.

## SX-01

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/index.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/index.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Entrée et traversées reçues dans le premier extrait ; émission CSS relue explicitement aux lignes 500–915.

## SX-02

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lignes 1–255.

## SX-03

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/stylex-create.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Fichier complet.

## SX-04

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Fichier complet.

## SX-05

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/utils/state-manager.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/utils/state-manager.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lignes 1–220.

## SX-06

[facebook/stylex — `packages/@stylexjs/stylex/src/stylex.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lignes 1–285.

## SX-07

[facebook/stylex — `packages/@stylexjs/stylex/__tests__/stylex-test.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/__tests__/stylex-test.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : test. Fichier complet ; tests lus, non exécutés.

## SX-08

[facebook/stylex — `packages/@stylexjs/atoms/README.md`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/atoms/README.md)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : documentation. Fichier complet ; invocation de la transformation recoupée dans SX-01.

## SX-09

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Fichier complet.

## SX-10

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Fichier complet.

## SX-11

[facebook/stylex — `packages/@stylexjs/unplugin/src/core.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Lignes 1–500 ; adaptateurs individuels non audités intégralement.

## SX-12

[facebook/stylex — `LICENSE`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/LICENSE)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : license. Fichier complet.

## PD-01

[chakra-ui/panda — `packages/generator/src/artifacts/types/style-props.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/types/style-props.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Fichier complet.

## PD-02

[chakra-ui/panda — `packages/core/src/utility.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lignes 1–530.

## PD-03

[chakra-ui/panda — `packages/token-dictionary/src/dictionary.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lignes 1–545 ; fin des vues dérivées non lue.

## PD-04

[chakra-ui/panda — `packages/token-dictionary/src/token.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/token.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lignes 1–240.

## PD-05

[chakra-ui/panda — `packages/generator/src/artifacts/js/cva.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Fichier complet.

## PD-06

[chakra-ui/panda — `packages/generator/src/artifacts/js/sva.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/sva.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Fichier complet.

## PD-07

[chakra-ui/panda — `packages/core/src/recipes.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/recipes.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lignes 1–300.

## PD-08

[chakra-ui/panda — `packages/preset-base/src/patterns.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Lignes 1–270 ; principaux patterns de layout.

## PD-09

[chakra-ui/panda — `packages/types/src/pattern.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/types/src/pattern.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Fichier complet.

## PD-10

[chakra-ui/panda — `packages/preset-base/src/conditions.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/conditions.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : code. Fichier complet.

## PD-11

[chakra-ui/panda — `packages/core/__tests__/atomic-recipe.test.ts`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/__tests__/atomic-recipe.test.ts)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : test. Fichier complet ; test lu, non exécuté.

## PD-12

[chakra-ui/panda — `LICENSE.md`](https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/LICENSE.md)

Commit : `1a310482ff18102c44b2a478b7644b064a80d7c6`. Nature : license. Fichier complet.

## PV2-01

[chakra-ui/panda — `V2_MIGRATION.md`](https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/V2_MIGRATION.md)

Commit : `c171f630adc6dec4a1f9e4b9a79ef706d8278aae`. Nature : documentation. Lignes 1–200 ; document upstream, pas une mesure indépendante.

## PV2-02

[chakra-ui/panda — `packages/mcp/src/server.ts`](https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/packages/mcp/src/server.ts)

Commit : `c171f630adc6dec4a1f9e4b9a79ef706d8278aae`. Nature : code. Fichier complet.

## PV2-03

[chakra-ui/panda — `crates/pandacss_codegen/tests/types_artifact.rs`](https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/crates/pandacss_codegen/tests/types_artifact.rs)

Commit : `c171f630adc6dec4a1f9e4b9a79ef706d8278aae`. Nature : test. Lignes 1–240 et portion reçue des lignes 260–590. Initialisation stricte et types générés ; pas une preuve de rejet CSS strict. Tests non exécutés.

## SX-13

[facebook/stylex — `packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/flatten-raw-style-obj.js`](https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/flatten-raw-style-obj.js)

Commit : `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`. Nature : code. Contenu complet retourné par GitHub.fetch_file, fenêtre demandée 1–260, pendant la rédaction du 2026-09-28 ; aucun test exécuté.

## WEB-01

[StyleX — documentation officielle](https://stylexjs.com/docs/learn)

Nature : official-documentation. Vérification complémentaire du 2026-09-28 : extraction statique et composition runtime. Ne remplace pas les commits de référence.

## Limites conservées

Aucune exécution des suites upstream ou de PandamStyle. Aucun prototype de portage ni benchmark. Les licences transitives et les helpers n’ont pas été inventoriés exhaustivement. Les détails non couverts par les sources sont explicitement des propositions, des restrictions de P0 ou des hypothèses à tester.

La vérification web complémentaire de la documentation officielle confirme uniquement la distinction générale entre extraction statique et composition runtime ; elle ne remplace ni les lectures du plugin GitHub ni les versions épinglées.
