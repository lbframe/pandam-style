# Plan d’implémentation agentic-optimizations

Statut : plan d’implémentation ; la revue indépendante est consignée séparément.
Base inspectée : `main`, commit `f3e88039`.

## Objectif et définition de terminé

Pandam Style est destiné exclusivement aux agents IA. Chaque API, interface,
dépendance et document distribué doit répondre à un besoin identifié de ces
agents. Le design system définit le vocabulaire ; le compilateur fait respecter
les contraintes ; les agents composent les interfaces et font évoluer le système
dans les limites des autorisations de leur tâche.

Le chantier couvre la boucle : découvrir le projet, comprendre le vocabulaire,
composer, vérifier, réparer, demander ou produire une extension, publier et
vérifier le résultat. Il couvre aussi installation, audit, migration, mesure,
reprise de session et modifications concurrentes.

La couverture complète signifie que chaque étape de ces parcours possède une
opération machine, un résultat vérifiable et une issue explicite en cas d’échec.
L’efficacité des LLM est mesurée sur un corpus versionné ; aucun pourcentage
universel de réussite ou d’optimalité n’est déduit de cette couverture.

Conditions de livraison obligatoires :

- tous les parcours et critères de ce plan sont couverts par une matrice de preuves ;
- toutes les erreurs attendues sont structurées, y compris avant ouverture de session ;
- les contraintes, révisions et autorisations restent imposées par le service ;
- les tâches de composition réussies satisfont les vérifications de résultat ;
- les objectifs d’efficacité gelés en AG-00 sont satisfaits ;
- AG-13 est clôturé : aucune surface réservée à l’usage humain ne reste distribuée ;
- les consommateurs et hôtes annoncés ont été qualifiés avec les tarballs de livraison.

## Architecture et invariants

Les nouvelles opérations s’appuient sur le [Project Service](../../packages/compiler/src/api/project.js)
et le [snapshot canonique](../../packages/compiler/src/design-system/registry/snapshot.js).
Les transports ne redéfinissent ni validation, ni visibilité, ni publication.

- Une autorité de compilation et de publication par projet. Les transports se
  connectent à la session existante lorsque l’hôte la possède déjà.
- Chaque résultat dépendant du projet est lié à une révision et au design system.
  Avant découverte, les identités indisponibles restent explicitement absentes.
- Une consultation n’écrit ni les sources ni les sorties générées. La découverte
  initiale inspecte statiquement les configurations ; elle distingue ce qui est
  observé de ce qui exige le chargement de la configuration par l’hôte.
- Le compilateur reste l’autorité même lorsque les types ou le LLM acceptent une expression.
- L’agent ne peut pas augmenter ses droits en déclarant un rôle dans sa requête.
  L’hôte fournit les capacités ; leur contrôle s’applique aux opérations exposées.
  Cette frontière ne prétend pas remplacer l’isolation du système de fichiers de l’hôte.
- Le runtime applicatif conserve uniquement la composition de références précompilées.
  Les transports, moteurs de recherche et outils d’évaluation restent hors de `core`.
- Descriptions et exemples du projet sont des données, jamais des instructions
  autorisant une action ou un changement de capacités.
- Une capacité absente est distinguée d’une erreur de l’agent et d’un état périmé.
- La compatibilité navigateur est attachée aux capacités et au CSS effectivement
  généré. Les informations inconnues sont présentées comme inconnues.

## AG-00 — Évaluation de référence et seuils de qualification

Créer `benchmarks/agentic/` avec un corpus de tâches, un runner, les configurations
d’exécution et des résultats bruts. Exécuter une référence sur la version initiale
avant de modifier son comportement. Toute instrumentation nécessaire est isolée
et décrite pour conserver la comparabilité.

Le corpus couvre découverte, composition, états, thèmes, slots, variants,
réparation, changement de design system, audit, installation, migration,
reprise et concurrence. Il comprend aussi des demandes ambiguës, impossibles
avec les capacités présentes et des tentatives de contournement des contraintes.

Chaque cas définit ses entrées, l’intention attendue, les fichiers modifiables,
les capacités nécessaires et des vérifications indépendantes. Séparer les tâches
exprimables, les lacunes produit et les lacunes du vocabulaire du projet.
Prévoir des projets variés et un ensemble réservé à l’évaluation finale.

