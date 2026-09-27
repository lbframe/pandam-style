# PandamStyle — Audit des dépôts

**27 septembre 2026 · Analyse statique sourcée · Aucune implémentation**

## Conclusion

Le fork de StyleX et le portage de code Panda constituent le point de départ acquis. L’analyse identifie maintenant les pièces réutilisables et les changements nécessaires ; elle ne réouvre pas la décision du fork.

Le point majeur : **les fonctionnalités Panda ne constituent pas, à elles seules, la politique de design exigée par PandamStyle**. Dans le chemin v1 inspecté, `strictTokens` restreint les types tandis que le transformateur conserve des valeurs arbitraires ; les patterns de base autorisent des surcharges. Ce verrouillage doit être ajouté au compilateur. [PD-01] [PD-02] [PD-08]

StyleX fournit déjà compilation atomique, représentation composable, variables et thèmes. Panda fournit du code pour les tokens structurés, les recipes, les slots, les patterns et l’introspection. Le raccordement proposé se fait **dans une seule bibliothèque et vers un seul moteur CSS**, pas par juxtaposition de deux bibliothèques publiques. [SX-03] [SX-06] [SX-09] [SX-10] [PD-03] [PD-05] [PD-06] [PV2-02]

## Lecture

Commencer par [DECISION](analysis/DECISION.md), puis [FEATURE_MATRIX](analysis/FEATURE_MATRIX.md).

| Document | Contenu |
|---|---|
| [ARCHITECTURE](analysis/ARCHITECTURE.md) | Circuits actuels et circuit proposé |
| [GAP_ANALYSIS](analysis/GAP_ANALYSIS.md) | Écarts et réponses aux vingt questions initiales |
| [FEATURE_MATRIX](analysis/FEATURE_MATRIX.md) | Conserver, modifier, porter, créer, interdire |
| [P0_IMPLEMENTATION_PLAN](analysis/P0_IMPLEMENTATION_PLAN.md) | Premier périmètre démontrable et dépendances |
| [API_PROPOSAL](analysis/API_PROPOSAL.md) | Contrats techniques, sans figer prématurément la syntaxe |
| [FILE_CHANGE_PLAN](analysis/FILE_CHANGE_PLAN.md) | Fichiers donneurs et emplacements proposés |
| [TEST_PLAN](analysis/TEST_PLAN.md) | Tests de conformité, négatifs et performance |
| [UPSTREAM_COMPATIBILITY](analysis/UPSTREAM_COMPATIBILITY.md) | Divergence du fork et maintenance |
| [RISK_REGISTER](analysis/RISK_REGISTER.md) | Risques, preuves et moyens de les lever |
| [DECISION](analysis/DECISION.md) | Synthèse exploitable pour préparer les specs |

## Statut des preuves

Le code et plusieurs tests ont été **lus via le plugin GitHub**, pas exécutés. L’audit est profond sur les chemins sélectionnés, mais n’est pas une lecture exhaustive des deux monorepos. Les sources, révisions exactes et limites de lecture figurent dans [SOURCES](SOURCES.md) et `source-map.json`.

Les exemples et chemins nouveaux sont des propositions. Aucun dépôt upstream, fork ou fichier du bundle d’origine n’a été modifié par la production de ce dossier.


---

### Sources citées

[PD-01]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/types/style-props.ts
[PD-02]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts
[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PD-06]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/sva.ts
[PD-08]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts
[PV2-02]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/packages/mcp/src/server.ts
[SX-03]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js
[SX-06]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js
[SX-09]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js
[SX-10]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js

Périmètre de lecture et révisions : [SOURCES](SOURCES.md).
