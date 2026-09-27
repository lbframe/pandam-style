# Démonstration — chaîne tokens → recipe → CSS (L1/L2/L4 amorce)

**Statut : prototype démontré** (niveau intermédiaire de l'acceptation §1 — pas P0 conforme).
Code : `upstream/stylex/packages/@stylexjs/babel-plugin/pandamstyle/` + tests `__tests__/pandamstyle/`.
Moteur : fonctions réelles du fork (`styleXDefineVars`, `styleXCreateTheme`, `styleXCreateSet` de `src/shared`, `props`/`styleq` de `@stylexjs/stylex`).

## Ce qui a été exécuté

19 tests jest (`jest-pandamstyle.log`, exit 0) + production des artefacts ci-dessous au même commit `fe0be7f…` :

| Artefact | Preuve |
|---|---|
| `styles.css` | CSS extrait du moteur : groupe de variables `:root`, surcharge dark `.xx4k14q` sur les **mêmes** identités de variables, classes atomiques, bloc `@media (min-width: 768px)`, `:is(:hover, [data-hover])` issu de la recipe. |
| `diagnostics-17px.json` | Rejet effectif de `padding: '17px'` côté consommateur : `PMS_FORBIDDEN_VALUE`, phase `policy`, candidats admis listés, `autofix: null`, exit code 1. Obtenu en JavaScript pur — aucun typecheck. |
| `manifest.json` | Projection consommateur : tokens publics seulement (primitives filtrées), conditions, thèmes, domaines de recipe, `capabilities` P1 à `false`, `supportedProperties`. |
| `page.example.json` | Namespaces compilés, classPaths avec provenance des conditions, compositions `props()` light/dark et variants de bouton. |
| `demo.html` | Page rendue avec le CSS extrait (deux thèmes, deux boutons). |
| `build-report.json` | Commit du fork, `registryDigest`, version de contrat, état des cas. |

## Couverture vs spec

- **Tokens → vars** : registre avec identité logique (`systemId + category + path`), digest sha256 canonique, primitives privées / sémantiques publiques, références à un saut et cycles détectés (`PMS_UNKNOWN_TOKEN`, `PMS_TOKEN_CYCLE`, `PMS_DUPLICATE_TOKEN`).
- **Thèmes** : base complète + surcharge partielle `dark` via `styleXCreateTheme` ; identités de variables partagées (D-04).
- **Conditions** : forme publique `{ base, wide }` normalisée en blocs (D-05) ; `hover`/`disabled` portent les définitions Panda (`:is(:hover,[data-hover])`, data/ARIA) ; inconnue → `PMS_UNKNOWN_CONDITION`.
- **Politique** : catégories strictes, domaines structurels finis (D-12/D-13), composites `border`/`background`… → `PMS_UNSUPPORTED_PROPERTY_FORM`, hors profil → `PMS_UNSUPPORTED_PROPERTY`, token privé → `PMS_TOKEN_NOT_PUBLIC`, mauvaise catégorie → `PMS_INVALID_TOKEN_CATEGORY`, brute → `PMS_FORBIDDEN_VALUE`.
- **Recipe** : portage `cva` (PD-05) — `axisOrder` capturé à la déclaration, défauts, `undefined`→défaut, `null`/clé/valeur inconnues → erreurs déterministes ; branches compilées séparément (somme, pas produit cartésien) ; pas de `.raw`/`.merge` ; sélecteur runtime borné (`PMS_INVALID_VARIANT_*`).
- **Composition** : `props`/`styleq` du fork, dernier gagne par clé propriété+condition ; cas charnière base+hover vérifié.

## Ce qui n'est PAS démontré (reste aux lots suivants)

Traversée babel du code consommateur (le démonstrateur alimente le moteur avec l'IR déjà normalisé, pas l'AST), résolution inter-fichiers, unplugin/couverture de build, installation `pack` hors workspace, SSR/hydratation, types générés, invalidation incrémentale, mesures de performance. Hypothèses H-01..H-07 ouvertes.