Mesurer réussite par tâche et modèle, réussite au premier essai, cycles de
réparation, appels d’outils, tokens entrants et sortants, coût, durée, fidélité
visuelle, respect du vocabulaire et violations de périmètre. Séparer coût du
compilateur, coût des outils et coût de l’agent. Les jetons et coûts non fournis
par un fournisseur restent inconnus ; une estimation est identifiée comme telle.

Après la référence et avant les changements produit, enregistrer les seuils de
réussite et de non-régression, budgets, nombre de répétitions, modèles exacts,
paramètres et méthode statistique. Les seuils comprennent les tâches critiques,
le coût du contexte, les réparations et les latences p50/p95. Aucune modification
rétrospective des seuils ne peut faire passer une livraison ; une modification
exige une justification versionnée et une nouvelle référence comparable.

Critères de sortie : référence reproductible, seuils gelés, tâches réservées
séparées et aucune assimilation de « compile » à « tâche réussie ».

## AG-01 — Contrats des opérations d’agent

Créer une couche `packages/compiler/src/agent/` adossée au service existant.
Définir un registre d’opérations avec entrées, sorties, préconditions, capacités,
effets, annulation, erreurs attendues et règles de reprise. Produire depuis la
même définition les schémas de validation, types et descriptions d’outils.

L’enveloppe contient version de protocole, opération, identifiant de requête,
identités disponibles, résultat, diagnostics, références et pagination. Distinguer
réussite, entrée invalide, contrainte violée, capacité absente, accès refusé,
révision périmée, annulation et panne interne. Séparer complétude de validation
et troncature de présentation.

Définir des formats de réponses compacts et détaillés, des erreurs de bootstrap
structurées, des limites de charge et une négociation explicite des capacités.
Les commandes et outils disponibles sont interrogeables avec leurs schémas.

Inventorier également les effets des API existantes. `requestFullAudit()` exige
actuellement une révision valide et programme ou écrit un document : son
adaptateur ne peut pas être présenté comme une consultation. Définir trois
opérations distinctes : lire un audit existant en vérifiant son identité,
calculer un audit en mémoire sans modifier la génération, et matérialiser un
audit avec une capacité de mutation et un reçu. Le calcul en mémoire est aussi
disponible sur une révision invalide, avec diagnostics, couverture connue et
limites explicites ; il ne demande pas une compilation réussie préalable.

Critères de sortie : contrats testés, erreurs attendues toujours structurées,
aucune divergence sémantique entre transports pour une révision donnée. Les
consultations d’audit ne changent ni révision, ni ticket, ni intention de
publication ; la matérialisation a un effet déclaré et qualifié séparément.

## AG-13 — Suppression des surfaces réservées à l’usage humain

Ce lot est obligatoire. Son inventaire commence après AG-01 et avant la
conception finale des transports. Les suppressions sont intégrées aux lots qui
fournissent les remplacements utiles aux agents ; le lot clôture avant livraison.

Établir un inventaire traçable des surfaces publiques et distribuées : code,
exports, commandes, options, clients de développement, dépendances, artefacts,
documentation et parcours. Pour chaque entrée, enregistrer un besoin d’agent
identifié et sa preuve, ou programmer sa suppression.

Supprimer au minimum les surfaces existantes suivantes :

- l’overlay visuel de diagnostics et son DOM, ses styles, ses événements et ses
  dépendances lorsqu’ils servent uniquement cet affichage ;
- les sorties de présentation terminal et le mélange texte/ligne `PMS_JSON:` ;
- les erreurs attendues exposées exclusivement comme prose ou stack trace ;
- les exports de formatage réservés à la présentation humaine et leurs options ;
- les instructions d’utilisation manuelle remplacées par les parcours d’agent.

L’inventaire recherche aussi les assistants interactifs, interfaces de
configuration, décorations de logs, options, tests, snapshots et dépendances
sans usage d’agent ; leur existence doit être constatée avant d’annoncer une
suppression. La recherche couvre tous les hôtes, pas seulement Vite.

