# Plan P0

**Statut : plan proposé, aucune étape exécutée.** Il s’agit de démontrer l’architecture de PandamStyle, pas de déclarer la bibliothèque finale terminée.

## Séquence fondée sur les dépendances

### 0. Fixer la base et les tests de comparaison

Créer le fork réel depuis un commit StyleX validé, relever les chemins et licences de chaque portage Panda, puis exécuter les tests upstream sélectionnés avant toute modification. Le snapshot v1 TypeScript est un donneur pragmatique pour les modules inspectés ; la v2 peut fournir des améliorations ciblées, mais son moteur Rust n’est pas requis pour cette architecture. [PV2-01]

### 1. Construire le registre canonique

Porter les structures de tokens, catégories et références, avec normalisation des identités. Ajouter validation des références inconnues, cycles, catégories et valeurs conditionnelles. Conserver sémantique, provenance, métadonnées et distinction entre auteur et consommateur. [PD-02] [PD-03] [PD-04]

Ce passage précède le rejet strict : le compilateur doit savoir ce qui est autorisé avant de l’imposer. Les diagnostics structurés et tests négatifs commencent ici, pas à la dernière étape.

### 2. Raccorder les tokens et politiques au fork

Transformer les références validées en variables/groupes de thèmes StyleX. Protéger les valeurs brutes pour les catégories P0 et un registre fini de conditions. Valider également les valeurs dynamiques lorsqu’elles concernent une propriété encadrée : une valeur impossible à prouver admissible ne devient pas acceptable parce qu’elle est convertie en variable CSS. [SX-02] [SX-09] [SX-10]

### 3. Produire types et contrat machine

Générer les unions TypeScript et le manifeste minimal depuis le même registre. Ajouter une empreinte de schéma/configuration. La génération de types prend exemple sur le code Panda, sans faire de TypeScript l’unique contrôle. [PD-01]

### 4. Compiler une recipe simple

Supporter base, variantes finies et valeurs par défaut. Porter la sélection de `cva`, remplacer ses sorties CSS brutes par des branches compilées. Définir l’ordre des axes de variantes ; ne pas laisser une différence d’ordre dans les props modifier silencieusement un résultat. [PD-05] [SX-03] [SX-06]

### 5. Fermer et vérifier le parcours de build

Adapter les imports reconnus, l’export public, les métadonnées et l’invalidation de cache. Compiler une application minimale utilisant uniquement les nouveaux imports ; vérifier CSS extrait, rendu serveur/client et diagnostics. Un changement de token ou de politique doit revalider les usages, même si leur fichier source n’a pas changé. [SX-05] [SX-11]

## Définition de fini du P0

Un design system de test déclare une échelle d’espacement, des couleurs primitives privées, des couleurs sémantiques publiques, deux thèmes, un petit ensemble de conditions et une recipe de bouton. Le consommateur compose des valeurs autorisées ; une valeur brute, un token supprimé, une catégorie incorrecte, une condition inconnue ou un import interdit fait échouer le build, y compris lorsque le contrôle TypeScript est ignoré.

Le build produit un CSS extrait, les types et un manifeste cohérents. Le runtime ne contient pas de dictionnaire complet destiné à interpréter des objets CSS arbitraires. La sélection parmi des branches compilées est autorisée. Le mode strict doit avoir une couverture vérifiée ; aucune réussite obtenue en désactivant le contrôle ou en excluant le fichier fautif.

## Hors de ce premier jalon

Slot recipes, compound variants et catalogue de patterns restent P1 selon le bundle. Leurs formes doivent néanmoins être prévues dans le modèle pour éviter une réécriture. Ne pas ajouter maintenant un framework de composants, une dépendance Ark UI dans le cœur, tous les bundlers, des codemods universels ou une compatibilité exhaustive avec toutes les APIs Panda/StyleX.

**Un P0 réussi prouve le raccordement et les garde-fous de base. Il ne prouve pas encore l’expérience complète de composition de pages voulue à terme.**


---

### Sources citées

[PD-01]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/types/style-props.ts
[PD-02]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts
[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-04]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/token.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PV2-01]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/V2_MIGRATION.md
[SX-02]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js
[SX-03]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js
[SX-05]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/utils/state-manager.js
[SX-06]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js
[SX-09]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js
[SX-10]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js
[SX-11]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js

Périmètre de lecture et révisions : [SOURCES](../SOURCES.md).
