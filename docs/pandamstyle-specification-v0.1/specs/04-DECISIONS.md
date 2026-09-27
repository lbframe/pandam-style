# 04 — Décisions, propositions et hypothèses

**Version 0.1 · DRAFT · 2026-09-28**

Ce registre empêche une proposition technique de devenir, par répétition, une décision attribuée à l’utilisateur.

## 1. Décisions utilisateur acquises

| ID | Décision | Source |
|---|---|---|
| U1 | Le nom est **PandamStyle**. | Correction explicite de la conversation. [U-01] |
| U2 | C’est une bibliothèque autonome fondée sur un vrai fork de StyleX. Pas une couche LB Frame ni un wrapper. | Correction explicite. [U-01] |
| U3 | Des pièces de Panda CSS sont réellement portées et intégrées ; pas seulement leurs idées. | Correction explicite. [U-01] |
| U4 | Le besoin directeur est un vocabulaire contraint : l’agent compose plutôt que réinventer les micro-décisions de design. | Cheminement fourni. [U-02] |
| U5 | Les décisions techniques doivent être fondées sur l’analyse des dépôts, via le plugin GitHub, avant un questionnaire général. | Instructions explicites de la conversation. [U-01] |

Le dernier `go` autorise la préparation de la spec annoncée. Aucun de ces cinq acquis ne constitue une autorisation de publier un package, créer un dépôt distant ou lancer une implémentation dans cette livraison.

## 2. Propositions de cette version

**Statut de toutes les lignes : proposées, non validées par exécution.** Les sources motivent le choix ; elles ne déterminent pas seules toutes ses modalités.

| ID | Proposition | Pourquoi / incidence |
|---|---|---|
| D-01 | Conserver le socle JS/Babel et les modules existants ; pas de réécriture Rust ou Flow→TS générale. | Maintenir la proximité du vrai fork, porter les modules Panda inspectés. [A-UPSTREAM] |
| D-02 | Définitions statiquement résolues, sans fonctions de configuration arbitraires dans P0. | Préserver provenance et reproductibilité ; sous-ensemble à tester. [A-ARCH] |
| D-03 | Identité logique stable et digest du registre complet, indépendants du checkout. | Même CSS/variables entre package, serveur et client ; caches cohérents. [SX-09] [A-TESTS] |
| D-04 | Base complète + thèmes nommés à surcharges partielles et références sémantiques typées. | Raccordement au modèle de variables/thèmes existant ; pas de second système. [PD-03] [SX-10] |
| D-05 | Normalisation unique en blocs de conditions ; conflits par propriété et condition. | Le flattener distingue les syntaxes ; éliminer cette ambiguïté publique. [SX-13] |
| D-06 | Base puis axes déclarés ; absence/undefined prennent le défaut ; null/inconnus sont refusés. | Déterminisme de recipe et garde runtime ; choix explicite, pas copie aveugle de toutes les méthodes de cva. [PD-05] [A-API] |
| D-07 | Support P0 de styles conformes + recipes, sans décider la permission définitive des pages. | Le code ne tranche pas le choix produit composition-only. [A-API] |
| D-08 | Sélection runtime finie oui ; valeurs CSS runtime libres et escape hatch générique non en P0. | Réduire les garanties à un périmètre démontrable ; exceptions dynamiques à prolonger. [A-P0] [B-GUARDS] |
| D-09 | Invalidation globale initiale au changement de registre ; génération cohérente. | Éviter d’optimiser un cache avant d’en prouver l’autorité. [SX-11] [A-TESTS] |
| D-10 | Diagnostics structurés, suggestions, aucun autofix de token en P0. | 17px→16px n’est pas une équivalence visuelle prouvée. [A-API] |
| D-11 | Manifeste minimal et noyau de politiques en P0 ; outils plus riches ensuite. | Résolution explicite du décalage entre roadmap et acceptance du bundle. [A-DECISION] [B-TESTS] |
| D-12 | Inventaire fermé des propriétés supportées ; composites non couverts refusés. | Empêcher un raccourci ou une propriété inconnue d’ouvrir un chemin permissif. [A-TESTS] |
| D-13 | Petit domaine structurel autorisé par propriété dans la fixture stricte. | Contraindre le design sans confondre tout nombre avec une décision visuelle arbitraire. [A-API] |
| D-14 | Sous-ensemble explicite d’états, media en pixels et combinaisons bornées. | Pas de traduction approximative de group/peer ou d’unités mixtes. [PD-10] [A-RISKS] |
| D-15 | Exemples avec références de tokens complètes et module de design system généré. | Notation candidate ; noms npm, alias courts et signatures finales non gelés. [A-API] |
| D-16 | Pilote Vite + React avec SSR Node et client, versions verrouillées au lot 0. | Une intégration pour démontrer le socle ; TanStack Start reste une intégration cible non certifiée. [B-CONTEXT] [SX-11] |

## 3. Hypothèses à fermer par des expériences