Les textes nécessaires à un LLM restent des champs structurés : explication,
raison, alternatives et exemples. Types, source maps, noms lisibles, navigateur
de vérification et HMR sont évalués par leur utilité pour les agents. Leur
conservation doit être justifiée dans l’inventaire.

Un remplacement fournit d’abord le contrat machine équivalent, puis supprime
l’ancienne surface dans la version de rupture documentée. Aucun mode `human`,
ancienne voie d’affichage ou dépendance morte ne reste dans les tarballs finaux.
L’historique Git conserve la traçabilité des suppressions.

Critères de sortie : inventaire complet, chaque conservation justifiée par un
parcours d’agent, suppressions vérifiées dans sources et tarballs, remplacements
qualifiés, documentation et migration cohérentes. AG-12 échoue si ce lot reste ouvert.

## AG-02 — SDK, CLI et outils appelables

Exposer le SDK d’agent par un sous-chemin du compilateur et ajouter un package
`@pandamstyle/agent` pour la CLI et l’adaptateur MCP. Leur implémentation utilise
exclusivement les opérations AG-01. Épingler les contrats des transports et
qualifier les modes réellement livrés.

**Accès au propriétaire, préalable aux transports.** Ajouter dans
`packages/compiler/src/api/` un bridge des opérations d’agent appartenant au
processus qui possède déjà la session. Le socket de `output-lease.js` reste
réservé à l’exclusion des écrivains ; il ne transporte pas d’opérations.
Le bridge sérialise les requêtes vers cette même session et vérifie identité,
révision et capacités avant de les exécuter.

Le propriétaire publie un descripteur de connexion dans un emplacement de
cache non surveillé, distinct des artefacts canoniques. Le descripteur identifie
projet, session, endpoint local et version de protocole ; il ne constitue pas
une preuve d’identité suffisante. Prévoir handshake authentifié, contrôle d’accès
local, protection contre les descripteurs périmés, limites de requêtes et
nettoyage à la fermeture. Le client ne peut pas déclarer ses propres capacités.

Étendre explicitement chaque hôte annoncé : Vite et Rsbuild enregistrent leur
session privée auprès du bridge pendant leur cycle de vie. Les deux voies Next
exigent des travaux distincts :

- Next webpack, lancé directement avec `next dev --webpack` ou
  `next build --webpack`, enregistre le propriétaire créé dans `src/index.js`
  et initialisé dans `src/state.js` auprès du bridge commun. Définir le démarrage
  différé du bridge après initialisation, son partage entre compilations client
  et serveur, puis sa fermeture avec le propriétaire. Cette voie n’utilise pas
  le supervisor Turbopack ni sa CLI.
- Next Turbopack étend le protocole authentifié du supervisor et son propriétaire
  avec les opérations d’agent. Conserver les frontières entre semantic-dev et
  production strict lors de l’accès aux révisions et de la publication.

Les clients SDK, CLI et MCP se connectent à ces points de connexion.
L’ouverture, le redémarrage et la fermeture des hôtes invalident les attaches
et contextes concernés ; la reconnexion vérifie la nouvelle identité.

Distinguer mode attaché et mode autonome. Un propriétaire autonome est ouvert
par une opération explicite, acquiert le lease et charge la configuration selon
les capacités de la tâche. Une requête de découverte n’ouvre pas silencieusement
un compilateur. Sans propriétaire, les lectures d’artefacts indiquent leur
fraîcheur observable ; une opération exigeant l’état vivant retourne
`owner-required`. Un échec d’attachement ne crée jamais un second propriétaire.

Surface proposée, à figer dans AG-01 :

| Opération | Résultat |
| --- | --- |
| `discover` | Configuration observée, versions, hôte, roots et capacités |
| `query` | Recherche ciblée dans le vocabulaire |
| `describe` | Contrat d’une entité ou d’une opération |
| `context` | Contexte utile à une tâche et références complémentaires |
| `check` | Validation sans publication |
| `repair` | Proposition, vérification ou application locale |
| `extend` | Demande ou proposition d’extension du design system |
| `impact` | Usages et conséquences d’une modification |
| `publish` | Publication d’un candidat validé |

