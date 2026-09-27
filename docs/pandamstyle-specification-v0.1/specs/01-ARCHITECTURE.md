# 01 — Architecture de PandamStyle

**Version 0.1 · DRAFT · 2026-09-28**  
**Portée :** architecture proposée pour P0, avec points d’extension P1/P2.  
**Compagnons :** [P0](02-P0-SCOPE.md), [acceptation](03-ACCEPTANCE.md), [décisions](04-DECISIONS.md).

## 1. Identité et invariants

**ARC-01 — Une bibliothèque autonome.** PandamStyle DOIT contenir le code du fork de StyleX et les adaptations de code Panda retenues. Un package qui ne fait que déléguer à deux installations upstream ne satisfait pas ce contrat. La séparation en modules internes ne crée pas une couche LB Frame. [U-01]

**ARC-02 — Un seul système de production CSS.** Les tokens, conditions, recipes et futurs patterns DOIVENT converger vers le moteur atomique du fork. Aucun émetteur Panda parallèle, aucune seconde cascade de recipes et aucun interpréteur général d’objets CSS au runtime ne sont introduits pour simuler le portage. La sélection runtime de styles déjà compilés reste autorisée. [A-ARCH] [SX-03] [SX-06] [PD-05]

**ARC-03 — Une définition, plusieurs projections cohérentes.** Le registre canonique DOIT être la source commune de la politique, des types, des diagnostics et du manifeste. Un choix refusé par la politique consommateur ne doit pas apparaître comme autorisé dans le catalogue de cet usage. [A-API]

**ARC-04 — Portée explicite.** La conformité concerne les API et fichiers couverts par le profil déclaré. PandamStyle n’est pas une sandbox contre un agent autorisé à réécrire la configuration, ni une certification esthétique. Le contrat est d’empêcher et de signaler les écarts de design couverts, pas de garantir qu’une composition autorisée sera belle. [U-02] [A-RISKS]

## 2. Bases immuables

| Élément | Base proposée pour ce travail | Usage |
|---|---|---|
| StyleX | `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2` | Base du véritable fork ; compilation, variables, thèmes, composition. |
| Panda v1 | `1a310482ff18102c44b2a478b7644b064a80d7c6` | Donneur principal des modules TypeScript inspectés. |
| Panda v2 | `c171f630adc6dec4a1f9e4b9a79ef706d8278aae` | Référence complémentaire pour l’introspection et les extensions, pas compilateur P0. |

Ces références sont celles de l’audit fourni. Elles ne sont ni une recherche de la « dernière version » ni une certification de stabilité. Le premier travail d’implémentation doit établir une baseline exécutée et inventorier les helpers transitifs. La lecture des fichiers donneurs ne prouve pas que leur simple copie compilera. [A-FILES] [A-UPSTREAM]

**D-01 — Proposition :** partir du JavaScript/Babel du fork, conserver les modules Flow existants, et autoriser des modules TypeScript pour les nouvelles pièces via interfaces explicites. Ne pas mêler ce chantier à une réécriture générale du compilateur en Rust ou de tout le dépôt en TypeScript.

## 3. Modules et responsabilités

Les noms ci-dessous sont des noms internes proposés, pas des noms npm réservés.

| Module interne | Responsabilité | Origine |
|---|---|---|
| `design-system` | Chargement déclaratif, tokens, graphes, propriétés, conditions, recipes, registre. | Portage Panda + validation et identité nouvelles. |
| `compiler` | Résolution des symboles, provenance, normalisation, politique, génération des branches compilées. | Fork des visiteurs StyleX + code PandamStyle. |
| `engine` | Représentation compilée, aplatissement, classes atomiques, règles, variables et thèmes. | Moteur StyleX conservé et adapté au besoin. |
| `runtime` | Composition, sélection finie de recipes et thèmes, validation des sélections inconnues. | Composition StyleX + sélection Panda adaptée. |
| `codegen` | Types projet, exports générés et manifeste filtré. | Générateurs Panda adaptés + projections du registre. |
| `diagnostics` | Codes, localisations, explications, suggestions déterministes. | Erreurs source StyleX + contrat machine nouveau. |
| `integration` | Collecte des sources, couverture, caches, émission des artefacts, échec du build. | Unplugin StyleX adapté. |

