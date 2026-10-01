# Third-party attribution and source provenance

This file records third-party source used by PandamStyle and reference source
consulted during its development. It is a provenance record, not a legal
opinion. See each source's license text and the retained notices in source
files.

## Facebook StyleX

- Repository: [`facebook/stylex`](https://github.com/facebook/stylex)
- Recorded release: `0.19.1`
- Recorded source commit: `fe0be7f0e76ccc585385f0fa56d9b50053ff9ca2`
- License: MIT; the root [`LICENSE`](LICENSE) carries the Meta Platforms notice.
- PandamStyle use: selected engine helpers were refactored into owned compiler
  modules. Their source headers and file-by-file mapping are preserved in
  [`phase-4-derived-source-provenance.md`](docs/architecture/phase-4-derived-source-provenance.md).
- The original StyleX package tree was removed during Phase 5; Git history
  retains the repository changes.

## Panda CSS reference source

- Repository: [`chakra-ui/panda`](https://github.com/chakra-ui/panda)
- Recorded comparison commit: `1a310482ff18102c44b2a478b7644b064a80d7c6`
- License: MIT; the vendored tree's exact license text is retained at
  [`LICENSES/PANDA-MIT-LICENSE.md`](LICENSES/PANDA-MIT-LICENSE.md).
- PandamStyle use: comparison and design rationale only. The source was not
  absorbed into the compiler and the vendored checkout was removed during
  Phase 5.
- The separate historical Panda v2 source reference is commit
  `c171f630adc6dec4a1f9e4b9a79ef706d8278aae`, as recorded in
  [`SOURCES.md`](docs/pandamstyle-specification-v0.1/SOURCES.md).

## Notices

Retained source-file copyright and license headers remain alongside the
derived modules. The repository root `LICENSE` covers PandamStyle files; the
Panda comparison license is copied without alteration into `LICENSES/`.