Définir aussi les opérations de session et de suivi nécessaires aux parcours
installation, audit, migration et mesure. Ces parcours orchestrent les contrats
existants ; leurs effets autorisés sont déclarés et vérifiables.

Les réponses sont machine par défaut et identiques pour succès et échec.
Les logs techniques, bornés et expurgés des secrets, sont séparés du canal de
réponse. Les outils annoncent leurs effets et exigent des capacités explicites
pour les mutations. Un appel de lecture ne charge pas silencieusement du code
de configuration arbitraire hors de la session autorisée.

Critères de sortie : un agent peut découvrir, interroger et vérifier un projet
sans écrire une intégration ; tests de parité SDK/CLI/MCP. Qualifier, pour
chaque hôte, accès au même propriétaire, concurrence avec les requêtes de build,
contrôle d’accès, absence du propriétaire, descripteur périmé et reconnexion.

La qualification d’attachement distingue obligatoirement les cellules suivantes :

| Hôte et mode | Propriétaire à exposer |
| --- | --- |
| Vite, développement et production | Session du plugin, avec fermeture après build |
| Rsbuild, développement et production | Session du plugin et cycle des compilations |
| Next webpack, développement et production | Propriétaire `index.js` / `state.js`, partagé client/serveur |
| Next Turbopack, développement semantic-dev | Propriétaire du supervisor en mode semantic-dev |
| Next Turbopack, production strict | Propriétaire du supervisor en mode strict |

Tester chaque mode séparément. Pour un build terminé, la disparition attendue
du propriétaire et les seules lectures d’artefacts sont distinguées d’une perte
de connexion inattendue ; aucun client ne démarre silencieusement un build.

## AG-03 — Métadonnées sémantiques du vocabulaire

Étendre le registre, les validateurs de définitions et les projections avec rôle
sémantique, description concise, usages, restrictions, relations, mots-clés,
exemples, dépréciation et remplacement. Couvrir tokens, recettes, slots, variants,
patterns, conditions, thèmes et références aux composants applicatifs existants.

Distinguer règles imposées et descriptions indicatives. Préserver visibilité,
origine et identité. Vérifier les références d’exemples et de remplacement,
détecter les cycles et ne pas exposer les valeurs privées aux consommateurs.
L’absence de métadonnées reste explicite ; elle ne produit pas une sémantique inventée.

Séparer empreinte des métadonnées de découverte et empreinte des données qui
affectent la compilation. Définir les invalidations des résultats, index, types
et références de contexte ; une modification purement descriptive n’a pas à
recalculer le CSS si son indépendance est établie.

Critères de sortie : métadonnées conservées et interrogeables, exemples vérifiés,
visibilité respectée et invalidations cohérentes avec les empreintes.

## AG-04 — Recherche ciblée et explicable

Étendre les domaines canoniques existants au-delà de `candidateTokens`.
Rechercher et filtrer par propriété, catégorie, type d’entité, recette, variant,
slot, condition, thème, rôle déclaré, dépréciation et usages du projet.

Commencer par filtres exacts, index lexical et relations déclarées. Retourner
la raison de correspondance et distinguer faits déclarés, usages observés et
suggestions. Une extension sémantique sera évaluée séparément si ces mécanismes
ne satisfont pas le corpus ; elle ne devient pas une dépendance du compilateur.

Garantir ordre stable, limites, totaux, pagination liée à la révision et exclusion
des entités privées. Une suggestion ne donne aucun droit supplémentaire et
reste soumise aux contraintes de propriété et de rôle.

Critères de sortie : pertinence mesurée sur requêtes réservées, candidats
compatibles, résultats reproductibles et absence de fuite d’entités privées.

## AG-05 — Contexte ciblé et mises à jour différentielles

Construire le contexte depuis fichier, région, diagnostic, entités et objectif
de tâche. Fournir import résolu, contrats pertinents, exemples compilables,
conventions observées, règles de composition, capacités, limites et étapes de
vérification. Ne pas sérialiser systématiquement le projet ou le design system.