| ID | Hypothèse | Preuve requise | Effet tant qu’elle reste ouverte |
|---|---|---|---|
| H-01 | Le raccordement du registre peut préserver les identités de variables sur tous les chemins P0. | AC-009, AC-032–034, AC-061–064. | Pas de promesse de parité package/app ou SSR. |
| H-02 | La forme canonique en blocs préserve la cascade et les conflits voulus sans réécriture générale du moteur. | AC-024–031, AC-041–042 avec navigateur. | Normalisation D-05 proposée, pas validée. |
| H-03 | Les nouveaux exports et réexports sont tous reconnus dans l’intégration retenue. | AC-050–055, AC-064. | Aucun PASS de couverture du build. |
| H-04 | L’invalidation et l’isolation couvrent tous les artefacts d’une génération. | AC-046, AC-056–060, AC-063. | Aucun PASS incrémental. |
| H-05 | Le portage des recipes maintient un runtime fini et une taille non cartésienne. | AC-036–042, AC-062, AC-066. | Aucun verdict « sans interpréteur » ou « overhead négligeable ». |
| H-06 | Les helpers transitifs des donneurs sont portables dans les limites retenues et distribuables avec leurs obligations. | AC-001–002, AC-064–065. | Plan de fichiers incomplet pour implémentation autonome sans cet inventaire. |
| H-07 | Les types et diagnostics restent praticables pour de grands registres. | AC-044, AC-047–049, AC-066. | Mesures requises avant décision de budget/diffusion. |

Aucune hypothèse ne se ferme par lecture d’un snapshot seul. Si un prototype la contredit, consigner l’expérience, proposer un ajustement puis mettre à jour la décision et ses tests ; ne pas modifier les attendus silencieusement.

## 4. Arbitrages produit restant réellement ouverts

**Permissions des pages.** La permission de créer des styles conformes ou de ne composer que des composants/recipes/patterns n’est pas tranchée par les dépôts. Le socle garde cette distinction dans ses rôles sans imposer maintenant une politique universelle.

**Exceptions dynamiques.** Le besoin d’usages tels que coordonnées de pointeur existe. La surface exacte, les propriétés éligibles et le contexte de revue demandent un contrat dédié. Le motif reste optionnel dans le bundle ; son obligation éventuelle serait une nouvelle décision.

**API publique et diffusion.** Les noms d’exports, le namespace npm, la disponibilité du nom, les cibles de compatibilité et les budgets de performance restent à confirmer à partir de prototypes et mesures. Ils ne sont pas maquettés comme des capacités déjà publiées.

Ces sujets sont consignés, sans bloquer la présente rédaction par un nouveau questionnaire. Une validation de leurs propositions sera nécessaire avant de prétendre que le contrat public est gelé.

## 5. Changements par rapport au cadrage précédent

Les questions « wrapper ou fork ? » et « layer LB Frame ou vraie bibliothèque ? » ne sont plus ouvertes. Le code donneur est maintenant localisé. La présente version ajoute des contrats concrets sur identité, provenance, conditions, composition, sélection runtime et invalidation.

Elle ne réécrit pas le contrat fondateur historique ni le bundle : leurs omissions et options restent visibles dans les copies de référence. Le manifeste avancé en P0, le refus des syntaxes non couvertes et l’absence d’autofix automatique sont explicitement des propositions nouvelles ou reprises de l’audit, pas des instructions initiales attribuées à l’utilisateur.

## 6. Prochain acte d’ingénierie prévu

Sur la base de cette spec, un agent d’implémentation doit commencer par **L0 puis les expériences de raccordement des lots L1–L2**, avec preuves et petits commits séparant fork, portage, politique et divergence sémantique. Ce document n’a ni créé le fork ni exécuté ces travaux.

---

[U-01]: ../SOURCES.md#u-01
[U-02]: ../SOURCES.md#u-02
[A-UPSTREAM]: ../evidence/audit/analysis/UPSTREAM_COMPATIBILITY.md
[A-ARCH]: ../evidence/audit/analysis/ARCHITECTURE.md
[SX-09]: ../SOURCES.md#sx-09
[A-TESTS]: ../evidence/audit/analysis/TEST_PLAN.md
[PD-03]: ../SOURCES.md#pd-03
[SX-10]: ../SOURCES.md#sx-10
[SX-13]: ../SOURCES.md#sx-13
[PD-05]: ../SOURCES.md#pd-05
[A-API]: ../evidence/audit/analysis/API_PROPOSAL.md
[A-P0]: ../evidence/audit/analysis/P0_IMPLEMENTATION_PLAN.md
[B-GUARDS]: ../evidence/original-brief/06_AGENT_GUARDRAILS.md
[SX-11]: ../SOURCES.md#sx-11
[A-DECISION]: ../evidence/audit/analysis/DECISION.md
[B-TESTS]: ../evidence/original-brief/07_ACCEPTANCE_TESTS.md
[PD-10]: ../SOURCES.md#pd-10
[A-RISKS]: ../evidence/audit/analysis/RISK_REGISTER.md
[B-CONTEXT]: ../evidence/original-brief/01_CONTEXT.md