`runtime` NE DOIT PAS importer le chargeur de configuration, le registre complet, le validateur de CSS, Babel ou les modules de génération. Les données finies nécessaires aux variantes sont admises. `codegen` et `compiler` consomment la même représentation sérialisable, pas deux interprétations indépendantes de la configuration. [SX-01] [SX-06] [SX-11] [PD-03] [PD-05]

Le design system d’un projet est une **entrée** de PandamStyle, pas son moteur. Il peut appartenir à LB Frame ou à un autre produit ; aucune palette ni bibliothèque de composants LB Frame ne devient une dépendance obligatoire. [U-01]

## 4. Circuit de compilation

**ARC-05 — Ordre proposé obligatoire dans le profil P0.**

1. **Établir le contexte.** Résoudre configuration, racines, rôles des modules, options moteur, versions et dépendances déclarées.
2. **Construire le registre.** Collecter les définitions statiques, valider identités, références, catégories, thèmes, conditions, politiques et recipes.
3. **Résoudre les usages.** Suivre imports et réexports, reconnaître les déclarations PandamStyle et conserver leur emplacement source.
4. **Normaliser sans effacer l’intention.** Représenter explicitement tokens, valeurs littérales, conditions, branches et provenance.
5. **Valider la politique.** Vérifier rôle, visibilité, propriété/catégorie, valeurs, conditions et capacités disponibles. Une preuve absente n’est pas une autorisation.
6. **Abaisser vers le moteur.** Convertir les tokens validés en références de variables, les conditions en blocs canoniques et les recipes en branches compilées. Recontrôler les propriétés introduites par les expansions.
7. **Émettre une génération cohérente.** Collecter et dédupliquer le CSS, produire JS, types, manifeste et rapport de couverture associés au même registre.

Le code StyleX inspecté comporte plusieurs visiteurs et un chemin `atoms` ; il ne suffit pas d’intercepter un appel `create` dans un wrapper. L’unplugin filtre aussi les sources par imports. Ces deux observations imposent une couverture explicite des entrées et des imports générés. [SX-01] [SX-05] [SX-08] [SX-11]

### 4.1 Représentation de validation

**ARC-06 — IR avec provenance.** Une déclaration normalisée conserve au minimum :

```text
StyleDeclaration
  sourceLocation
  declaringModuleId + role
  propertyId + originalPropertySpelling
  conditionPath[]
  value = TokenRef | Literal | StructuralLiteral
  originChain[]
```

`TokenRef` comporte l’identité de système, le token canonique et la preuve de résolution par le compilateur. Une chaîne `var(--quelque-chose)` ne suffit pas à créer cette preuve. Les casts TypeScript, noms de variables locaux, spreads et alias d’import ne donnent pas de privilège supplémentaire.

**D-02 — Proposition :** le P0 ne généralise pas l’évaluation de JavaScript arbitraire. Les définitions acceptent des objets statiques, constantes et imports statiquement résolus. Les fonctions de configuration avec accès réseau, horloge, hasard ou environnement implicite sont hors du contrat. Le code de build n’est pas pour autant présenté comme exécuté dans une sandbox.

Les appels reconnus sont vérifiés par leur liaison résolue et leur module, pas seulement par leur nom textuel. Une fonction locale appelée `token` ne doit pas devenir le helper du compilateur.

### 4.2 Double contrôle

Un premier contrôle s’effectue avant conversion des références en chaînes CSS. Un second intervient après normalisation des raccourcis et expansions. Il doit vérifier que le passage n’a pas introduit une propriété interdite, perdu la catégorie d’origine ou transformé une valeur consommateur en « constante de confiance ». La provenance des valeurs internes n’est jamais auto-déclarable depuis une page. [A-ARCH] [SX-02] [PD-02]

## 5. Registre canonique

**ARC-07 — Contenu minimal.**

