# 03 — Critères d’acceptation et preuves

**Version 0.1 · DRAFT · 2026-09-28**  
**Tous les cas ci-dessous sont à implémenter et à exécuter. Aucun résultat du compilateur n’est annoncé.**

La définition détaillée de chaque cas se trouve dans [cases.json](../acceptance/cases.json) : précondition, action, résultat attendu, preuve, exigences et sources. Ce fichier n’est pas un runner. Les assertions attendues ne sont pas des observations déjà réalisées.

## 1. Trois niveaux à ne pas confondre

**Spécification valide :** les fichiers du présent dossier sont cohérents et les références sont résolues.

**Prototype démontré :** une chaîne réelle a compilé et ses comportements ont été observés ; le périmètre demeure limité à ce qui a été exécuté.

**P0 conforme :** tous les cas obligatoires du socle ont des preuves identifiées, les limitations sont exactes et les hypothèses bloquantes ont été clôturées. Un prototype positif isolé ne suffit pas.

Les tests de composition StyleX et la fixture Panda cités dans l’audit donnent des références à adapter. Ils ont été lus, pas exécutés par cet audit. La nouvelle lecture du flattener précise la normalisation, mais ne remplace pas les essais différentiels. [SX-07] [PD-11] [SX-13] [A-TESTS]

## 2. Couverture minimale

| Groupe | Cas détaillés | Ce que cela doit établir |
|---|---|---|
| Baseline et vrai portage | AC-001–002 | Base exécutée ; code donneur réellement intégré et traçable. |
| Registre | AC-003–009 | Références, cycles, catégories, collisions et identité canonique. |
| Politiques et provenance | AC-010–023 | Rejet des valeurs brutes ; pas de contournement par types, aliases, variables ou rôle auteur. |
| Conditions | AC-024–031 | Parité des conditions et refus explicite du sous-ensemble non supporté. |
| Thèmes | AC-032–035 | Valeurs effectives, portées et distinction préférence/thème. |
| Recipes | AC-036–040 | Domaines finis, défauts, ordre des axes et runtime borné. |
| Composition et capacités | AC-041–043 | Normalisation unique, conflits et refus des capacités P1 non livrées. |
| Types et manifeste | AC-044–046 | Une seule définition du vocabulaire et génération cohérente. |
| Diagnostics | AC-047–049 | Origine des erreurs, suggestions admissibles, stabilité. |
| Frontière du build | AC-050–055 | Imports, entrées alternatives, canaux de style et couverture. |
| Incrémentalité | AC-056–060 | Pas de catalogue périmé, cache contaminé ou génération partielle. |
| Serveur/client | AC-061–063 | CSS présent et sélection sans nouvel interpréteur CSS. |
| Distribution et mesures | AC-064–066 | Installation hors workspace, attributions et coûts mesurés. |

Les plages ci-dessus suivent le catalogue livré. Un test paramétré peut couvrir plusieurs propriétés ou situations ; il doit produire le détail de ses sous-cas. Le nombre de lignes du catalogue n’est donc pas présenté comme un nombre de tests déjà écrits.

## 3. Contrat du runner à construire

Chaque cas d’échec attendu DOIT faire tourner le chemin réel de compilation ou de build qu’il teste. La preuve comprend le code de sortie, le diagnostic structuré et la configuration. Un texte d’erreur inventé dans un mock ne satisfait pas l’exigence.

Un test négatif réussi signifie : **le build a bien échoué pour la raison prévue**. Une erreur d’installation, de syntaxe étrangère à la fixture ou de résolution de package ne remplace pas un rejet de politique.

Le runner distingue `passed`, `failed`, `not_run` et `blocked`. Les cas `blocked` ou `not_run` ne sont jamais agrégés aux succès. Il publie aussi les exclusions et leur justification ; un cas obligatoire exclu laisse le P0 incomplet.

Les jeux JS sans typecheck et TS avec contournement explicite sont séparés des tests TypeScript. Le rejet des valeurs doit être prouvé sans l’aide de `tsc`. Un snapshot de types ne démontre pas le rejet du CSS. [B-P0] [A-TESTS]

## 4. Référence CSS et composition

### 4.1 Tests différentiels

Pour les cas hérités, construire une entrée normalisée équivalente pour la base StyleX et pour PandamStyle. Comparer les déclarations, variables, conditions et styles calculés. Toute différence attendue doit être associée à une décision de divergence.

Pour le code Panda porté, comparer les capacités retenues — sélection, defaults, catégories, états — sans exiger ses noms de classes ni ses couches de cascade. Le portage remplace son émission par celle du fork. [SX-03] [PD-05] [PD-11]

### 4.2 Cas charnière : base et hover

**Given :** base `color = token(text.primary)` et `hover.color = token(action.primaryHover)` ; variante modifiant seulement `color` hors condition.

**When :** composer base puis variante dans la forme normalisée D-05.

**Then :** la variante gagne pour la valeur hors condition ; la branche hover reste en place. Une variante écrivant également sous hover remplace cette branche précise. Les syntaxes publiques équivalentes doivent aboutir à la même forme.

