# PandamStyle — Contrat fondateur

**Version :** 0.1  
**Statut :** proposition de spécification à discuter ; aucune implémentation engagée.  
**Date :** 27 septembre 2026  
**Périmètre :** identité de la bibliothèque, responsabilités, contraintes attendues et décisions encore ouvertes.

## 1. Décisions acquises

PandamStyle est une **bibliothèque autonome fondée sur un véritable fork de StyleX**, dans lequel sont intégrées et adaptées les pièces retenues de Panda CSS.

Ce n’est ni une surcouche LB Frame, ni un wrapper de StyleX, ni deux systèmes de styling proposés côte à côte. Le portage de pièces de Panda CSS fait partie du projet : une simple inspiration conceptuelle ne remplace pas cette exigence.

Le choix du fork et le nom **PandamStyle** sont acquis. L’audit technique doit déterminer **comment construire ce fork**, et non rouvrir la décision de le faire. Les fichiers et composants précis à reprendre ne sont pas encore identifiés.

Ces décisions explicites de la conversation remplacent les formulations historiques du bundle qui décrivent une API `@lbframe/ui`, une couche LB Frame ou la seule reprise des « idées de Panda ». Les autres exigences du bundle restent des éléments de cadrage, avec leurs questions ouvertes. [S3]

## 2. Principe fondateur

> The page-generation LLM performs composition, not micro-design.

PandamStyle doit permettre à un agent de composer une interface avec un vocabulaire de design autorisé, plutôt que d’inventer continuellement des couleurs, espacements, rayons, typographies ou breakpoints.

La liberté recherchée concerne la structure du contenu, sa hiérarchie, la composition, le choix des composants et de leurs variantes. Les décisions visuelles répétables sont définies dans le design system et contrôlées par les outils de compilation. [S2, « Ton besoin réel derrière tout ça »]

Ce principe exprime l’objectif produit. Il ne constitue pas, à lui seul, une garantie de qualité esthétique : cette spécification ne définit pas de mesure permettant de certifier une « qualité AAA ».

## 3. Statut des exigences

- **Acquis** : décision explicitement confirmée par l’utilisateur, listée en section 1.
- **Attendu des sources** : comportement demandé par le bundle ou le cheminement ; il reste à spécifier techniquement et à vérifier dans le code.
- **Proposition** : précision ajoutée dans cette version pour discussion, non considérée comme approuvée.
- **Ouvert** : arbitrage absent des sources ou formulations à réconcilier explicitement.

Les exemples du bundle décrivent des comportements souhaités. Ils ne figent ni la syntaxe publique, ni les noms de packages, ni un comportement déjà implémenté.

## 4. Répartition des responsabilités

| Responsable | Responsabilité attendue | Limite |
|---|---|---|
| Mainteneurs de PandamStyle | Faire évoluer le fork, porter les pièces retenues de Panda CSS, définir l’API, la compilation, les types et les diagnostics. | Ne pas intégrer le design particulier de LB Frame comme dépendance obligatoire de la bibliothèque. |
| Auteur d’un design system | Définir les tokens primitifs et sémantiques, thèmes, conditions, recipes, variantes, patterns et politiques applicables. | Les valeurs et décisions propres au projet ne deviennent pas des constantes universelles de PandamStyle. |
| Auteur ou agent de produit | Composer les interfaces avec le vocabulaire fourni ; choisir composants, variantes et conditions autorisées. | Ne pas inventer de primitives locales ni surcharger les composants là où la politique l’interdit. |
| Compilateur et outils de build | Vérifier les règles couvertes, produire le CSS statique et expliquer les violations. | Le périmètre des fichiers et voies de styling contrôlés doit être spécifié ; une garantie universelle n’est pas démontrée. |

Les responsabilités du bundle sont conservées, mais replacées dans une bibliothèque indépendante et les design systems qui la consomment. [S1, `02_TARGET_ARCHITECTURE.md` ; S3]

