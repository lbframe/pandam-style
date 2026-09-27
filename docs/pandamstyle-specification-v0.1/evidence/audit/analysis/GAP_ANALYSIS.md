# Écarts et questions initiales

## Corrections du cadrage

Le besoin fourni reste valide, mais certaines explications mélangeaient objectif et capacité existante.

**`strictTokens` :** le générateur v1 restreint les types et conserve `WithEscapeHatch`. Dans la transformation de utilities inspectée, une valeur inconnue peut être conservée et traitée ; le contrôle n’est donc pas le rejet inconditionnel demandé à PandamStyle. [PD-01] [PD-02]

**Patterns :** les patterns de base lus utilisent des valeurs telles que `8px` et propagent `...rest`. `strict` et `blocklist` existent déjà dans leur contrat, avec une description portant sur la génération de types. Porter un pattern n’en fait pas automatiquement une primitive inviolable. [PD-08] [PD-09]

**Introspection et dépréciation :** elles ne partent pas de zéro : le dictionnaire enregistre les dépréciations et le serveur MCP v2 expose le vocabulaire. Les règles de migration et la visibilité propre aux agents restent à ajouter. [PD-03] [PV2-02]

**Runtime :** StyleX compose déjà des objets compilés à l’exécution. L’interdit pertinent est le retour d’un interpréteur général de styles, pas toute sélection de variante. [SX-06]

## Réponses aux vingt questions du bundle

Les numéros suivent `09_OPEN_QUESTIONS.md`. Une réponse technique proposée n’est pas une décision produit imposée.

| Nº | Réponse issue de l’audit | Statut |
|---|---|---|
| 1 | Validation avec provenance autour de l’évaluation/normalisation, et contrôle commun avant le moteur ; couvrir les autres visiteurs et `atoms`. | Points d’insertion identifiés. [SX-01] [SX-02] [SX-03] |
| 2 | Panda fournit un modèle de génération de types par catégories. Son coût sur un grand design system PandamStyle n’est pas mesuré. | Mécanisme disponible, performance à tester. [PD-01] [PV2-03] |
| 3 | Références `var(--…)`, groupe de variables et métadonnées d’injection existent. Réutilisables pour la sémantique des tokens. | Répondu sur la représentation. [SX-09] |
| 4 | Réutiliser les primitives StyleX, avec normalisation des noms et sélection d’un sous-ensemble compatible. | Pas de moteur parallèle ; parité de tous les sélecteurs non prouvée. [SX-04] [PD-10] |
| 5 | Déclarations de branches compilées + sélection de variantes + composition d’objets compilés. | Proposition appuyée sur les deux runtimes. [PD-05] [SX-06] |
| 6–7 | Recipes et slot recipes font partie de PandamStyle. Leur répartition en packages internes reste une organisation du fork. | Décision utilisateur déjà acquise ; aucun choix de wrapper à rouvrir. |
| 8–9 | Les garanties exigent des changements dans les chemins de validation, reconnaissance des appels, génération et intégration ; une validation TS seule ne suffit pas. | Surface concrète identifiée ; fork acquis. [SX-01] [SX-05] [PD-01] |
| 10 | Les visiteurs, états/configuration, diagnostics, import gates et modules de registre constituent la divergence attendue. | À limiter par interfaces, pas à nier. [SX-05] [SX-11] |
| 11 | Exports PandamStyle, résolution des symboles et règles de build des consommateurs. Les exports seuls ne peuvent interdire un paquet installé séparément. | Architecture proposée ; naming exact non réservé. |
| 12 | Échappatoire explicite, limitée à une propriété/usage, justification et trace au build ; jamais `any` comme autorisation. | Contrat produit proposé à spécifier. |
| 13 | Cœur de diagnostic partagé avec les types/manifeste ; calcul de suggestions séparé de la décision de rejet. | Proposition ; proximité numérique ≠ correction sûre. |
| 14 | Les métadonnées existent ; un manifeste peut dériver du registre. Le coût marginal reste à mesurer. | Faisabilité étayée, gratuité non démontrée. [PD-07] [PV2-02] |
| 15 | Aucun temps ni budget mémoire mesuré dans cet audit. | À résoudre par benchmark, pas par question produit. |
| 16 | Un graphe de références permet une validation statique. La récursion locale de `Token.expandReferences` lue ne comporte pas de garde explicite de cycle. | Ajouter un contrat de détection ; pas de conclusion globale sur les chemins non lus. [PD-04] |
| 17 | Conserver l’identité des variables et les classes de thème ; distinguer thème sélectionné et préférence système. | Mécanismes disponibles ; parité conditionnelle à tester. [SX-10] [PD-10] |
| 18 | Même vocabulaire sémantique, ensembles de valeurs par marque/thème, sans exposer les couleurs brutes au consommateur. | Modèle proposé à partir des mécanismes existants. [PD-03] [SX-09] |
| 19 | Compilateur : autorité ; TS : feedback ; règles d’architecture/build : couverture ; lint : aide, jamais unique verrou. | Conclusion du niveau de garantie demandé. |
| 20 | Registre + tokens stricts + thème + conditions bornées + recipe simple + types/diagnostics/manifeste + un parcours de build. | P0 détaillé dans le plan, pas la bibliothèque finale complète. |

## Ce que le code ne décide pas à notre place

Les dépôts permettent de déterminer **comment** restreindre une API, pas quelles permissions le créateur de chaque design system souhaite accorder aux pages. Ce choix reste visible dans le futur contrat, mais n’empêche plus d’établir les fondations techniques. Les questions de performance et de compatibilité doivent être traitées par expériences ciblées, pas renvoyées à l’utilisateur sans données.


---

### Sources citées

[PD-01]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/types/style-props.ts
[PD-02]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts
[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-04]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/token.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PD-07]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/recipes.ts
[PD-08]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts
[PD-09]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/types/src/pattern.ts
[PD-10]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/conditions.ts
[PV2-02]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/packages/mcp/src/server.ts
[PV2-03]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/crates/pandacss_codegen/tests/types_artifact.rs
[SX-01]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/index.js
[SX-02]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js
[SX-03]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js
[SX-04]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js
[SX-05]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/utils/state-manager.js
[SX-06]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js
[SX-09]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js
[SX-10]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js
[SX-11]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js

Périmètre de lecture et révisions : [SOURCES](../SOURCES.md).