Ce comportement est un **contrat proposé de PandamStyle**, motivé par le flattener, pas une affirmation que toutes les formes d’écriture upstream font déjà la même chose. [SX-13]

### 4.3 Vérification navigateur

Les snapshots CSS sont complétés par des styles calculés pour états, thèmes imbriqués, breakpoints et conflits. L’ordre des sources est permuté ; des largeurs juste avant, à et après les bornes sont testées. Le nombre et la version des navigateurs utilisés sont consignés ; le résultat d’un navigateur n’est pas généralisé à tous.

## 5. Frontière de conformité

Le rapport contient les racines déclarées, les fichiers effectivement analysés, les imports résolus et les canaux explicitement exclus. La compilation d’un seul fichier heureux ne constitue pas une preuve de couverture.

Un fichier de page qui importe uniquement une recipe générée reste dans la couverture. Les imports indirects ou alias ne sont pas exemptés. Un spread JSX inconnu, un CSS local non approuvé ou un helper upstream non contrôlé doivent provoquer le résultat défini dans le profil, pas disparaître des fixtures. [SX-11] [B-GUARDS]

La suppression d’un fichier fautif de la liste des tests peut transformer la suite en vert sans rendre le produit conforme. Le manifeste des cas et les contrôles de couverture doivent rendre cette modification visible.

## 6. Types, manifeste et génération

Tester une addition, une suppression, un changement de visibilité et un changement de politique. Le registre et toutes ses projections doivent rester alignés. La génération doit pouvoir échouer sans publier un ensemble mélangeant anciennes et nouvelles sorties.

Pour chaque génération acceptée, conserver une association vérifiable entre `registryDigest`, version du contrat compilateur, options d’émission et artefacts. Les CSS/JS n’ont pas besoin d’incorporer un long manifeste au runtime : une métadonnée latérale de build suffit si elle lie réellement leurs contenus.

Les projections consommateur filtrent les tokens privés, mais le compilateur dispose des définitions nécessaires pour vérifier les références internes. Tester que la suggestion d’un token privé ne révèle pas une possibilité d’usage pourtant interdite. [A-API] [A-TESTS]

## 7. Mesures de performance

Le protocole doit comparer, sur le même environnement documenté, un cas StyleX équivalent et le fork. Pour chaque taille de registre, mesurer build froid, build chaud, rebuild après token/politique, temps de génération, temps/mémoire `tsc`, taille JS/CSS et sélection de variantes.

Les résultats bruts, les répétitions et la méthode de synthèse sont joints. Les tests de forme vérifient séparément l’absence d’expansion cartésienne et d’interpréteur CSS. Un petit bundle ne démontre pas à lui seul une faible latence éditeur.

Les sources ne donnent pas de plafond d’overhead accepté. Cette version exige la mesure mais ne crée pas un seuil arbitraire. **Le rapport doit distinguer « mesures collectées » de « performance approuvée pour diffusion ».** Une décision de budget après mesure est consignée dans le registre de décisions ; elle ne réécrit pas les observations. [A-TESTS] [A-RISKS]

## 8. Dossier de preuves final attendu

Le rapport d’exécution futur inclura commit exact du fork, commits donneurs, environnement, lockfile, configuration, digests et état de chaque cas. Pour chaque succès, un chemin de log ou artefact vérifiable ; pour chaque échec, cause, diagnostic et reproduction.

Joindre le registre de portage, l’inventaire des dépendances/licences, le package testé hors workspace, la fixture serveur/client et les mesures. Les tests upstream échouant avant portage sont distingués des régressions nouvelles ; un échec affectant une garantie P0 doit être traité, pas simplement classé « préexistant » pour obtenir un PASS.

L’[exemple de rapport](../examples/build-report.example.json) décrit le format prévu. Il contient volontairement des états non exécutés et aucun faux identifiant de commit du fork.

## 9. Décision d’acceptation

Le socle est **incomplet** si une garantie obligatoire n’a pas été observée, si une hypothèse bloquante reste ouverte, si une violation n’échoue qu’au typecheck, ou si le chemin fautif a été exclu pour faire passer la suite.

Le socle est **conforme au profil P0** lorsque toutes les preuves requises existent et que les limitations annoncées correspondent au comportement. Cette conclusion ne doit pas être renommée « PandamStyle complète » : P1 et P2 restent hors de ce verdict.

---

[SX-07]: ../SOURCES.md#sx-07
[PD-11]: ../SOURCES.md#pd-11
[SX-13]: ../SOURCES.md#sx-13
[A-TESTS]: ../evidence/audit/analysis/TEST_PLAN.md
[B-P0]: ../evidence/original-brief/04_P0_SPEC.md
[SX-03]: ../SOURCES.md#sx-03
[PD-05]: ../SOURCES.md#pd-05
[SX-11]: ../SOURCES.md#sx-11
[B-GUARDS]: ../evidence/original-brief/06_AGENT_GUARDRAILS.md
[A-API]: ../evidence/audit/analysis/API_PROPOSAL.md
[A-RISKS]: ../evidence/audit/analysis/RISK_REGISTER.md