| Entrée | Champs sémantiques requis |
|---|---|
| Système | `systemId`, version du schéma, identifiant de profil, options de normalisation. |
| Token | `tokenId`, catégorie, nature primitive/sémantique, visibilité, définition, source. |
| Thème | Identifiant, surcharges, valeurs effectives, validation des références. |
| Condition | Nom, définition normalisée, famille, contraintes de combinaison et ordre applicable. |
| Propriété | Nom canonique, catégorie éventuelle, alias/raccourcis, mots-clés structurels admis. |
| Recipe | Identifiant, base, axes ordonnés, valeurs, défauts, branches, visibilité. |
| Politique | Catégories strictes, propriétés autorisées, conditions admises et rôle des sources. |
| Provenance | Module déclarant, emplacement, chaîne de références et origine des expansions. |

Le modèle peut réserver l’évolution vers slots, compounds et patterns, mais P0 NE DOIT PAS accepter leurs champs en les ignorant. Une capacité future rencontrée produit `PMS_UNSUPPORTED_FEATURE`.

### 5.1 Identité et empreintes

**D-03 — Proposition :** l’identité logique d’un token est `systemId + category + path`, sensible à la casse. Deux déclarations du même identifiant sont une erreur ; ni renommage automatique ni « dernière définition gagne » sur le registre. Les chemins sont des segments non vides ; les noms réservés à l’implémentation sont rejetés explicitement.

Le nom émis d’une variable repose sur une identité logique stable, pas sur le chemin absolu du checkout. Changer la valeur d’un token ne doit pas, à lui seul, modifier son identité de variable. La canonicalisation du `exportId` utilisé par StyleX doit respecter cette exigence. Ce raccordement reste à démontrer. [SX-09] [SX-10]

`registryDigest` couvre le registre normalisé complet, les politiques, conditions, valeurs de tous les thèmes et ordre des axes. Les tableaux porteurs de priorité gardent leur ordre ; les tables sans ordre sémantique sont triées avec une comparaison indépendante de la locale. Les horodatages, chemins absolus et numéros aléatoires ne participent pas à cette empreinte.

Le cache de compilation ajoute au digest le contenu du module, ses dépendances résolues, la version du compilateur, les options d’émission et la cible. Le manifeste expose le digest et un `compilerContractVersion` ; une version humaine de design system ne remplace pas cette identité technique.

### 5.2 Références et thèmes

**ARC-08 — Validation avant émission.** Toute référence doit exister et satisfaire sa catégorie. Les cycles directs ou indirects produisent un diagnostic avec le chemin du cycle. La validation porte aussi sur chaque thème effectif ; une branche inactive dans le thème par défaut ne masque pas un cycle dans le thème sombre.

Les tokens primitifs autorisent les valeurs littérales dans les modules déclarants. Les tokens sémantiques P0 sont des références à des tokens compatibles, éventuellement surchargées par thème ; les compositions de chaînes ou références polymorphes entre catégories sont rejetées comme non supportées. C’est un sous-ensemble proposé du modèle Panda, pas une affirmation sur les limites de Panda. [PD-03] [PD-04]

**D-04 — Proposition :** P0 possède un thème de base complet et des thèmes nommés à surcharges partielles. Une surcharge absente hérite de la base. Une référence inconnue ne déclenche aucun fallback silencieux. Les identifiants des variables sont partagés entre thèmes ; seules les valeurs et classes de thème changent. Un thème imbriqué restaure ses valeurs effectives, sans recevoir accidentellement une surcharge du thème extérieur.

La confidentialité n’est pas promise : une primitive non exposée aux agents peut rester visible dans le CSS produit. La visibilité contrôle l’API de consommation, pas la connaissance d’une couleur envoyée au navigateur.

## 6. Conditions et composition : un seul sens

La lecture complémentaire du flattener montre deux comportements : des conditions dans la valeur d’une propriété sont regroupées sous la clé de propriété ; des blocs de pseudo-classes ou at-rules produisent des clés conditionnelles séparées. Copier indifféremment les deux syntaxes pourrait donc changer les conflits. [SX-13]

**D-05 — Proposition : normaliser tous les styles PandamStyle vers des blocs de conditions.** Une forme publique orientée propriété peut être du sucre syntaxique, mais elle ne modifie pas les règles de composition.

```text
Entrée conceptuelle : padding = { base: token(md), wide: token(lg) }
Forme moteur        : padding = var(md)
                      @media(min-width:768px) { padding = var(lg) }
```

