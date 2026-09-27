# Registre des risques

La criticité ci-dessous concerne l’objectif de PandamStyle, pas une notation globale des projets upstream. Les risques non reproduits sont signalés comme tels.

| Risque | Constat ou hypothèse | Mesure proposée |
|---|---|---|
| Faux sentiment de contrainte | `strictTokens` v1 agit sur les types ; transformation permissive observée. [PD-01] [PD-02] | Validation indépendante de TS ; tests JS, casts et variables brutes. |
| Chemin de compilation oublié | `atoms`, animations, thèmes et autres visiteurs existent. [SX-01] [SX-08] | Inventaire versionné des entrées ; test négatif sur chacune. |
| Perte de provenance | L’évaluation produit des objets/valeurs puis le moteur compile. [SX-02] [SX-03] | Conserver identité de token/source avant conversion ; revalider les expansions. |
| Deux règles de priorité concurrentes | Panda recipes/config et StyleX ont des circuits différents. [PD-05] [PD-07] [SX-01] | Une représentation compilée et une émission ; spécifier les conflits des variantes. |
| Régression de sélecteur | Conditions Panda incluant data, ARIA, group/peer et classes de thème. [PD-10] | Matrice de traduction, snapshots et tests navigateur ; aucune approximation silencieuse. |
| Ordre responsive erroné | Le tri numérique StyleX lu ne traite pas toutes les unités/formes. [SX-01] | Tester em/rem, intersections et contextes ; garder la sémantique canonique des conditions. |
| Styles arbitraires via patterns | Valeurs brutes et `...rest` présents dans les patterns de base. [PD-08] | Séparer paramètres, constantes structurelles et surcharges ; appliquer la politique aux sorties. |
| Alias cycliques ou inconnus | Récursion locale dans `Token.expandReferences`, résolution permissive de certaines références ; comportement global non reproduit. [PD-03] [PD-04] | Graphe validé avant expansion, diagnostic avec chaîne de référence ; éviter toute conclusion upstream globale sans test. |
| Interpréteur runtime réintroduit | `cva` fusionne du CSS brut avant `css`. [PD-05] | Porter la sélection, compiler les branches ; inspecter le bundle JS final. |
| Explosion types/variantes | Risque d’architecture, pas coût mesuré dans cet audit. | Éviter produit cartésien par défaut ; benchmark types/build et limites explicites. |
| Build/invalidation incomplets | Filtres d’import et caches par module/global/disque dans l’unplugin. [SX-11] | Intégrer nouvelles importations ; empreinte de configuration ; isolation des contextes. |
| Autofix faux mais plausible | Proximité de valeur ne prouve pas intention, catégorie ou thème. | Suggestion séparée ; `autofix` absent tant que l’équivalence n’est pas prouvée. |
| Catalogue agent divergent | MCP expose l’introspection d’un driver ; fork doit le remplacer. [PV2-02] | Registre unique, version commune, filtre de visibilité consommateur. |
| Portage depuis mauvaise branche | Panda v2 refond les internes en Rust. [PV2-01] | Commit donneur par module ; aucune confusion v1/v2 ; suivi des dépendances des helpers. |
| Promesse « tout CSS est interdit » | Les sources non traitées ou CSS externe dépassent le hook local. | Définir la frontière de garantie et le contrôle de projet ; ne pas promettre une sandbox. |
| Oubli de licence/dépendance | Deux licences racines vérifiées seulement. [SX-12] [PD-12] | Conserver attribution ; revue des dépendances et inventaire de provenance du livrable. |

## Conditions avant gel des specs d’implémentation

Le modèle de politique et le registre peuvent être spécifiés dès maintenant sur ces bases. Les points sensibles de correspondance CSS, résolution inter-fichiers, dynamique, cache et poids des types doivent devenir des expériences de validation explicites. Ils ne doivent pas être remplacés par une affirmation de compatibilité déjà acquise.


---

### Sources citées

[PD-01]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/types/style-props.ts
[PD-02]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/utility.ts
[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-04]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/token.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PD-07]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/core/src/recipes.ts
[PD-08]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts
[PD-10]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/conditions.ts
[PD-12]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/LICENSE.md
[PV2-01]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/V2_MIGRATION.md
[PV2-02]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/packages/mcp/src/server.ts
[SX-01]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/index.js
[SX-02]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js
[SX-03]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js
[SX-08]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/atoms/README.md
[SX-11]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/unplugin/src/core.js
[SX-12]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/LICENSE

Périmètre de lecture et révisions : [SOURCES](../SOURCES.md).