Prévoir résumé, contrat ciblé, exemples puis détails à la demande. Les budgets
en octets et éléments sont exacts ; une estimation en tokens identifie son
tokenizer et sa version. Si le budget ne contient pas les contraintes
indispensables, retourner une issue explicite avec découpage ou continuation.

Mettre en cache par révision et empreintes. Les deltas indiquent entités ajoutées,
modifiées et supprimées ; ils ne permettent pas de réutiliser silencieusement
un contexte devenu invalide. Les conventions inférées restent distinctes des règles.

Critères de sortie : baisse mesurée du coût de contexte, réussite préservée,
contraintes complètes et invalidation des contextes périmés.

## AG-06 — Diagnostics actionnables et suivi des causes

Compléter le protocole avec cause précise, domaine attendu, alternatives,
préconditions, ambiguïtés et opération suivante. Séparer erreur de composition,
vocabulaire manquant, capacité compilateur manquante, incompatibilité de cible
et état périmé. Corriger les réparations génériques comme `replace-with-token`
lorsqu’un autre mot-clé structurel est attendu.

Ajouter identités de diagnostic et relations entre cause et conséquences pour
éviter les réparations répétées. Les rapprochements entre révisions doivent
rester conservateurs si la source a changé. Paginer les détails longs et rendre
la totalité des diagnostics accessible sans faire dépendre le verdict d’une troncature.

Critères de sortie : contrat pour chaque code public, candidats compatibles,
réparations ambiguës identifiées et aucune erreur masquée par un résultat compact.

## AG-07 — Réparations proposées, vérifiées et applicables

**AG-07.1 — Candidats isolés dans l’autorité du compilateur.** Implémenter
avant le moteur de réparation une nouvelle primitive de candidat dans le
Project Service. `sourceOverlays` sur la session active n’est pas cette
primitive : `applyChanges()` change la révision et révoque les tickets.
Les snapshots d’artefacts acceptés ne sont pas des candidats modifiables.

Le propriétaire capture une vue immuable des entrées de la révision de base :
sources et dépendances lues avec empreintes, configuration normalisée, définition
validée et identités du compilateur. Le candidat applique les changements à
cette vue dans un worker isolé utilisant les mêmes règles de validation et de
compilation, un fournisseur de sources immuables et une sortie en mémoire.
La configuration n’est pas réexécutée dans le worker ; les références internes
sont reconstruites par le compilateur depuis les données normalisées autorisées.

Le worker n’acquiert pas le lease de l’application et ne crée pas une deuxième
session publiant vers son output. Les identités logiques de source sont
préservées pour les diagnostics et imports. Les lectures non capturées rendent
le candidat incomplet ; elles ne sont pas remplacées par une lecture flottante
de fichiers en cours de modification.

Définir création, vérification, lecture de résultat, annulation et destruction
du candidat. Chaque résultat inclut identité du candidat, révision de base et
empreinte de ses changements. Si la base ou une dépendance a changé, l’application
du candidat retourne un conflit et exige une nouvelle vérification.

Critères de passage à AG-07.2 : une simulation réussie, échouée ou annulée
préserve la révision active, sa validation, les tickets, les artefacts, l’état
observable des audits et les notifications des watchers. Tester aussi les
changements de définition, dépendances modifiées et candidats périmés.

**AG-07.2 — Propositions et application.**
Construire des opérations AST localisées pour imports, tokens, noms de condition,
variants, slots et valeurs structurelles. Ajouter la réutilisation d’une primitive
existante uniquement lorsque l’équivalence peut être démontrée.

Chaque proposition indique régions, empreintes de source, révision de départ,
préconditions, justification et conséquences. Séparer proposition, simulation,
application et publication. La simulation emploie des sources isolées et ne
publie pas de génération, ne déclenche pas les watchers de l’application et
ne remplace pas la session valide.

Réutiliser les transactions existantes pour la publication des artefacts.
Pour les sources, définir verrouillage, contrôles de contenu, journal et reprise
adaptés aux éditions de plusieurs fichiers. Ne pas promettre une atomicité
globale du système de fichiers. Refuser les sources modifiées depuis la proposition.

Des alternatives nécessitant une décision visuelle restent explicites. La validité
CSS et le caractère local d’un patch ne prouvent pas sa fidélité à l’intention.

