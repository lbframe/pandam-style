# Matrice de portage

**KEEP** : conserver le mécanisme du fork. **EXTEND** : modifier ce mécanisme. **PORT CODE** : reprendre et adapter réellement du code Panda. **BUILD** : nouvelle capacité PandamStyle. **FORBID** : chemin non exposé dans un profil strict. Ces catégories peuvent se cumuler.

Le « PORT CONCEPT » historique du brief est remplacé ici par **PORT CODE**, conformément à la décision explicite de construire une vraie bibliothèque avec des pièces de Panda intégrées.

| Capacité | État constaté | Traitement PandamStyle | Priorité proposée |
|---|---|---|---|
| Compilation atomique | StyleX fournit représentation, aplatissement et émission. [SX-03] | KEEP, avec validation avant émission. | P0 |
| Composition | Runtime d’objets compilés ; conflits testés. [SX-06] [SX-07] | KEEP ; spécifier les clés/conditions, pas concaténer des classes Panda. | P0 |
| Tokens structurés | Dictionnaire et catégories Panda. [PD-03] | PORT CODE + adaptation de l’identité au moteur StyleX. | P0 |
| Tokens sémantiques | Modèle conditionnel Panda ; variables/thèmes StyleX. [PD-03] [SX-09] [SX-10] | PORT CODE + EXTEND du raccordement. | P0 |
| Rejet strict des valeurs | Types Panda restrictifs mais transformation permissive dans le chemin lu. [PD-01] [PD-02] | BUILD des validations de compilation. | P0 |
| Politique par catégorie | Mapping des propriétés disponible ; politique complète non acquise. [PD-02] | PORT CODE pour le mapping, BUILD pour l’autorité. | Noyau P0, extension P1 |
| Types dérivés du thème | Générateurs Panda existants. [PD-01] [PV2-03] | PORT CODE, sans importer tout le compilateur Rust. | P0 |
| Conditions | Riches sélecteurs Panda ; grammaire et priorités StyleX différentes. [PD-10] [SX-04] [SX-01] | PORT CODE + normalisation et matrice de parité. | Sous-ensemble P0 |
| Recipes simples | `cva` + chemin de recipes de configuration. [PD-05] [PD-07] | PORT CODE de sélection ; remplacer fusion/émission CSS par objets compilés. | P0 |
| Compound variants | Algorithme de sélection déjà présent. [PD-05] | PORT CODE ; cas conditionnels à valider séparément. | P1 |
| Slot recipes | Décomposition en recipes par slot. [PD-06] | PORT CODE ; retour interne par slot en styles compilés. | P1 |
| Patterns | Schémas, transformateurs et options strict/blocklist présents. [PD-08] [PD-09] | PORT CODE + contrôle des paramètres et de l’expansion. | P1 |
| Diagnostics structurés | Erreurs source Babel existantes ; pas le contrat agent demandé. [SX-02] | EXTEND + BUILD des codes, alternatives et format machine. | Dès P0 |
| Manifeste / introspection | Métadonnées de recipes et MCP v2 existants. [PD-07] [PV2-02] | PORT CODE adapté ; registre commun, visibilité filtrée. | Minimum P0, outillage P2 |
| Dépréciation / migration | Dépréciation déjà enregistrée. [PD-03] [PD-04] | PORT CODE ; BUILD règles replacement/version et codemods. | Métadonnées initiales, workflow P2 |
| Imports et chemins alternatifs | Détection d’imports, `atoms`, attributs et injection à traiter. [SX-01] [SX-05] [SX-11] | EXTEND ; FORBID des chemins non autorisés selon profil. | P0 |
| Interpréteur CSS Panda parallèle | `cva` produit encore du CSS brut avant les classes. [PD-05] | Ne pas intégrer ce runtime inchangé ; aucune seconde API publique de styling. | Hors architecture |
| Design visuel de LB Frame | Exigence propre au projet consommateur. | Aucun thème LB Frame obligatoire dans PandamStyle. | Hors cœur |

## Frontière P0/P1/P2

Le bundle place le moteur de politiques par catégorie en P1 alors que P0 demande déjà un rejet strict par catégories. Il place aussi le manifeste en P2 tout en l’exigeant dans les tests d’acceptation. **Proposition de résolution : un noyau de politiques et un export minimal du registre en P0 ; une politique plus expressive, le MCP complet et les migrations restent des extensions.** Cela ne signifie pas embarquer tous les patterns et toutes les recipes avancées dès le premier jalon.


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
[PV2-03]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/crates/pandacss_codegen/tests/types_artifact.rs
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