**ARC-09 — Conflits.** À propriété normalisée et chemin de condition identiques, la dernière branche appliquée gagne. Une surcharge de la valeur de base ne supprime pas implicitement la valeur `hover` ; pour celle-ci, il faut une déclaration sous la même condition. Les raccourcis sont comparés sur leurs propriétés effectives, après normalisation. Les collisions de noms de conditions pointant vers le même sélecteur doivent se résoudre vers la même identité de condition.

**Attention :** entre deux conditions *différentes* actives simultanément, le résultat dépend aussi de la cascade et des priorités. « Dernière variante gagne » ne remplace pas ces règles. P0 définit un sous-ensemble de conditions dans le document de périmètre et le valide dans un navigateur.

Le test de conservation compare le fork à StyleX sur la **forme normalisée retenue**, pas sur toutes les syntaxes historiques. Le moteur n’est pas réécrit pour recopier la cascade Panda. [SX-03] [SX-07] [PD-11]

## 7. Recipes compilées

**ARC-10 — Déclaration.** Une recipe P0 a une base, des axes finis et des valeurs par défaut. Le registre conserve un tableau `axisOrder`, capturé à la déclaration ; la sérialisation canonique ne doit pas le trier. L’ordre des clés dans les props passées par une page n’a aucun effet sur l’ordre d’application.

**D-06 — Sémantique proposée.** Appliquer la base, puis une branche par axe selon `axisOrder`. Une valeur absente ou `undefined` utilise le défaut ; sans défaut, aucune branche de cet axe. `null`, une clé inconnue ou une valeur inconnue sont des erreurs, jamais une sélection implicite. Un axe booléen possède un domaine déclaré ; `false` n’est pas assimilé à l’absence.

Une sélection littérale invalide échoue au build. Une sélection réellement dépendante des props utilise un sélecteur runtime borné : il vérifie clés et valeurs puis ne renvoie que des références précompilées. Une entrée invalide échoue de façon déterministe avec un code stable ; aucun style arbitraire ni fallback silencieux ne sont créés.

**ARC-11 — Représentation.** Le résultat est un `StyleRef` PandamStyle, opaque pour l’appelant et composable par le runtime du fork, non une chaîne Panda supposée interchangeable. Les méthodes de sortie CSS brute `.raw`, de fusion libre `.merge` et le retour de configuration CSS complète ne sont pas exposés dans le profil P0.

Le code de sélection et de défauts de `cva` doit être réellement porté et adapté ; ses fusions de CSS brut et son appel à l’émetteur Panda doivent être remplacés. Les branches sont compilées séparément : base + somme des branches d’axes, pas produit cartésien de toutes les combinaisons. [PD-05] [SX-03] [SX-06]

P1 prolongera ce modèle par des branches de compound variants et des `StyleRef` par slot. Aucun schéma définitif des combinaisons responsive n’est prétendu démontré ici. [PD-06] [B-PHASES]

## 8. Frontières d’écriture et de build

**ARC-12 — Rôles de modules.** Le profil désigne explicitement les modules de définition du design system et les modules consommateurs. Le rôle est attribué par résolution de chemins et configuration de build, pas par un commentaire de fichier ni par l’identité humaine/IA de l’auteur.

**D-07 — Deux choses distinctes.** P0 permet de définir des styles avec tokens autorisés et de consommer des recipes. Cela ne décide pas que toutes les futures pages auront le droit de créer des styles. La règle « pages en composition uniquement » reste une politique produit ouverte ; elle n’est ni imposée ni abandonnée dans cette version. Un profil de conformité stricte est fourni pour éprouver le moteur, pas pour définir le design de tous les projets.

**ARC-13 — Couverture.** Le build doit contrôler les racines déclarées et la fermeture de leurs imports locaux pertinents, y compris les réexports et fichiers n’important que des exports générés. Un filtre textuel cherchant uniquement `@stylexjs/stylex` est insuffisant. Chaque fichier appartient au rapport de couverture avec son rôle, son digest et son résultat.

Dans le profil de conformité : imports directs StyleX/Panda et sous-chemins privés, déclarations locales de tokens côté consommateur, objets `style` manuels, CSS local non autorisé et classes de styling non issues des exports autorisés sont refusés par les contrôles de build. Un spread JSX dont l’absence de `style`/`className` ne peut pas être établie statiquement est refusé ou doit passer par un helper validé ; il n’est pas déclaré sûr par défaut.