**Proposition à valider :** matérialiser la séparation entre définition du design system et consommation produit par des frontières de modules, packages ou API. La règle dépendrait du contexte d’usage déclaré, pas de l’identité humaine ou artificielle de l’auteur. Cela ne définit pas encore un mécanisme de sécurité empêchant un agent autorisé à modifier tout le dépôt de changer la configuration.

## 5. Contrat comportemental attendu

### F-01 — Une seule bibliothèque publique

L’application utilise le vocabulaire public de PandamStyle. Elle n’a pas à choisir entre une API StyleX et une API Panda concurrentes.

Les mécanismes portés depuis Panda CSS sont intégrés à PandamStyle. Ils ne sont pas exposés comme un second moteur de styling à utiliser en parallèle. Le nombre et le découpage des packages PandamStyle restent ouverts. [S1, `08_GPT6_PRO_BRIEF.md` ; S3]

### F-02 — Des contraintes effectives à la compilation

Lorsqu’une propriété ou catégorie est déclarée token-only, une valeur brute interdite doit faire échouer la compilation ou le build. Une convention documentaire, un diagnostic TypeScript seul ou un lint seul ne suffisent pas pour cette garantie.

Exemple comportemental du bundle : avec une politique stricte sur les espacements, `padding: "17px"` échoue ; une référence à un token d’espacement déclaré réussit. Le choix entre `"md"`, `"space.md"` et une référence typée reste ouvert. [S1, `04_P0_SPEC.md`, §1 et §3]

Les valeurs brutes nécessaires à la définition initiale des tokens doivent être distinguées des usages produit auxquels la politique s’applique. Le point précis où cette distinction est vérifiée reste à concevoir.

### F-03 — Des tokens qui expriment l’intention

Le modèle comporte des tokens primitifs et des tokens sémantiques, ces derniers pouvant référencer les premiers. L’API destinée aux agents privilégie l’intention, par exemple `surface.elevated`, plutôt qu’une couleur concrète.

**Non tranché :** privilégier les tokens sémantiques ne signifie pas encore interdire tous les tokens primitifs dans le code produit. La politique exacte reste à décider. Le modèle complet des thèmes, de leurs conditions et de la résolution des alias reste à préciser. [S1, `04_P0_SPEC.md`, §2 ; S2, « séparer valeur et intention »]

### F-04 — Choisir des recipes plutôt que redessiner les composants

Les recipes proposent des styles de base, des variantes et des variantes par défaut. Les noms et valeurs sont typés à partir de leur définition.

L’agent sélectionne des décisions déjà définies. Les slots, compound variants et patterns prolongent cette logique, selon les phases prévues en section 8.

Les règles de surcharge et de priorité entre base, variante, condition, combinaison et composition externe ne sont pas définies par cette version. [S1, `04_P0_SPEC.md`, §4 ; `05_P1_P2_ROADMAP.md`]

### F-05 — Des conditions déclarées

Lorsque la politique l’exige, le code produit utilise les conditions nommées du design system plutôt que des media queries ou breakpoints locaux arbitraires.

La syntaxe d’écriture et la priorité des conditions restent à fixer. [S1, `04_P0_SPEC.md`, §5]

### F-06 — Des types dérivés du design system

Les types des tokens, conditions et variantes proviennent des définitions correspondantes ; ils ne doivent pas nécessiter une seconde liste d’unions maintenue manuellement.

La suppression d’un token doit rendre ses usages périmés détectables. Les mécanismes de génération, d’invalidation et de mise à jour de ces types restent à spécifier. [S1, `04_P0_SPEC.md`, §3 ; `07_ACCEPTANCE_TESTS.md`, « Type generation »]

### F-07 — Une compilation statique préservée

Le projet conserve comme objectifs l’extraction statique, le CSS atomique et une production déterministe. Les recipes et conditions ne doivent pas être obtenues au prix d’un interpréteur CSS au runtime. [S1, `03_FEATURE_MATRIX.md` ; `07_ACCEPTANCE_TESTS.md`, « Static output »]

Cette exigence ne tranche pas encore le traitement des valeurs dynamiques. Il faudra distinguer la sélection d’une variante déjà compilée, le changement de thème et une valeur issue de données d’interaction. Aucun de ces cas n’est assimilé silencieusement à une autorisation générale de calculer des styles au runtime.

