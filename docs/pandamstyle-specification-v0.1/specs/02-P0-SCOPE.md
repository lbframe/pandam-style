# 02 — Périmètre P0 et plan d’implémentation

**Version 0.1 · DRAFT · 2026-09-28**  
P0 = preuve du socle. Ni bibliothèque complète, ni lancement public implicite.

## 1. Résultat attendu

Un projet pilote installe les packages construits de PandamStyle, définit son design system et compile une page composée d’une recipe et de styles conformes. Deux thèmes utilisent les mêmes tokens sémantiques. Les erreurs de style survivent à la désactivation de TypeScript et font échouer le build avec des diagnostics exploitables.

Ce résultat reprend le plan de l’audit ; les restrictions précises ci-dessous sont proposées dans cette version, pas déduites automatiquement des capacités upstream. [A-P0] [B-P0]

## 2. Exigences de sortie

| ID | Capacité P0 obligatoire | Limite explicite |
|---|---|---|
| P0-01 | Registre de tokens primitifs/sémantiques, catégories, visibilité et références. | Valeurs de tokens CSS simples ; pas de modèle complet de tokens composites Panda. |
| P0-02 | Validation des catégories strictes au compilateur. | Table versionnée de propriétés supportées ; toute propriété non couverte échoue dans le profil fermé. |
| P0-03 | Thème de base et thèmes nommés, surcharges et portée imbriquée. | Pas de produit cartésien implicite multi-marque × modes ; deux thèmes suffisent à la conformité initiale. |
| P0-04 | Conditions nommées et compilation sans perte de sens. | Familles et combinaisons de la section 4 seulement. |
| P0-05 | Recipe simple : base, axes, défauts, types, branches compilées et sélection runtime bornée. | Ni slots, ni compounds, ni valeur d’axe responsive. |
| P0-06 | Types TypeScript dérivés des définitions. | Pas de génération de toutes les unions cartésiennes possibles. |
| P0-07 | Diagnostics structurés et suggestions de tokens pertinentes. | Pas d’autofix de design automatique. |
| P0-08 | Manifeste consommateur minimal cohérent. | Ni serveur MCP complet, ni catalogue de composants, ni codemods. |
| P0-09 | Contrôle des imports et de couverture du build. | Profil fermé documenté ; pas de certification de scripts/CSS externes opaques. |
| P0-10 | Invalidation du registre et génération cohérente. | Invalidation globale admise au départ ; optimisation fine non requise. |
| P0-11 | Une intégration pilote, extraction CSS et rendu serveur/client. | Une seule pile verrouillée, pas compatibilité universelle. |
| P0-12 | Packages installables localement, provenance du portage et rapport de preuves. | Publication npm et disponibilité du nom hors de cette livraison. |

**D-11 — Clarification des phases.** Le manifeste minimal est avancé en P0, comme dans la proposition de l’audit, parce que les tests initiaux l’attendent déjà. Les politiques de base par catégorie sont également P0 ; les politiques fines et catalogues de composition restent P1/P2. Ces résolutions sont explicites, et les documents historiques restent inchangés. [A-DECISION] [B-TESTS] [B-PHASES] [B-MANIFEST]

## 3. Politique de conformité proposée

### 3.1 Noyau par catégorie

Le profil `conformance-strict` active couleurs, espacements, rayons, typographie, ombres et mouvement ; les breakpoints passent par le registre de conditions. Il s’applique en JavaScript comme en TypeScript.

**D-12 — Sous-ensemble de propriétés.** Le P0 n’annonce pas « tout CSS ». Il publie un inventaire exact `supported-properties.json`, issu de la même table que le compilateur et les types. La table suivante fixe le minimum à livrer ; les familles avec « longhands » doivent être développées en noms concrets dans l’implémentation et les tests.

