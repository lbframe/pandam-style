# Exemples de contrats machine

Ces fichiers sont des **exemples de structure**, pas des sorties réelles d’un compilateur, des fixtures exécutables ou des résultats de tests.

| Fichier | Ce qu’il illustre |
|---|---|
| [diagnostic.example.json](diagnostic.example.json) | Localisation, politique, candidat autorisé et absence d’autofix automatique. |
| [manifest.example.json](manifest.example.json) | Extrait de projection consommateur : vocabulaire, variantes, capacités et politique. |
| [build-report.example.json](build-report.example.json) | Rapport d’exécution futur ; tous les cas sont actuellement `not_run`. |

`$REGISTRY_DIGEST` est un symbole illustratif, pas une empreinte calculée par PandamStyle. Les coordonnées du diagnostic et les couleurs du manifeste sont fictives. Le manifeste ne contient qu’un extrait : il ne constitue pas la fixture de conformité complète.

Le contrat proposé distingue `tokens` primitifs publics de `semanticTokens`, partage les métadonnées de génération et annonce explicitement les capacités non implémentées. Les références sémantiques internes vers des primitives privées ne sont pas exposées comme des choix publics.

Les messages machine sont illustrés en anglais ; les codes sont indépendants de la langue d’affichage. Le schéma des erreurs inclut une plage source 1-indexée. Les colonnes devront suivre la convention de l’AST source choisie et documentée par l’implémentation, de façon identique pour les sorties texte et JSON.

Aucune validation de ces JSON ne prouve le rejet effectif d’un style. Seuls les builds et les tests futurs décrits dans [l’acceptation](../specs/03-ACCEPTANCE.md) pourront le démontrer.