### F-08 — Des diagnostics utilisables par les agents

Une violation fréquente doit expliquer ce qui est invalide, la règle concernée et les alternatives autorisées. Les diagnostics doivent disposer de codes stables et d’informations lisibles par les outils.

Une suggestion de token proche est attendue lorsque la comparaison est pertinente ; une correction automatique n’est proposée que lorsqu’elle est sûre. Le format exact, les codes PandamStyle et les critères de sûreté restent à définir. [S1, `04_P0_SPEC.md`, §6 ; `06_AGENT_GUARDRAILS.md`]

**Proposition à valider :** distinguer explicitement une suggestion de conformité d’une correction préservant l’intention. Dans l’exemple `17px` → token de `16px`, le message peut proposer le token sans prétendre que les deux valeurs sont identiques ni appliquer automatiquement le changement.

### F-09 — Des exceptions délibérées

Les usages arbitraires réellement nécessaires passent par des exceptions explicites, recherchables et revues. Le bundle mentionne notamment une transformation liée aux coordonnées d’un pointeur et rejette les contournements génériques de type `any`.

Le bundle rend le motif optionnel. **Le rendre obligatoire serait une nouvelle décision**, non acquise ici. La syntaxe, les propriétés éligibles et les règles d’autorisation restent ouvertes. [S1, `06_AGENT_GUARDRAILS.md`]

### F-10 — Une frontière produit vérifiable

Les imports directs du moteur et les voies de styling interdites par le projet doivent être détectables. Le bundle accepte une combinaison de frontières de packages, règles d’architecture, lint et contrôles de build pour les imports ; cela ne remplace pas F-02 pour les valeurs de style.

**Proposition à valider :** documenter séparément les garanties du compilateur PandamStyle et les contrôles de projet couvrant styles inline, fichiers CSS et autres imports. Ne pas annoncer « aucun contournement possible » tant que cette surface n’est pas définie et testée. [S1, `04_P0_SPEC.md`, §7 ; `06_AGENT_GUARDRAILS.md`]

## 6. Ce que ce contrat ne décide pas

Cette version ne choisit pas les signatures publiques, les packages à publier, les intégrations de build ni les fichiers upstream à modifier. Elle ne démontre aucune compatibilité avec une version précise de StyleX ou Panda CSS : leurs dépôts n’ont pas été audités dans ce travail de rédaction.

Elle n’intègre pas une bibliothèque complète de composants UI dans le fork. Les composants et valeurs visuelles propres à chaque design system restent distincts des mécanismes fournis par PandamStyle. [S1, `README.md`, « Non-goals »]

## 7. Cas d’acceptation issus du bundle

Ces cas sont des **tests à écrire**, pas des tests exécutés ou réussis. Leur syntaxe définitive dépendra de l’API retenue.

| Cas | Résultat attendu | Phase du mécanisme |
|---|---|---|
| Token d’espacement déclaré sur une propriété compatible | Compilation acceptée. | P0 |
| Valeur `17px` sur un espacement déclaré token-only | Échec de compilation, code stable, suggestion pertinente. | P0 |
| Couleur brute en mode couleurs strict | Rejet ; recommandation sémantique lorsqu’une correspondance existe. | P0 |
| Breakpoint local non autorisé en mode named-only | Rejet. | P0 |
| Valeur de variante absente de la recipe | Échec TypeScript pour l’usage statique invalide. | P0 |
| Token supprimé encore utilisé | Erreur aux usages périmés. | P0 |
| Import direct StyleX dans un package produit interdit | Échec du contrôle d’architecture, lint ou build prévu. | P0 |
| Recipes et conditions compilées | CSS extrait statiquement, sans interpréteur CSS ajouté pour les reproduire. | P0 |
| Code de diagnostic dans une version compatible | Signification conservée. | P0 |
| Accès à un slot absent de la définition | Erreur de typage. | P1 |
| Production du manifeste minimal | Contient tokens, tokens sémantiques, conditions, recipes, variantes et politiques. | À arbitrer |