| Catégorie | Surface minimale | Traitement |
|---|---|---|
| Couleurs | `color`, `backgroundColor`, `borderColor` et ses longhands physiques/logiques, `outlineColor`, `textDecorationColor`, `caretColor`, `fill`, `stroke` | Token de couleur autorisé ; mots-clés autorisés uniquement si enregistrés pour la propriété. |
| Espacement | `padding`, `margin`, longhands physiques/logiques, `gap`, `rowGap`, `columnGap` | Token d’espacement ; les raccourcis mono-valeur sont normalisés. |
| Rayons | `borderRadius` et longhands physiques/logiques | Token de rayon. |
| Typographie | `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `letterSpacing` | Catégories de tokens correspondantes, pas une catégorie unique permissive. |
| Ombres | `boxShadow`, `textShadow` | Token de la catégorie appropriée ; `none` seulement si explicitement admis. |
| Mouvement | `transitionDuration`, `transitionDelay`, `transitionTimingFunction`, `animationDuration`, `animationDelay`, `animationTimingFunction` | Tokens de durée ou d’easing selon la propriété. |
| Conditions | Pseudo-états et media queries de la section 4 | Références nommées uniquement côté consommateur. |

Un `fontSize` ne reçoit pas un token `spacing` sous prétexte que les deux aboutissent à `16px`. Une référence sémantique d’une catégorie ne change pas de catégorie par résolution.

Les valeurs multi-parties des raccourcis et les raccourcis composites `background`, `border`, `font`, `animation`, `transition` sont refusés en P0 avec `PMS_UNSUPPORTED_PROPERTY_FORM`, plutôt que partiellement contrôlés. Cela ne doit pas être contournable par `as any`, une propriété calculée ou un alias local. Ajouter ensuite une forme requiert ses tests de décomposition et de politique. [PD-02] [A-TESTS]

Les alias d’ergonomie Panda comme `px` et `bg` ne sont pas nécessaires au P0 ; ils ne doivent pas être acceptés accidentellement sans mapping et validation. Les propriétés CSS standard supportées restent nommées explicitement. Le portage du modèle propriété/catégorie Panda est néanmoins réel, et traçable.

### 3.2 Structure sans micro-design

**D-13 — Profil de test fermé.** Il autorise un petit ensemble déclaré de valeurs structurelles : `display` et `flexDirection` avec domaines finis, alignements avec domaines finis, `boxSizing: border-box`, `width: 100%`, `marginInline: auto`, `opacity` numérique entre 0 et 1 et facteurs flex numériques finis non négatifs. Les nombres sont statiques ; ni chaîne numérique ambiguë ni valeur `NaN`/infinie ne sont admises.

Ce sont des paires propriété/valeur ou domaines définis, pas une règle globale « les nombres sont autorisés ». Ainsi `padding: 0` n’est pas automatiquement une exception à la politique : il utilise un token zéro s’il est requis par le profil. Les mots-clés `inherit`, `unset`, `revert` et les variables CSS libres ne sont pas des voies génériques d’échappement.

Le profil peut se compléter avec d’autres mots-clés pour les propriétés déjà inventoriées, mais aucune nouvelle transformation JavaScript arbitraire n’est nécessaire pour P0. Toute addition apparaît dans le registre, les types et le manifeste, puis subit les mêmes tests.

### 3.3 Définition et consommation

Les valeurs brutes sont légitimes dans les définitions primitives du design system. Elles ne deviennent pas légitimes dans une recipe uniquement parce que son fichier appartient au design system : les déclarations de style des recipes subissent la politique de catégories. Les tokens privés peuvent être utilisés par l’auteur selon la politique ; les consommateurs ne peuvent sélectionner que les tokens publics.

La fixture rend ses couleurs primitives privées et ses couleurs sémantiques publiques. Elle expose des espacements publics. **Ce choix de fixture n’est pas une interdiction universelle des tokens primitifs dans toutes les catégories.** La frontière « pages uniquement recipes/patterns » n’est pas décidée ici. [A-API] [U-02]

## 4. Conditions P0 : matrice de traduction

| Famille | À livrer | Hors du sous-ensemble P0 |
|---|---|---|
| État sur l’élément | Pseudo-classe simple, attribut simple, `:is(...)` restreint aux états sur l’élément | Sélecteurs libres avec ascendants, descendants ou frères. |
| État Panda retenu | `hover` couvrant `:hover` **et** `[data-hover]` ; `disabled` couvrant les alternatives déclarées | Simplifier ces définitions en perdant les attributs data/ARIA. |
| Breakpoint | Une borne `min-width` ou `max-width` en pixels, nommée | Unités mixtes `px`/`em`/`rem`, plages composées, `not`, `or`. |
| Préférence | `prefers-reduced-motion`, `hover: hover`, `prefers-color-scheme` nommés | Assimiler préférence système et thème sélectionné par classe. |
| Combinaison | Au plus une condition media et un état sur l’élément | Imbrication de deux media queries, `@supports`, group/peer, sélecteurs arbitraires. |

**D-14 — Restrictions proposées pour une preuve maîtrisable.** Le compilateur rejette une définition hors matrice ; il ne la transmet pas silencieusement à un second émetteur. Les patterns, sélecteurs complexes et autres unités restent des extensions, même si les moteurs upstream savent traiter certains de ces cas. [PD-10] [SX-04] [SX-13]

À propriété et contexte comparables, les bornes `min-width` sont ordonnées par valeur croissante, les `max-width` par valeur décroissante. Les conflits entre familles de conditions différentes suivent les priorités héritées du moteur pour la forme canonique ; ils sont rendus visibles par les tests, pas déduits de l’ordre des props. Des noms différents pour la même définition canonique ne créent pas deux niveaux de priorité.

La normalisation de toutes les formes d’écriture en blocs conditionnels est celle d’ARC-09. Une condition non supportée ne compte pas comme un test de compatibilité réussi parce qu’aucune règle CSS n’a été produite.

## 5. Exemple de consommation proposé

Les noms d’exports et de modules ci-dessous sont une **notation candidate D-15**, non une API npm existante ou approuvée. Le module `./design.pandamstyle` est une sortie générée pour l’instance du design system, pas une couche logicielle écrite par LB Frame.

```tsx
import { create, token, recipes, themes, props } from './design.pandamstyle'

