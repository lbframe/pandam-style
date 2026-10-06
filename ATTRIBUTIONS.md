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
  modules. Their source headers and file-by-file mapping are preserved in the
  [derived-source provenance map](docs/architecture/phase-4-derived-source-provenance.md).

## Panda CSS reference source

- Repository: [`chakra-ui/panda`](https://github.com/chakra-ui/panda)
- Recorded comparison commit: `1a310482ff18102c44b2a478b7644b064a80d7c6`
- License: MIT; the vendored tree's exact license text is retained at
  [`LICENSES/PANDA-MIT-LICENSE.md`](LICENSES/PANDA-MIT-LICENSE.md).
- PandamStyle use: comparison and design rationale only. The source was not
  absorbed into the compiler. Its license text is retained for attribution.
## Notices

Retained source-file copyright and license headers remain alongside the
derived modules. The repository root `LICENSE` covers PandamStyle files; the
Panda comparison license is copied without alteration into `LICENSES/`.