Source : [S1, `07_ACCEPTANCE_TESTS.md`]. La présence de tests de slots et de manifeste dans ce fichier ne vaut pas, à elle seule, décision de les avancer en P0.

## 8. Priorités conservées et ambiguïtés visibles

| Phase du bundle | Capacités |
|---|---|
| **P0** | Strict tokens ; semantic tokens ; types TypeScript dérivés ; recipes et variantes ; conditions contrôlées ; diagnostics ; frontière des imports directs du moteur. |
| **P1** | Slot recipes ; compound variants ; patterns de layout ; politiques détaillées par catégorie ; garde-fous statiques complémentaires. |
| **P2** | Dépréciation et versioning des tokens ; codemods ; métadonnées enrichies ; introspection et outils de migration. Le manifeste est placé ici dans la roadmap et le manifeste du bundle. |

**Manifeste : arbitrage nécessaire.** `05_P1_P2_ROADMAP.md` et `manifest.json` le placent en P2, mais `07_ACCEPTANCE_TESTS.md` attend déjà sa production. Cette version ne déplace pas cette fonctionnalité.

**Strictness : frontière à préciser.** P0 permet déjà une activation par catégorie via des booléens ; P1 introduit une politique plus fine avec des modes tels que token-only, named-only et arbitrary. Le contrat exact de chaque phase n’est pas encore défini.

**Patterns et slots : objectif final, pas P0 acquis.** Leur rôle central dans le cheminement ne suffit pas à modifier automatiquement leur priorité P1.

## 9. Décisions à prendre ensuite

| Sujet | Ce qui reste ouvert |
|---|---|
| **Liberté de l’agent de page** | Peut-il écrire des styles conformes aux tokens, ou seulement composer composants, recipes et patterns ? Est-ce une règle configurable par design system ? |
| **Primitifs et sémantique** | Quelles catégories exigent des tokens sémantiques, et où les primitifs restent-ils utilisables ? |
| **Syntaxe publique** | Références courtes, chemins complets ou références typées ; conventions de propriétés et conditions. |
| **Composition** | Règles de priorité, conflits, overrides autorisés, propriétés raccourcies et slots. |
| **Dynamisme et exceptions** | Valeurs dynamiques admissibles, expressions analysables, motifs, autorisations et portée des exceptions. |
| **Premier périmètre livrable** | Manifeste minimal dès P0 ou report maintenu ; nécessité éventuelle d’avancer certains patterns. |
| **Portage et intégrations** | Révisions upstream de référence, pièces de Panda à porter, fichiers du fork à modifier, intégrations à supporter et suivi des attributions applicables au code repris. |

**Proposition pour organiser la suite :** fixer d’abord la liberté d’écriture du code produit. Ce choix détermine la surface publique, les contournements à contrôler et la place des recipes et patterns dans la première version.

## 10. Sources et traçabilité

**[S1]** Archive fournie : `lbframe-stylex-panda-fork-bundle.zip`. Les onze fichiers ont été lus pour cette version : `README.md`, `01_CONTEXT.md`, `02_TARGET_ARCHITECTURE.md`, `03_FEATURE_MATRIX.md`, `04_P0_SPEC.md`, `05_P1_P2_ROADMAP.md`, `06_AGENT_GUARDRAILS.md`, `07_ACCEPTANCE_TESTS.md`, `08_GPT6_PRO_BRIEF.md`, `09_OPEN_QUESTIONS.md` et `manifest.json`.

**[S2]** Texte fourni : `Texto colado(5).txt`. Cheminement explicitant le vocabulaire autorisé, les semantic tokens, recipes, slot recipes, patterns, diagnostics et le principe « composition, not micro-design ».

**[S3]** Corrections explicites dans la conversation : « c’est pas une couche lbframe », « une vraie librairie, basée sur le fork de stylex, à laquelle on rajoute les pièces de Pandacss », et choix du nom « PandamStyle ».

Aucune recherche externe ni inspection du code upstream n’a été utilisée pour présenter des hypothèses d’implémentation comme des faits. Les propositions nouvelles sont identifiées ; les contradictions de priorité ne sont pas résolues implicitement.