Le scanner ne prétend pas détecter tout `eval`, manipulation DOM, feuille distante ou dépendance opaque. Ces canaux sont exclus du profil de conformité fermé, ou explicitement classés hors garantie. Une bibliothèque externe approuvée n’est pas rétroactivement certifiée PandamStyle. [B-GUARDS] [A-TESTS] [SX-11]

### 8.1 Valeurs dynamiques et exceptions

**D-08 — Sous-ensemble P0 proposé.** Sélection dynamique de variantes et de thèmes : oui. Valeurs CSS libres venant des props, coordonnées de pointeur ou fonctions de style : non dans le profil de conformité initial. Une expression statiquement non prouvée autorisée est rejetée, même si le moteur sait techniquement l’émettre via une variable CSS.

Les exceptions réellement dynamiques demandées dans le cheminement restent un contrat à étendre, pas une API générique `unsafe` livrée sans contrôle. Aucun `as any` ou champ `trusted: true` ne vaut autorisation. Une future exception devra être limitée, repérable et rapportée. Le bundle rend le motif optionnel ; cette version ne transforme pas cela en obligation universelle. [B-GUARDS] [A-API]

Les mots-clés structurels et quelques valeurs structurelles admises par le profil P0 ne sont pas des exceptions universelles : leur couple propriété/valeur est enregistré et vérifié.

## 9. Génération, incrémentalité et serveur/client

**ARC-14 — Unité de génération.** CSS, JS généré, types, manifeste et rapport doivent référencer une génération compatible avec le même registre. Un nouvel artefact ne doit pas être présenté comme complet si un autre a échoué. Une génération échouée ne remplace pas la dernière génération valide, mais le build courant retourne un échec et ne peut publier celle-ci comme son résultat courant.

En mode développement, les derniers fichiers valides peuvent rester affichés avec l’erreur du build ; ce comportement n’est pas un PASS. La suppression d’un token ou le resserrement d’une politique invalident les consommateurs même lorsque leur texte n’a pas changé.

**D-09 — Proposition :** commencer par une invalidation globale sur changement de registre. L’invalidation fine est une optimisation ultérieure. Les caches restent isolés par projet, système, digest, environnement et options ; pas de réemploi transversal du store global de l’unplugin sans espace de noms approprié. [SX-11]

**ARC-15 — Parité serveur/client.** Pour un même registre et la même cible CSS, les identités de classes/variables doivent être cohérentes entre les constructions serveur et client, indépendamment des chemins absolus. Les choix de thèmes et variantes initiaux doivent produire le même résultat. Les fixtures vérifieront CSS présent au premier rendu, hydratation sans divergence et changement de thème sans nouvelle compilation CSS dans le navigateur.

Le contrat n’affirme pas un support P0 de tous les SSR/RSC/frameworks : une intégration pilote est définie dans le périmètre. [A-P0]

## 10. Contrats machine

**ARC-16 — Diagnostics.** Chaque erreur comporte au minimum version de schéma, code stable, sévérité, phase, message, source, règle et contexte utile. Les erreurs de graphe peuvent désigner plusieurs sources. L’origine doit remonter au code auteur ou consommateur, pas seulement au JS généré.

Les candidats proposés doivent être visibles, de bonne catégorie et autorisés dans le rôle. Pour `17px`, une proximité numérique n’est calculée que dans des unités comparables et un contexte de thème défini ; on ne convertit pas arbitrairement `rem`, `%` ou `calc()` en pixels. Sans comparaison fiable, le diagnostic donne les choix admis sans prétendre connaître le plus proche.

**D-10 — Proposition :** P0 ne réalise aucun remplacement de token automatiquement. `autofix` vaut `null`. Une suggestion peut aider l’agent à réparer sans certifier une équivalence visuelle. Les codes non encore publiés pourront être renommés avant gel ; après gel du contrat, leur signification ne doit pas changer dans une version compatible. [B-P0] [A-API]