Critères de sortie : patches bornés, validation avant publication, idempotence,
conflits détectés et préservation des changements concurrents.

## AG-08 — Extension du design system entre agents

Définir une demande structurée avec intention, concept manquant, usages concernés,
alternatives examinées, type de lacune, proposition et vérifications attendues.
Un agent autorisé peut la transformer en modification du design system.

Les droits sont fournis par l’hôte et vérifiés lors de proposition, application
et publication. Une sélection de rôle dans la requête ne change pas les droits.
Une demande consommateur ne peut pas élargir sa propre politique.

Une extension validée produit un delta de vocabulaire et un résultat traçable
pour l’agent demandeur. Une demande incompatible ou ambiguë conserve son statut
et ses raisons sans créer de token arbitraire pour faire disparaître l’erreur.

Critères de sortie : tests de séparation des capacités, validation des extensions
et boucle demande/proposition/publication/delta exploitable.

## AG-09 — Usages, impacts et preuves de résultat

Exposer les usages, dépendances, provenance, régions affectées et explications
de composition depuis les faits du compilateur. Un impact inconnu ou incomplet
reste identifié ; les changements d’une définition partagée indiquent leur portée.

Définir un format de preuves pour compilation, typecheck, DOM, accessibilité,
captures et comparaison visuelle. Les adaptateurs exécutent seulement des
vérifications déclarées par le projet et autorisées pour la tâche. Décrire leurs
entrées, sorties, codes de fin et limites ; les commandes ne sont pas inventées.

Lier les preuves aux sources, génération, environnement et versions. Distinguer
compilé, rendu vérifié, comportement vérifié et non mesuré. Les navigateurs de
validation servent aux agents ; leur présence est justifiée dans AG-13.

Critères de sortie : impacts traçables, preuves périmées rejetées et réussite
applicative distincte du seul succès du compilateur.

## AG-10 — Sessions longues, concurrence et reprise

Compléter le cycle de session avec reconnexion, annulation, expiration,
idempotence, détection de contexte périmé et gestion des conflits. Identifier
propriétaire, candidat validé, dernière génération publiée et révision en erreur.

Conserver des caches et historiques bornés. Définir les reprises après panne
pour les mutations de source et la publication. Les détails de session ne
doivent pas faire augmenter le résultat compact avec la taille du projet.

Critères de sortie : interruptions et rejeux qualifiés, aucune double publication,
préservation de la génération valide, conflits explicites et mémoire bornée.

## AG-11 — Parcours et documentation exclusivement pour agents

Mettre à jour le skill et les contrats à partir des opérations effectivement
livrées. Chaque parcours indique entrée, capacités, opérations, conditions de
réussite et issues d’échec. Couvrir usage, réparation, installation, audit,
migration, extension et mesure avec les mêmes schémas.

Générer les références d’opérations depuis les contrats ; vérifier exemples,
commandes et liens. Charger les instructions selon l’intention, puis les détails
à la demande. La documentation conserve des explications utiles au LLM et évite
les règles dupliquées ou contradictoires.

Appliquer AG-13 à tous les guides et points d’entrée distribués. Ne pas créer
de nouvelle interface interactive ou voie de présentation destinée aux humains.

Critères de sortie : parcours exécutés par des agents indépendants à partir des
seules ressources publiées, sans commande fictive ni lecture intégrale obligatoire.

## AG-12 — Qualification et livraison

Rejouer le corpus avec plusieurs modèles, versions, budgets et paramètres
identifiés. Séparer tâches de développement et tâches réservées. Comparer aux
références et isoler les effets de recherche, contexte et réparation. Rapporter
les échecs et la dispersion, pas seulement une moyenne de réussite.

Les tests de contrats et de déterminisme entrent en CI courante. Les évaluations
LLM disposent de commandes reproductibles, budgets explicites et résultats bruts.
Les exécutions exigeant des fournisseurs externes restent distinctes des tests locaux.

Qualifier SDK, CLI et MCP, les hôtes annoncés, la CSP et les consommateurs
existants. Utiliser les tarballs destinés à la publication, contrôler leurs
exports, dépendances, fichiers et installation propre. La matrice décrit tous
les lots et tous les parcours ; AG-13 fait partie des critères bloquants.

