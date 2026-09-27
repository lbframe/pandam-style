# Compatibilité et maintenance du fork

## Ce qui reste proche de StyleX

Préserver autant que possible les objets compilés, l’aplatissement, l’émission atomique, les groupes de variables et les mécanismes de composition. Cette continuité donne des fixtures de comparaison et réduit la surface où une correction upstream doit être adaptée. Elle ne transforme pas PandamStyle en wrapper. [SX-03] [SX-06] [SX-09] [SX-10]

## Divergence permanente attendue

Les déclarations et visiteurs propres à PandamStyle, la résolution des tokens, la provenance, les politiques, les diagnostics, les types dérivés et les interfaces d’introspection n’existent pas comme ensemble équivalent dans les chemins StyleX lus. Ils constituent un développement réel dans le fork. [SX-01] [SX-02] [SX-04] [SX-05]

Les frontières du build évolueront aussi : imports reconnus, métadonnées, empreintes de registre et caches. L’unplugin actuel filtre les fichiers sur leurs imports avant transformation ; les nouvelles APIs ne doivent pas disparaître de ce filtre. [SX-11]

Il serait prématuré de chiffrer cette divergence en pourcentage de code ou nombre garanti de conflits Git. Les emplacements sont identifiés ; le coût se mesure au fil des portages et intégrations upstream.

## Stratégie de portage Panda

Utiliser des commits donneurs explicites par module. Pour les éléments étudiés en profondeur, la v1 TypeScript offre des implémentations accessibles à porter vers le pipeline JS/Babel du fork. La v2 apporte un driver/introspection et une refonte Rust ; importer ce compilateur n’est pas une conséquence nécessaire du choix de reprendre ses fonctionnalités de design system. [PD-03] [PD-05] [PV2-01] [PV2-02]

Ne pas revendiquer une compatibilité universelle avec le code source Panda, sa sortie CSS ou toutes ses options. La parité fonctionnelle retenue doit être spécifiée par fonctionnalité. Les méthodes permissives et échappatoires du donneur peuvent être volontairement restreintes dans PandamStyle.

## Licences et provenance

Les deux fichiers de licence lus sont MIT : copyright Meta Platforms pour StyleX et Segun Adebayo pour Panda. La reprise/modification est autorisée sous leurs conditions de conservation des mentions. [SX-12] [PD-12]

Conserver les en-têtes applicables et tenir un registre des fichiers portés : dépôt, commit, chemin, adaptation et tests associés. Ne pas conclure que tout l’arbre de dépendances est couvert par ces deux seules licences : les licences transitives et obligations de distribution doivent être vérifiées sur le package réellement produit. Le nom de projet ne constitue pas ici une vérification de disponibilité npm ou de marque.

## Discipline de maintenance proposée

Commits séparés pour renommage, portage de chaque module, validation et changement de sémantique. Garder une suite upstream de référence et une suite PandamStyle de conformité. Lors d’une mise à jour upstream, revoir les nouvelles entrées de compilation et les changements de priorité, pas seulement résoudre les conflits textuels. Les surfaces nouvelles ne doivent pas devenir des chemins oubliés par la politique.


---

### Sources citées

[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PD-12]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/LICENSE.md
[PV2-01]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/V2_MIGRATION.md
[PV2-02]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/packages/mcp/src/server.ts
[SX-01]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/index.js
[SX-02]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js
[SX-03]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js
[SX-04]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/preprocess-rules/basic-validation.js
[SX-05]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/utils/state-manager.js
[SX-06]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js
[SX-09]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js
[SX-10]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create-theme.js
[SX-11]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js
[SX-12]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/LICENSE

Périmètre de lecture et révisions : [SOURCES](../SOURCES.md).
