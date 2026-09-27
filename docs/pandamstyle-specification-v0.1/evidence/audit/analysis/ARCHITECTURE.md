# Architecture

## 1. Ce que fait réellement StyleX

Le plugin Babel initialise un `StateManager`, reconnaît imports et appels, puis transforme notamment `create`, `defineVars`, `createTheme`, les constantes, les animations et les variantes imbriquées expérimentales. Il possède aussi un chemin `atoms`, exécuté avant les transformations de composition. Il ne s’agit donc pas d’un unique appel public à protéger. [SX-01] [SX-05]

Pour `create`, le visiteur valide l’appel puis évalue son argument. Une expression non statiquement résolue produit un diagnostic Babel ; les portions dynamiques reconnues sont conservées séparément. Le résultat statique passe au moteur partagé. [SX-02]

Ce moteur valide chaque namespace, aplatit les styles, conserve les dernières définitions des clés en conflit, puis produit des objets compilés marqués `$$css`, une collection de règles CSS et des correspondances vers les chemins d’origine. C’est cette représentation, et non une simple chaîne de classes, qui doit rester la cible interne de PandamStyle. [SX-03]

`props` utilise ensuite `styleq` pour composer les résultats ; il peut retourner une classe et des styles inline. Les tests vérifient notamment les conflits entre clés compilées identiques et les tableaux imbriqués. Les fonctions de déclaration, elles, lèvent une erreur lorsqu’elles parviennent non compilées au runtime. **Extraction statique ne signifie donc pas absence totale de runtime.** [SX-06] [SX-07]

L’émission finale résout aussi certaines constantes, trie les règles, déduplique et gère priorités, spécificité, direction et couches CSS optionnelles. L’unplugin recueille les métadonnées par module et applique Lightning CSS à la sortie. Ses filtres d’import et caches font partie du circuit de compilation. [SX-01] [SX-11]

## 2. Ce que fournit Panda, selon la révision

Dans le snapshot v1, le dictionnaire structure tokens primitifs et sémantiques, catégories, conditions, références, thèmes et dépréciations. Les utilities relient propriétés, raccourcis, catégories de tokens et transformations. [PD-02] [PD-03] [PD-04]

Les recipes atomiques `cva` génèrent une fonction qui fusionne base, variantes puis combinaisons, avant d’appeler le système CSS Panda. `sva` répartit la configuration entre slots. Les recipes de configuration ont aussi un chemin de génération et une organisation de classes distincts. Leur logique métier est portable ; leur émission ne doit pas être copiée telle quelle. [PD-05] [PD-06] [PD-07]

Les patterns transforment des paramètres en objets de style ; les conditions nommées représentent parfois des sélecteurs complexes, pas seulement des media queries. [PD-08] [PD-09] [PD-10]

La branche v2 annonce et expose une autre architecture : compilateur Rust/Oxc, bindings natifs et WASM. Le serveur MCP lu utilise le driver et son introspection. Ce dossier sépare cette architecture de la base TypeScript v1 ; il ne mélange pas les deux chemins de fichiers. [PV2-01] [PV2-02]

## 3. Architecture proposée pour le vrai fork

**PROPOSITION — Tous les modules suivants appartiennent à PandamStyle.** La modularité interne ne recrée pas une surcouche LB Frame.

```text
Déclarations de design system + code consommateur
                         │
             registre canonique versionné
                         │
       visiteurs PandamStyle / résolution statique
                         │
        normalisation tokens, conditions, recipes
                         │
       validation des politiques + provenance
                         │
       moteur atomique issu du fork de StyleX
                  ┌──────┴──────┐
             CSS extrait   objets compilés
                                 │
                   sélection/composition bornée
```

Le registre fournit également les types, le manifeste et les diagnostics. Une identité commune évite qu’un agent reçoive un catalogue différent de celui réellement accepté par le build.

Les contrôles interviennent avant la perte de la sémantique du token, puis après les transformations qui introduisent des propriétés concrètes. Les expansions de patterns doivent conserver la distinction entre paramètres consommateurs et valeurs structurelles définies par l’auteur. Un hook unique après conversion en simples chaînes `var(...)` ne suffit pas à distinguer un token autorisé d’une variable brute forgée.

Les recipes sont reconnues par le compilateur et abaissées en styles compilés. Une sélection de variante dépendante des props peut rester au runtime ; la fusion de CSS brut de `cva.resolve` n’est pas la cible. Les combinaisons ne doivent pas déclencher par défaut une expansion cartésienne de toutes les variantes.

## 4. Variables, thèmes et conditions

StyleX possède déjà l’identité des variables et des groupes de thèmes, puis des classes de surcharge réutilisant ces variables. Le portage du modèle sémantique Panda peut s’y raccorder. L’identifiant de fichier/export participant au hash doit être canonique pour éviter des divergences entre compilation d’une bibliothèque et compilation de l’application. [SX-09] [SX-10]

La traduction des conditions doit conserver le sens. Par exemple, un état Panda peut couvrir un attribut `data-*` en plus d’une pseudo-classe ; le remplacer par la seule pseudo-classe serait une régression. Les correspondances sont à définir et tester par famille, pas à supposer universelles. [PD-10] [SX-04]

## 5. Frontière de garantie

Le compilateur peut rejeter les violations dans les sources et APIs qu’il traite. Il ne sécurise pas magiquement toute injection CSS externe, manipulation du DOM ou modification de configuration. Une garantie de projet nécessite aussi la couverture des fichiers et imports, des attributs inline et des points d’extension. Cette frontière doit être explicite dans les specs, sans confondre garde-fou de conception et sandbox de sécurité.


---

### Sources citées

[PD-02]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts
[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-04]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/token.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PD-06]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/sva.ts
[PD-07]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/recipes.ts
[PD-08]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts
[PD-09]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/types/src/pattern.ts
[PD-10]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/conditions.ts
[PV2-01]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/V2_MIGRATION.md
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