Publier changelog, changements de protocole et migration. Les versions des
packages concernés sont cohérentes et les dépendances internes exactes. Les
versions des protocoles et de l’ABI évoluent seulement selon leurs changements
réels ; toute rupture de sens ou de forme est explicitée.

Critères de sortie : exigences de ce plan satisfaites, objectifs AG-00 atteints,
aucun constat bloquant de revue ouvert et preuves attachées à la livraison.

## Emplacements et dépendances

| Zone | Responsabilité |
| --- | --- |
| `packages/compiler/src/agent/` | Opérations, découverte, contexte, impact et réparation |
| `packages/compiler/src/protocol/` | Schémas et normalisation des résultats |
| `packages/compiler/src/design-system/` | Métadonnées et domaines canoniques |
| `packages/compiler/src/api/` | Exposition et cycle de session |
| `packages/compiler/src/project/` | Candidats isolés et vues immuables de validation |
| `packages/compiler/src/artifacts/` | Projections et déclarations générées |
| `packages/vite/src/`, `packages/rsbuild/src/` | Accès aux sessions possédées par les hôtes |
| `packages/next/src/` | Bridge du propriétaire webpack et opérations du supervisor Turbopack |
| `packages/agent/` | CLI et adaptateur MCP |
| `tests/agentic/` | Conformité et scénarios déterministes |
| `benchmarks/agentic/` | Corpus et évaluations LLM |
| `.agents/skills/pandamstyle/`, `docs/agent-*` | Parcours d’agent et références |

Les nouveaux chemins sont proposés. Les modules existants gardent l’autorité
qu’ils portent ; ces répertoires n’autorisent pas une duplication du service.

| Séquence | Lots et dépendances | Condition de passage |
| --- | --- | --- |
| Référence | AG-00 | Référence et seuils gelés avant changements produit |
| Contrats | AG-01 | Contrats machine et autorité établis |
| Inventaire prioritaire | Début AG-13 après AG-01 | Inventaire avant finalisation des transports |
| Accès et vocabulaire | Bridge propriétaire AG-02 après AG-01 ; transports AG-02 après bridge ; AG-03 après AG-01 | Attachement qualifié par hôte et métadonnées validées |
| Découverte | AG-04 après AG-03 ; AG-05 après AG-04 | Recherche et contexte évalués |
| Réparation | AG-06 après AG-01/03 ; AG-07.1 après AG-01/03 ; AG-07.2 après AG-06/07.1 | Candidats isolés qualifiés avant vérification de patches |
| Extension et preuves | AG-08 après AG-03/07 ; AG-09 après AG-03/06 | Droits et preuves qualifiés |
| Robustesse | AG-10 accompagne AG-02/07/08 | Reprises et concurrence testées à chaque étape |
| Parcours | AG-11 après disponibilité des opérations | Parcours indépendants exécutables |
| Suppression complète | Clôture AG-13 après AG-02/11 | Suppressions et migrations vérifiées |
| Convergence | AG-12 après clôture de tous les autres lots | Livraison qualifiée |

Les lots peuvent avancer en parallèle lorsque leurs contrats et responsabilités
sont distincts. Une revue indépendante porte sur chaque lot significatif et
sur le candidat final ; les corrections invalident le verdict précédent sur
l’artefact modifié et nécessitent une nouvelle revue.

## Interfaces avec la couverture CSS et navigateur

Le catalogue des propriétés, la politique et la qualification navigateur sont
interrogés via un contrat de capacités commun. Les besoins d’agent identifiés
alimentent cette couverture ; une lacune ne devient pas un contournement.

Les capacités upstream utilisées pour ce travail sont étudiées depuis les
dernières versions publiées au moment de la qualification, avec versions et
sources épinglées. L’existence d’une option dans un upstream ne suffit pas
à annoncer une capacité dans Pandam Style.

Les évaluations distinguent réussite sur capacités présentes, diagnostic d’une
lacune et fidélité globale de la tâche. Diagnostiquer correctement une capacité
manquante ne compte pas comme interface applicative livrée.
