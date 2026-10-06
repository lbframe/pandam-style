# Agent contract: audit a project for PandamStyle

## Objective and boundary

Produce a read-only assessment of whether and where PandamStyle could be used.
The audit MUST NOT install packages, run migration transforms, edit source,
change a lockfile, create a report file, or run project scripts that may write
to the repository. Report findings in the response unless the user requests a
saved artifact.

## Allowed inspection

Read manifests, lockfiles, host configs, compiler configs, tracked/untracked
source names, stylesheets, token/theme definitions and existing checks. Use
read-only search and metadata commands. Do not execute untrusted build or
install scripts during an audit. If a descriptor cannot be read safely, mark it
unknown rather than guessing.

## Audit procedure

1. Detect framework, exact version, bundler, host mode, package manager, Node
   declaration, config format, TypeScript/JavaScript setup and existing scripts.
2. Compare that host tuple with the [qualified support matrix](agent-install.md#qualified-hosts).
3. Estimate project size reproducibly: count app-local JS/TS/JSX/TSX files under
   named roots and record the roots and command/method used. Exclude generated,
   dependency, build and cache directories. Do not call a source-file count a
   LOC count or an exact compiler coverage count.
4. Identify styling technologies and entry points: global CSS, CSS Modules,
   CSS-in-JS, utility systems, component libraries, CSS preprocessors and
   handwritten styles. Record package names and representative paths.
5. Identify semantic design-system state: token sources, public/private
   visibility if explicit, themes, conditions/breakpoints, recipes, repeated
   component styles and layout patterns.
6. List constructs that may not map automatically: runtime style construction,
   dynamically composed class names, generated source, unsupported CSS
   properties/forms, framework-specific files outside covered JS/TS roots,
   global selectors, animations and third-party component internals.
7. Assess migration risk and benchmark readiness separately. Do not infer
   either from repository size alone.

## Stable result shape

Return a machine-readable JSON object with these keys. Use the JSON string
`"unknown"` instead of fabricated counts or coverage:

For `compatibility.status`, use `supported`, `not_qualified`, or `unknown`.
For `migration.readiness`, use `high`, `medium`, `low`, or `unknown`. For
`benchmark.readiness`, use `ready`, `partial`, `not_ready`, or `unknown`. A
source-file count is a number or `null`; a presence field is a boolean or
`null`. Use `null` when inspection could not establish a value, and use an
empty array only when inspection found no entries.

```json
{
  "schemaVersion": "pandamstyle-audit/v1",
  "stack": {
    "framework": { "name": "", "version": "", "evidence": [] },
    "bundler": { "name": "", "version": "", "mode": "", "evidence": [] },
    "packageManager": { "name": "", "version": "", "lockfile": "" },
    "node": { "declared": "", "observed": "" },
    "compatibility": { "status": "unknown", "reason": "" }
  },
  "project": {
    "roots": [],
    "sourceFiles": { "js": null, "jsx": null, "ts": null, "tsx": null, "excludedDirs": [] }
  },
  "styling": { "technologies": [], "tokenSystems": [], "themeSystems": [], "repeatedStructures": [] },
  "designSystem": {
    "tokens": { "present": null, "source": [], "semanticCoverage": "unknown" },
    "recipes": { "present": null, "candidates": [] },
    "patterns": { "present": null, "candidates": [] },
    "unsupportedOrDynamic": []
  },
  "migration": { "readiness": "unknown", "opportunities": [], "risks": [] },
  "benchmark": { "readiness": "unknown", "availableChecks": [], "missingInputs": [] },
  "recommendedNextAction": ""
}
```

`recipes.candidates` and `patterns.candidates` are hypotheses supported by file
references, not automatic migration instructions. Set compatibility to
`supported` only for an exact qualified host/backend tuple.

## Stop and completion

Stop if the requested audit would require mutation or execution to answer a
question; mark it unknown and explain why. Completion requires the structured
assessment, evidence paths, explicit unknowns, risks, and one recommended next
action. Ask before proceeding from audit to install or migration only if the
user's request did not already authorize that next action.
