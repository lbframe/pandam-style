# Décision technique proposée pour PandamStyle

## 1. Décisions utilisateur acquises

PandamStyle est une **véritable bibliothèque autonome**, construite à partir d’un **fork de StyleX**, intégrant du **code sélectionné de Panda CSS**. Ce n’est ni une couche LB Frame, ni une façade devant deux moteurs, ni une simple collection d’idées reprises. Le design system consommateur définit son vocabulaire ; PandamStyle fournit et fait respecter les mécanismes.

Le principe reste : **« The page-generation LLM performs composition, not micro-design. »**

## 2. Architecture retenue pour la proposition de specs

Conserver le moteur atomique et les objets composables issus de StyleX. Porter le modèle et les algorithmes utiles de Panda dans les modules internes de PandamStyle, puis les raccorder à ce moteur. Les sources montrent les deux ensembles nécessaires : moteur/variables/thèmes d’un côté ; dictionnaire/recipes/slots/patterns de l’autre. [SX-03] [SX-06] [SX-09] [SX-10] [PD-03] [PD-05] [PD-06] [PD-08]

Créer un registre canonique dont dérivent validation, types, diagnostics et manifeste. Ajouter une politique de compilation qui garde la provenance des valeurs et couvre tous les chemins autorisés. Les limitations des types Panda et la diversité des entrées StyleX rendent ce travail explicite, et non une option obtenue en activant un flag existant. [PD-01] [PD-02] [SX-01]

**Le fork est acquis et les besoins d’intervention dans son compilateur sont maintenant localisés.** L’audit ne prétend pas qu’aucune autre architecture serait théoriquement possible ; ce n’est pas la question du projet.

## 3. P0 exact proposé

Registre de tokens primitifs et sémantiques ; validation des références et catégories ; réutilisation des variables/thèmes ; politiques de base par catégorie ; conditions nommées avec sous-ensemble de traduction explicite ; types dérivés ; recipe simple (base/variantes/défauts) ; diagnostics structurés ; frontière d’imports et de couverture du build ; manifeste minimal cohérent ; une intégration et application de conformité serveur/client.

La séparation auteur/consommateur existe dans le modèle. Les permissions précises exposées aux pages restent une politique à formaliser dans les specs, sans retarder le travail sur ces fondations.

## 4. Ce qu’on ne construit pas encore

Pas de moteur Panda parallèle ni de son compilateur Rust importé pour conserver une API de design system. Pas de catalogue visuel LB Frame obligatoire. Pas d’API publique recopiée intégralement avec toutes ses échappatoires. Pas de promesse « tous les sélecteurs, tous les bundlers, zéro runtime, zéro overhead ».

Slots, compound variants et patterns deviennent P1 selon le bundle ; leur schéma doit être anticipé. MCP complet, migrations/codemods et gestion avancée de versions restent des extensions. Le manifeste minimal est avancé en P0 car les critères d’acceptation du bundle l’exigent déjà.

## 5. Divergence permanente attendue

Visiteurs et imports propres à PandamStyle ; registre et résolution sémantique ; politiques ; diagnostics ; génération des types/manifeste ; raccordement et invalidation des intégrations. Le cœur de compilation et de composition doit rester aussi comparable que possible à StyleX, pour préserver ses tests et faciliter les reprises upstream. [SX-01] [SX-05] [SX-11]

## 6. Niveau de confiance

**Établi par lecture :** les composants donneurs existent, leurs chemins ont été identifiés, et plusieurs incompatibilités concrètes sont documentées.

**Proposé, non implémenté :** l’architecture unifiée, le P0 et les changements de fichiers.

**À démontrer par exécution :** correspondance CSS/conditions, compilation inter-fichiers, comportement des dynamiques, cohérence SSR/cache, performances TypeScript/build et poids des sorties. Aucune suite n’a été exécutée et aucun PASS de portage n’est annoncé.

La prochaine rédaction des specs peut donc partir de ces faits, au lieu de demander à l’utilisateur de résoudre des questions que le code tranche déjà.


---

### Sources citées

[PD-01]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/types/style-props.ts
[PD-02]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts
[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PD-06]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/sva.ts
[PD-08]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts
[SX-01]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/index.js
[SX-03]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js
[SX-05]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/utils/state-manager.js
[SX-06]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js
[SX-09]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js
[SX-10]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js
[SX-11]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js

Périmètre de lecture et révisions : [SOURCES](../SOURCES.md).
