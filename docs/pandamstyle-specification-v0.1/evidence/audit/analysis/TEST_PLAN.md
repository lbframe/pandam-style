# Plan de validation

## Ce qui est déjà établi — et ce qui ne l’est pas

Les tests StyleX de composition et le snapshot Panda de recipe atomique ont été lus. Ils fournissent des cas à préserver ou adapter, mais **aucune suite n’a été exécutée pendant l’audit**. Les tests de génération de types v2 ne sont pas une preuve de validation des politiques CSS. [SX-07] [PD-11] [PV2-03]

Commencer l’implémentation par une baseline upstream réellement exécutée. Ne pas attribuer au fork un comportement déjà défaillant au point de départ sans le distinguer.

## Matrice de conformité

| Groupe | Cas positifs | Cas négatifs / régressions |
|---|---|---|
| T01 Registre | Tokens primitifs/sémantiques ; alias multi-sauts ; catégories. | Alias inconnu, cycle direct/indirect, collision canonique, mauvaise catégorie. |
| T02 Politique | Token autorisé ; mot-clé structurel autorisé. | Valeur brute, propriété/raccourci équivalent, variable CSS libre sur catégorie encadrée. |
| T03 Indépendance de TS | Même style valide en JS et TS. | `as any`, `@ts-ignore` ou contrôle TS absent ne rendent pas le CSS interdit acceptable. |
| T04 Provenance | Référence autorisée provenant d’un module de design system. | Alias local, spread, référence importée ou donnée dynamique perdant la preuve d’autorisation. |
| T05 Entrées compiler | Tous les appels publics retenus compilent. | Chemins alternatifs `atoms`, déclarations d’animation, helpers et imports de bas niveau ne contournent pas la politique. |
| T06 Conditions | États simples, data/ARIA, condition nommée et thème autorisés. | Condition inconnue, media brute interdite, traduction supprimant une partie du sélecteur. |
| T07 Breakpoints | Ordre des min/max comparables et conditions imbriquées. | Mélange px/em/rem, ranges, not/or, contextes @supports distincts, égalités et chevauchements. |
| T08 Themes | Même token sémantique, deux thèmes ; application imbriquée. | Token inexistant, conflit de groupe, identité différente entre package et application. |
| T09 Recipes P0 | Base, défauts, axe explicite ; choix runtime fini. | Variante inconnue ; ordre de props influençant les conflits ; CSS brut réintroduit au runtime. |
| T10 Composition | Objets compilés, tableaux et branches conditionnelles. | Surcharges shorthands/longhands, différences `null`/absent/dynamique, clés conditionnelles. |
| T11 Slots / compounds P1 | Propagation multi-slots ; plusieurs combinaisons. | Slot inconnu ; combinaisons responsive ; conflit et explosion combinatoire. |
| T12 Patterns P1 | Paramètres autorisés ; expansion structurelle correcte. | `...rest` interdit, remplacement d’un invariant, valeur par défaut incompatible avec le design system. |
| T13 Diagnostics | Code stable, plage source, règle, alternatives connues. | Correction automatique ambiguë, token privé suggéré, token absent du thème effectif. |
| T14 Import/build | Fichier n’important que recipes/patterns générés. | Import brut, re-export/alias, fichier oublié par le filtre, attribution de confiance auto-déclarée. |
| T15 Incremental | Ajout/retrait d’un token ou d’une condition ; rebuild. | Types/manifeste périmés, règle CSS obsolète, politique resserrée sans revalidation. |
| T16 SSR/client | IDs et CSS cohérents, build propre reproductible. | Différences chemins/résolveurs, caches partagés entre configurations distinctes, styles manquants à l’hydratation. |
| T17 Distribution | Package publié localement dans une app minimale. | Références résiduelles à l’ancien namespace, runtimeInjection inattendue, dépendance Panda parallèle. |

Les chemins `atoms`, contrôles de forme, états conditionnels et filtres de build cités motivent directement ces groupes. [SX-01] [SX-04] [SX-08] [SX-11] [PD-10]

## Stratégie CSS

Conserver les fixtures StyleX inchangées pour les cas hors nouvelles fonctionnalités. Pour un portage Panda, comparer le **comportement attendu** des règles et conditions, pas ses noms de classes ou sa hiérarchie de couches. Le snapshot atomique Panda utilise `@layer utilities`, tandis que StyleX organise l’émission selon ses priorités et options. [PD-11] [SX-01]

Compléter les snapshots texte par des assertions navigateur sur un échantillon de conflits, états et thèmes. Un snapshot valide ne démontre pas à lui seul la cascade réellement observée.

## Stratégie types et performance

Tester un petit, moyen et grand vocabulaire ; des axes nombreux ; des slots et conditions. Mesurer génération, `tsc`, diagnostics éditeur, mémoire, build froid, rebuild après changement de token, poids JS/CSS et temps de sélection runtime. Fixer les seuils après la baseline, pas en inventant ici un pourcentage d’overhead.

Vérifier que les suggestions ne forcent pas une analyse coûteuse sur chaque usage valide. Les évaluations de patterns auteurs doivent être déterministes dans le périmètre accepté ; aucune garantie de déterminisme général d’une fonction JS arbitraire n’est supposée.

## Critère de sortie

Une violation compile-time doit réellement faire échouer le build dans tous les parcours couverts. Les tests ne doivent pas contourner la politique pour obtenir un succès. Rapport final : commit, configuration, suites exécutées, résultats, cas exclus et mesures. L’absence d’erreurs de types seule ne constitue pas un PASS de PandamStyle.


---

### Sources citées

[PD-10]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/conditions.ts
[PD-11]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/__tests__/atomic-recipe.test.ts
[PV2-03]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/crates/pandacss_codegen/tests/types_artifact.rs
[SX-01]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/index.js
[SX-04]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js
[SX-07]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/__tests__/stylex-test.js
[SX-08]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/atoms/README.md
[SX-11]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js

Périmètre de lecture et révisions : [SOURCES](../SOURCES.md).
