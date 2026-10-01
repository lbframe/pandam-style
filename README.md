# PandamStyle

PandamStyle compiles JavaScript and TypeScript style declarations against an
explicit design system and emits static CSS and application code. Its public
packages are `@pandamstyle/core` and `@pandamstyle/compiler`.

The current API and repository status are documented in
[`PANDAMSTYLE.md`](PANDAMSTYLE.md). The frozen package and semantic contracts
are in [`docs/architecture/`](docs/architecture/).

## Packages

- [`@pandamstyle/core`](packages/core/): runtime composition helpers and the
  generated design-system ABI.
- [`@pandamstyle/compiler`](packages/compiler/): compiler SDK, project service,
  configuration API, host API, and the `pms-build` command.

The Vite React application in [`examples/pilots/vite-react/`](examples/pilots/vite-react/)
is a qualification pilot. It installs the packages produced by `npm pack` and
does not add a public Vite integration.

## Development

Use Node 22 as pinned in `.nvmrc` and Yarn 1 as declared by `packageManager`.

```sh
yarn install --frozen-lockfile
./verify-pms.sh
```

The official verifier installs dependencies, builds the owned compiler,
executes the PandamStyle and core suites, checks the semantic oracle and
verification tools, builds the packed pilot, collects artifacts, and verifies
donor closure. Static checks are available through `yarn flow`,
`yarn prettier:report`, and `yarn lint:report`.

## License and provenance

PandamStyle is MIT licensed. Third-party attribution, source revisions and
retained notices are recorded in [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md) and
[`LICENSES/`](LICENSES/).
