# Contrats d’API à spécifier

**PROPOSITION technique, pas syntaxe publique approuvée.** Le nom est PandamStyle. Aucun nom de package npm n’est ici présenté comme disponible ou réservé.

## Une bibliothèque, plusieurs responsabilités

L’API d’auteur définit tokens, conditions, thèmes, recipes et patterns. L’API de consommation sélectionne des références, paramètres et variantes autorisés. L’intégration build compile et applique les politiques. Ces responsabilités peuvent être exportées par des modules distincts **de PandamStyle**, sans créer une autre bibliothèque LB Frame au-dessus.

La frontière est portée par la configuration et vérifiée par le build, pas par la supposée identité humaine/IA de l’auteur d’un fichier. Les permissions précises restent un contrat de design system à formaliser ; les dépôts ne choisissent pas automatiquement ce contrat.

## Identité des tokens

Un token canonique doit conserver au moins : identifiant, catégorie, nature primitive/sémantique, valeur ou références, conditions, visibilité et source. La représentation consommateur peut être une référence typée ou une chaîne contrôlée ; l’audit ne justifie pas de figer dès maintenant l’une des syntaxes historiques `space.md`, `md` ou une nouvelle ponctuation.

Quelle que soit la syntaxe, le compilateur ne doit pas confondre un token d’espacement, une chaîne brute et une variable CSS arbitraire. Panda fournit catégories et provenance de valeurs ; StyleX fournit l’identité d’émission. [PD-03] [PD-04] [SX-09]

## Contrat des recipes

Déclaration statique de base, axes, valeurs autorisées et valeurs par défaut ; extension prévue pour combinaisons et slots. Le choix dépendant des props reste possible lorsque les branches de style sont déjà compilées. Le résultat interne doit rester composable par le moteur issu de StyleX. Le retour de chaînes de classes Panda n’est pas un format interne approprié pour conserver ses règles de conflit. [PD-05] [PD-06] [SX-03] [SX-06]

Il faut préciser les valeurs absentes, `null`, les axes inconnus et les conflits entre axes. Les comportements runtime de sélection ne doivent pas servir à accepter une nouvelle valeur CSS non déclarée. La conservation de toutes les méthodes `.raw` ou `.merge` du donneur n’est pas automatique : chaque export doit être justifié et validé.

## Conditions et exceptions

Une condition nommée pointe vers une définition canonique validée. Ne pas assimiler préférence système sombre et classe de thème sombre, ni supprimer les états ARIA/data en traduisant les raccourcis. [PD-10]

Une échappatoire autorisée doit annoncer sa portée, ses propriétés et sa justification, être repérable dans un rapport et subir un contrôle adapté. Une chaîne libre appliquée à toute propriété n’est pas une échappatoire contrôlée. Les valeurs structurelles des patterns doivent être distinguées des micro-décisions visuelles ; rejeter toute longueur littérale sans cette distinction casserait des layouts légitimes. [PD-08]

## Diagnostic machine — schéma illustratif

Les identifiants ci-dessous sont proposés, non réservés ni implémentés.

```json
{
  "schemaVersion": 1,
  "code": "PMS_RAW_DESIGN_VALUE",
  "severity": "error",
  "location": { "file": "src/page.tsx", "line": 12, "column": 5 },
  "property": "padding",
  "received": "17px",
  "category": "spacing",
  "rule": "token-only",
  "candidates": [{ "tokenId": "spacing.md", "value": "16px" }],
  "autofix": null
}
```

La localisation ci-dessus est fictive. Une suggestion `16px` proche de `17px` n’établit ni l’intention sémantique ni une équivalence entre thèmes. Le compilateur rejette sur des règles certaines ; les suggestions restent séparées, explicables et non automatiquement appliquées lorsque leur sûreté n’est pas prouvée. Les erreurs source existantes sont une base d’intégration, pas ce contrat final. [SX-02]

## Introspection

Tokens visibles, variantes, slots, patterns, conditions et règles doivent provenir du registre réellement compilé. Le serveur MCP Panda v2 montre le mécanisme d’exposition ; son driver Rust et l’exposition de toute la configuration ne sont pas à recopier aveuglément. Un manifeste consommateur peut masquer les valeurs et primitives qui ne font pas partie du vocabulaire autorisé. [PV2-02]


---

### Sources citées

[PD-03]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/dictionary.ts
[PD-04]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/token-dictionary/src/token.ts
[PD-05]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/cva.ts
[PD-06]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/generator/src/artifacts/js/sva.ts
[PD-08]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/patterns.ts
[PD-10]: https://github.com/chakra-ui/panda/blob/1a310482ff18102c44b2a478b7644b064a80d7c6/packages/preset-base/src/conditions.ts
[PV2-02]: https://github.com/chakra-ui/panda/blob/c171f630adc6dec4a1f9e4b9a79ef706d8278aae/packages/mcp/src/server.ts
[SX-02]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/visitors/stylex-create.js
[SX-03]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-create.js
[SX-06]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/stylex/src/stylex.js
[SX-09]: https://github.com/facebook/stylex/blob/fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2/packages/@stylexjs/babel-plugin/src/shared/stylex-define-vars.js

Périmètre de lecture et révisions : [SOURCES](../SOURCES.md).