const styles = create({
  page: {
    backgroundColor: token('colors.surface.primary'),
    color: token('colors.text.primary'),
    padding: {
      base: token('spacing.md'),
      wide: token('spacing.lg'),
    },
  },
})

export function Page({ size = 'md' }: { size?: 'sm' | 'md' }) {
  return (
    <main {...props(themes.light, styles.page)}>
      <button {...props(recipes.button({ variant: 'primary', size }))}>
        Continue
      </button>
    </main>
  )
}
```

Les chemins complets évitent l’ambiguïté entre un token, une chaîne CSS et une catégorie. Les alias courts `md`/`space.md` ne sont pas promis en P0. Le compilateur doit savoir retrouver ce module et ses réexports ; l’exemple ne suppose pas qu’un filtre d’import upstream le reconnaisse déjà.

Pour tester un échec, remplacer `token('spacing.md')` par `'17px'` : cela doit échouer même dans une copie JavaScript non typée. Pour tester l’invalidation, supprimer `spacing.md` du design system sans modifier le fichier de page.

## 6. Jeu de conformité obligatoire

La fixture s’appelle `conformance` ; ses valeurs sont pédagogiques et ne constituent pas un thème livré par défaut aux utilisateurs.

Elle définit au minimum cinq espacements (`xs=4px`, `sm=8px`, `md=16px`, `lg=24px`, `xl=32px`), un token zéro, une échelle de rayons, des primitives de couleurs privées, des couleurs sémantiques publiques, un token d’ombre, les familles typographiques et des durées/easings. Chaque catégorie stricte possède au moins un usage valide et un usage brut interdit.

Elle contient deux thèmes (`light`, `dark`), les conditions `hover`, `disabled`, `wide` et `reducedMotion`, et une recipe `button` avec les axes `variant` et `size`, un ordre d’axes fixé et des valeurs par défaut. Un cas ajoute un axe booléen pour vérifier `false`. Un second jeu crée intentionnellement des conflits entre base/variantes et conditions pour la parité navigateur.

Les fixtures négatives restent séparées du projet positif afin que le build valide ne soit pas obtenu en supprimant ou en excluant les erreurs de sa propre définition. Leur intention est déclarée dans le runner ; chacune doit prouver l’échec attendu.

## 7. Intégration pilote

**D-16 — Proposition : Vite + React avec une fixture SSR Node et hydratation client.** Ce choix permet de tester l’intégration, les chemins serveur/client et l’héritage du mécanisme unplugin. Il ne vaut pas déclaration de compatibilité avec une version actuelle de Vite ou React : les versions exactes et le lockfile sont à fixer et tester au lot 0. Le bundle cite TanStack Start dans la stack cible ; le pilote isolé ne certifie pas encore cette intégration spécifique. [B-CONTEXT] [SX-11]

Le pilote doit installer les packages issus d’un `pack` local, pas uniquement un alias de workspace qui masque des exports manquants. Les usages se font par les exports PandamStyle et le module généré. Le package publié localement doit contenir les types, références et métadonnées nécessaires à la compilation inter-fichiers.

Le CSS de production est extrait et chargé avant le premier rendu. Les helpers de sélection n’injectent pas de nouvelle feuille au changement de variante ou de thème. Le comportement HMR, la suppression d’un token et les erreurs de configuration sont testés séparément.

## 8. Séquence de réalisation proposée

| Lot | Travail | Preuve de sortie |
|---|---|---|
| L0 — Baseline | Checkout épinglé, tests upstream sélectionnés, inventaire de dépendances/licences, versions de l’environnement. | Logs et résultats non modifiés ; échecs préexistants distingués. |
| L1 — Registre | Portage dictionnaire et catégories, graphe, thèmes, empreintes, premiers diagnostics. | Cas positifs et négatifs de références, cycles et catégories. |
| L2 — Compilateur | Provenance, règles de catégories, variables/thèmes, normalisation des conditions. | Rejets indépendants de TS ; CSS différentiel sur le sous-ensemble. |
| L3 — Projections | Types, exports liés au système, manifeste minimal. | Suppression d’un token répercutée partout ; visibilité cohérente. |
| L4 — Recipes | Portage de sélection/defaults, compilation des branches, garde runtime des domaines. | Variantes finies, conflits déterministes, aucune fusion de CSS brut à l’exécution. |
| L5 — Intégration | Imports, couverture, cache, génération, installation locale, SSR/client. | Application pilote complète et mutations incrémentales. |
| L6 — Consolidation | Matrice de conformité, mesures, attributions, rapport d’écarts et hypothèses. | Dossier de preuves permettant de décider si le P0 est conforme. |

Cet ordre modifie l’ordre historique « strict d’abord » pour construire d’abord le registre que le contrôle strict doit consulter. Diagnostics et tests négatifs commencent dès L1, pas à la fin. [A-P0]

La production des fichiers de cette spécification n’a exécuté aucun de ces lots.

## 9. Ce qui reste après P0

**P1 :** slot recipes, compound variants, patterns de layout, politique plus expressive, contraintes d’overrides et contrat borné d’exceptions dynamiques. Les besoins de `Stack`, `Grid`, `Container` et autres primitives restent centraux ; leur report n’est pas un abandon. [B-PHASES] [U-02]

**P2 :** serveur d’introspection/MCP, métadonnées enrichies, dépréciation/versioning éditorial des tokens, codemods et migrations. Le minimum de manifeste en P0 ne signifie pas que ces outils sont déjà fournis.

**Hors promesse :** toutes les API StyleX/Panda, toutes les syntaxes CSS, tous les bundlers, zéro JavaScript runtime, performance équivalente sans mesure, protection contre toute injection CSS, composants visuels LB Frame inclus, compatibilité source intégrale avec Panda.

## 10. Définition de fini

P0 est conforme seulement si les cas obligatoires du document d’acceptation ont des preuves exécutées au même commit et avec une configuration identifiée ; le portage de code est traçable ; les restrictions publiées correspondent au comportement ; les hypothèses bloquantes ont été clôturées ou le statut reste incomplet.

Les mesures de performance sont obligatoires mais aucun seuil numérique universel n’est inventé. La décision de diffusion et le budget acceptable se fondent sur ces mesures. Une collecte absente ne vaut jamais « overhead négligeable ».

---

[A-P0]: ../evidence/audit/analysis/P0_IMPLEMENTATION_PLAN.md
[B-P0]: ../evidence/original-brief/04_P0_SPEC.md
[A-DECISION]: ../evidence/audit/analysis/DECISION.md
[B-TESTS]: ../evidence/original-brief/07_ACCEPTANCE_TESTS.md
[B-PHASES]: ../evidence/original-brief/05_P1_P2_ROADMAP.md
[B-MANIFEST]: ../evidence/original-brief/manifest.json
[PD-02]: ../SOURCES.md#pd-02
[A-TESTS]: ../evidence/audit/analysis/TEST_PLAN.md
[A-API]: ../evidence/audit/analysis/API_PROPOSAL.md
[U-02]: ../SOURCES.md#u-02
[PD-10]: ../SOURCES.md#pd-10
[SX-04]: ../SOURCES.md#sx-04
[SX-13]: ../SOURCES.md#sx-13
[B-CONTEXT]: ../evidence/original-brief/01_CONTEXT.md
[SX-11]: ../SOURCES.md#sx-11
