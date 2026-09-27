# PandamStyle — Architecture et premier socle

**Spécification v0.1 · 28 septembre 2026 · DRAFT**

PandamStyle est une vraie bibliothèque : **fork de StyleX + code de Panda CSS porté et intégré**. Pas une couche LB Frame, pas deux moteurs proposés côte à côte. Son objectif est que les agents composent avec un vocabulaire de design autorisé. [U-01] [U-02]

## Ce qui est livré

| Document | Utilité |
|---|---|
| [01 — Architecture](specs/01-ARCHITECTURE.md) | Modules, registre, compilation, composition, frontière de contrôle et maintenance du fork. |
| [02 — Périmètre P0](specs/02-P0-SCOPE.md) | Capacités obligatoires, sous-ensembles explicites, profils de test, séquence d’implémentation. |
| [03 — Critères d’acceptation](specs/03-ACCEPTANCE.md) | Tests à réaliser, preuves exigées et règles empêchant un faux PASS. |
| [04 — Décisions et hypothèses](specs/04-DECISIONS.md) | Ce qui vient de toi, ce qui vient des sources, ce que cette version propose et ce qui reste à démontrer. |

Les [cas structurés](acceptance/cases.json) sont une liste de spécifications de tests, **pas une suite exécutable ni des résultats**. Les [exemples](examples/README.md) précisent les échanges machine proposés. Les [sources](SOURCES.md) et les documents de l’audit précédent sont conservés dans `evidence/`, sans réécrire leur historique.

## La proposition en une phrase

Un registre de design system alimente la validation, les types et le manifeste ; les visiteurs natifs de PandamStyle compilent les tokens et les recipes vers le moteur atomique hérité de StyleX ; au runtime, seules la sélection de branches finies et leur composition subsistent.

## Ce que P0 démontrera

Un design system de test, deux thèmes, une recipe de bouton et une application serveur/client. Les styles conformes compilent ; une valeur interdite échoue avec un diagnostic précis, même sans TypeScript. Le CSS, les types et le manifeste correspondent au même registre.

Le P0 est le socle technique. **Ce n’est pas encore l’expérience finale de composition de pages**, qui dépend aussi des slot recipes, compound variants et patterns prévus en P1. [A-P0] [B-PHASES]

## Statut et ordre d’autorité

Les décisions explicites de l’utilisateur priment sur les formulations historiques du bundle. Les exigences du bundle donnent la cible ; le code épinglé apporte des observations ; cette spécification propose les mécanismes manquants. Le `go` autorise ici la rédaction, pas une approbation implicite de toutes les nouvelles signatures ou restrictions.

Dans les specs, **DOIT** décrit le contrat proposé à satisfaire pour déclarer ce P0 conforme. Il ne signifie ni « déjà implémenté » ni « déjà approuvé par l’utilisateur ». Les identifiants `D-*` rendent les propositions nouvelles repérables.

**Aucun fork créé ou modifié, aucun portage, aucun build ni test de PandamStyle exécuté par cette livraison.** La validation documentaire ne vaut pas validation du compilateur.

---

[U-01]: SOURCES.md#u-01
[U-02]: SOURCES.md#u-02
[A-P0]: evidence/audit/analysis/P0_IMPLEMENTATION_PLAN.md
[B-PHASES]: evidence/original-brief/05_P1_P2_ROADMAP.md