**ARC-17 — Manifeste.** La projection consommateur contient tokens autorisés, tokens sémantiques, thèmes, conditions, recipes/variantes/défauts, politique effective et capacités supportées. Les références vers des primitives privées sont filtrées ou représentées sans rendre ces primitives sélectionnables. L’agent ne reçoit pas la configuration complète, les chemins absolus ni un dump de variables d’environnement. Le manifeste n’importe pas le serveur MCP Panda. [PV2-02]

P0 annonce explicitement `slots: false`, `compoundVariants: false`, `patterns: false`, `rawDynamicStyles: false`. Une collection absente ne doit pas être interprétée comme une capacité implémentée mais vide.

## 11. Surface de modification et maintenance

**ARC-18 — Traçabilité de chaque portage.** Pour chaque lot, consigner dépôt donneur, commit, chemin, fonctions reprises, helpers transitifs, adaptations, tests et mentions de licence applicables. Les licences racines déjà lues ne dispensent pas d’inventorier les dépendances du package effectivement distribué. Le nom PandamStyle n’est pas ici une vérification de disponibilité npm ou de marque. [A-UPSTREAM]

Les premiers emplacements touchés sont les visiteurs et le `StateManager`, la validation autour de `create`, le raccordement de variables/thèmes, le runtime et l’unplugin. Les fonctions d’aplatissement et de composition doivent rester comparables par tests ; toute divergence volontaire possède son propre test et sa décision, pas un changement silencieux de snapshots. [A-FILES]

Pas de renommage massif des marqueurs internes si cela n’est pas nécessaire à l’isolation. Une marque interne héritée n’implique pas que le produit soit un wrapper ; en revanche, les imports d’application, exports, chemins générés et dépendances publiées doivent être cohérents avec PandamStyle.

## 12. Expériences bloquantes avant validation du socle

Le P0 ne sera pas accepté sans preuves exécutées sur : conservation de la composition normalisée ; traduction des conditions ; résolution inter-fichiers ; invalidation du registre ; parité serveur/client ; poids des types et des sorties. Les hypothèses et les critères de clôture figurent dans [les décisions](04-DECISIONS.md). Le livrable actuel fixe ce qu’il faudra vérifier ; il ne remplace aucune de ces expériences.

---

[U-01]: ../SOURCES.md#u-01
[A-ARCH]: ../evidence/audit/analysis/ARCHITECTURE.md
[SX-03]: ../SOURCES.md#sx-03
[SX-06]: ../SOURCES.md#sx-06
[PD-05]: ../SOURCES.md#pd-05
[A-API]: ../evidence/audit/analysis/API_PROPOSAL.md
[U-02]: ../SOURCES.md#u-02
[A-RISKS]: ../evidence/audit/analysis/RISK_REGISTER.md
[A-FILES]: ../evidence/audit/analysis/FILE_CHANGE_PLAN.md
[A-UPSTREAM]: ../evidence/audit/analysis/UPSTREAM_COMPATIBILITY.md
[SX-01]: ../SOURCES.md#sx-01
[SX-11]: ../SOURCES.md#sx-11
[PD-03]: ../SOURCES.md#pd-03
[SX-05]: ../SOURCES.md#sx-05
[SX-08]: ../SOURCES.md#sx-08
[SX-02]: ../SOURCES.md#sx-02
[PD-02]: ../SOURCES.md#pd-02
[SX-09]: ../SOURCES.md#sx-09
[SX-10]: ../SOURCES.md#sx-10
[PD-04]: ../SOURCES.md#pd-04
[SX-13]: ../SOURCES.md#sx-13
[SX-07]: ../SOURCES.md#sx-07
[PD-11]: ../SOURCES.md#pd-11
[PD-06]: ../SOURCES.md#pd-06
[B-PHASES]: ../evidence/original-brief/05_P1_P2_ROADMAP.md
[B-GUARDS]: ../evidence/original-brief/06_AGENT_GUARDRAILS.md
[A-TESTS]: ../evidence/audit/analysis/TEST_PLAN.md
[A-P0]: ../evidence/audit/analysis/P0_IMPLEMENTATION_PLAN.md
[B-P0]: ../evidence/original-brief/04_P0_SPEC.md
[PV2-02]: ../SOURCES.md#pv2-02
