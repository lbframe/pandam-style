# PandamStyle Alpha 1 release notes

**Version:** `0.1.0-alpha.1`

**npm dist-tag:** `alpha`

PandamStyle is a constrained styling language and compiler built primarily for
AI coding agents. Agents compose interfaces from design-system vocabulary;
PandamStyle validates the result against compiler-enforced constraints.

Alpha 1 supports tokens, styles, recipes, slot recipes, compound variants,
layout patterns, themes, generated types, actionable diagnostics, and an
incremental Project Service. It is intended for real-world testing. API and
behavior may evolve, and this release is not presented as production-stable.

## Qualified hosts

| Host | Qualified integration |
| --- | --- |
| Vite 8.3.1 | Rolldown development and production qualification |
| Next.js 16.3.8 | webpack development and production; Turbopack semantic development |
| Rsbuild 2.2.11 | Rspack development and production |

Package manifests qualify Node `^22.12.0 || ^24.0.0 || ^26.0.0`. Do not infer
support for other host versions or modes from dependency compatibility.

## Install and feedback

The default setup path is to ask a coding agent to follow the canonical
[installation contract](https://github.com/lbframe/pandam-style/blob/main/docs/agent-install.md).
Install every Alpha package using the `@alpha` tag, as shown in the contract.
Do not treat npm's `latest` tag as a stable PandamStyle channel; the first
stable release will make `latest` authoritative for stable installation.
Installation does not migrate existing styles. For an overview and all agent
workflows, see the [PandamStyle README](https://github.com/lbframe/pandam-style/blob/main/README.md).

Feedback is most useful when it includes the host and version, the requested
agent task, relevant compiler diagnostics, whether visible behavior changed,
and a minimal reproducible project where possible. In particular, report
unsupported host/configuration cases and repair loops that require guessing.

## Performance evidence

The compact, source-linked measurements are in
[`benchmarks/alpha1-reference.json`](../../benchmarks/alpha1-reference.json).
They are synthetic compiler workloads, not universal application-speed claims.

## Final publication procedure

Do not execute these steps from a workstream branch. At the approved final
convergence commit:

1. Confirm that the exact candidate tree is clean and record its commit SHA.
2. Run `./verify-pms.sh` without install, suite, pilot, or step filters.
3. Repack and inspect all five Alpha tarballs and run the clean tarball consumer
   and host smoke matrix against that exact tree.
4. Create and push annotated Git tag `v0.1.0-alpha.1` at the verified commit.
5. Publish in dependency order: `@pandamstyle/core`, `@pandamstyle/compiler`,
   then `@pandamstyle/vite`, `@pandamstyle/next`, and `@pandamstyle/rsbuild`,
   each with `npm publish <package-directory> --access public --tag alpha`.
6. Verify the registry versions, `alpha` dist-tags, tarball files, and clean
   installs in the Vite, Next.js, and Rsbuild consumer fixtures.
7. Create the GitHub release for `v0.1.0-alpha.1` using this note and the
   final candidate commit. Keep the release marked as a prerelease.

## Rollback and partial publication

- **One package published and a later publish fails:** do not unpublish or
  overwrite the immutable version. Stop the release, record the published set,
  remove the `alpha` dist-tag from incomplete packages or move it back to the
  last known consistent version when one exists, and mark the incomplete
  prerelease deprecated. Fix the cause, increment all package versions and
  internal exact dependencies to `0.1.0-alpha.2`, rerun the full gate, and
  publish the complete set before assigning the `alpha` tag to it.
- **Unexpected tarball files:** stop before publication. Correct package
  allowlists or generated build contents, create a new candidate commit, and
  rerun the pack and consumer gates.
- **Registry install or smoke fails:** stop the release. If no package has been
  published, fix and requalify the candidate. If publication is partial or
  complete, do not assume registry deletion is available; deprecate affected
  versions and publish a fully qualified next prerelease.
- **Git tag points to the wrong commit:** do not reuse the tag name for a
  different tree. Publish a corrective prerelease from the verified commit and
  create a new tag; document the superseded tag in release notes. If registry
  publication has not started, correct the local candidate before pushing a
  tag.
- **Release notes or package metadata differ:** stop before publication when
  possible. If already published, leave immutable package contents intact,
  deprecate the affected version when necessary, and issue a corrected
  prerelease with matching metadata and release notes.

Repository bootstrap qualification does not publish npm packages, create a Git
tag, or create a GitHub release.
