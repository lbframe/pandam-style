# Plan de modifications au niveau fichiers

Aucun fichier listé n’a été modifié. Les chemins upstream sont vérifiés dans les sources ; les chemins PandamStyle ci-dessous sont **des emplacements proposés**, pas des fichiers existants.

## Fichiers du fork StyleX à conserver ou étendre

Préfixe des chemins abrégés : `packages/@stylexjs/` dans la base auditée.

| Chemin existant | Changement attendu | Preuve |
|---|---|---|
| `babel-plugin/src/index.js` | Enregistrer les nouvelles déclarations/appels ; garantir la couverture des visiteurs et l’ordre de normalisation ; conserver l’émetteur. | [SX-01] |
| `babel-plugin/src/visitors/stylex-create.js` | Relier le registre, préserver la provenance et valider les valeurs/dynamiques avant abaissement. | [SX-02] |
| `babel-plugin/src/shared/stylex-create.js` | Garder représentation et compilation ; raccordement minimal au contrat d’entrée validé. | [SX-03] |
| `babel-plugin/src/shared/preprocess-rules/basic-validation.js` | Ne pas confondre validation de forme et politique ; conserver/adapter la normalisation des conditions. | [SX-04] |
| `babel-plugin/src/utils/state-manager.js` | Résoudre registre/politique par compilation ; adapter imports, chemins d’injection et métadonnées. | [SX-05] |
| `babel-plugin/src/shared/stylex-define-vars.js` | Réutiliser émission des variables avec identité canonique du registre. | [SX-09] |
| `babel-plugin/src/shared/stylex-create-theme.js` | Réutiliser groupes et surcharges ; tests de correspondance des tokens. | [SX-10] |
| `stylex/src/stylex.js` | Exports PandamStyle et composition de branches compilées ; ne pas ajouter de résolveur CSS brut runtime. | [SX-06] |
| `unplugin/src/core.js` | Reconnaître imports générés ; adapter métadonnées et caches ; invalider sur configuration/registre. | [SX-11] |
| `stylex/__tests__/stylex-test.js` | Préserver fixtures de composition et en ajouter pour les recipes compilées. | [SX-07] |

Le renommage du namespace npm, des fichiers de thème et des marques internes doit être une opération cohérente avec les résolveurs. Une façade de package renommée laissant tous les anciens chemins de compilation ouverts ne suffit pas.

## Code Panda à porter et adapter

| Source v1 ou v2 | Destination proposée | Travail réel |
|---|---|---|
| `token-dictionary/src/dictionary.ts` et `token.ts` (v1) | `packages/design-system/src/registry/` | Porter catégories, références, conditions et métadonnées ; remplacer émission/identité ; validation stricte du graphe. [PD-03] [PD-04] |
| `core/src/utility.ts` (v1) | `packages/design-system/src/properties/` | Porter mapping et raccourcis ; retirer le fallback permissif sur le chemin strict. [PD-02] |
| `generator/src/artifacts/types/style-props.ts` (v1) | `packages/codegen/src/types/` | Adapter génération depuis le registre ; types utiles sans dépendre d’un contournement générique. [PD-01] |
| `generator/src/artifacts/js/cva.ts` (v1) | `packages/recipes/src/` et visiteurs du compilateur | Porter sélection/defaults/combinaisons ; remplacer `.raw`/fusion CSS par une représentation compilée. [PD-05] |
| `generator/src/artifacts/js/sva.ts` (v1) | `packages/recipes/src/slots/` | Porter décomposition et typage des slots ; éliminer l’hypothèse « résultat = classes Panda ». [PD-06] |
| `core/src/recipes.ts` (v1) | `packages/design-system/src/recipes/` | Porter normalisation et métadonnées utiles ; isoler caches par contexte ; ne pas reprendre sa cascade séparée. [PD-07] |
| `preset-base/src/patterns.ts`, `types/src/pattern.ts` (v1) | `packages/patterns/src/` | Porter schémas/transformateurs sélectionnés ; contrôler extensions et valeurs par défaut. [PD-08] [PD-09] |
| `preset-base/src/conditions.ts` (v1) | `packages/design-system/src/conditions/` | Porter définitions retenues puis traduire sans perte de sémantique. [PD-10] |
| `mcp/src/server.ts` (v2) | `packages/mcp/src/` | Porter exposition/introspection en remplaçant le driver par celui de PandamStyle. [PV2-02] |

Les chemins abrégés Panda commencent tous par `packages/`. Les helpers importés par ces modules doivent encore être inventoriés transitivement au moment du portage ; ce dossier ne prétend pas que copier ces seuls fichiers suffit à compiler.

## Nouvelles pièces propres à PandamStyle

`packages/compiler/src/policy/` : autorité des règles, validation avec provenance et contrôle des expansions.

`packages/compiler/src/visitors/` : déclarations de recipes/patterns/tokens reconnues nativement et consommation inter-fichiers.

`packages/diagnostics/src/` : codes, schéma, localisations, alternatives et séparation suggestion/correction.

`packages/codegen/src/manifest/` : export du registre et empreinte de schéma.

`packages/compiler/__tests__/policy/` et `tests/conformance/` : violations, transformations, CSS, types, cache et SSR.

L’emplacement exact de ces modules doit respecter l’organisation retenue du fork. Le principe obligatoire est leur intégration native dans PandamStyle, pas ces noms de dossiers particuliers.


---

### Sources citées

[PD-01]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/types/style-props.ts
[PD-02]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts
[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-04]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/token.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PD-06]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/sva.ts
[PD-07]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/recipes.ts
[PD-08]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts
[PD-09]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/types/src/pattern.ts
[PD-10]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/conditions.ts
[PV2-02]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/packages/mcp/src/server.ts
[SX-01]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/index.js
[SX-02]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js
[SX-03]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js
[SX-04]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js
[SX-05]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/utils/state-manager.js
[SX-06]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js
[SX-07]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/__tests__/stylex-test.js
[SX-09]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js
[SX-10]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js
[SX-11]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js

Périmètre de lecture et révisions : [SOURCES](../SOURCES.md).
