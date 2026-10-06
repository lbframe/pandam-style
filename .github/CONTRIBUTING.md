# Contributing to PandamStyle

## Before opening a change

Search the issue tracker for existing reports, and open an issue to discuss a
large API or architecture change before investing in implementation. Keep pull
requests focused and include tests and documentation for behavior changes.

## Development setup

Use Node.js `^22.12.0`, `^24.0.0`, or `^26.0.0` and Yarn `1.22.22`.

```sh
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile
```

Run the repository verifier before submitting a change:

```sh
./verify-pms.sh
```

The `flow`, `prettier:report`, and `lint:report` scripts are available for
focused checks. Update the relevant package documentation when changing a
public API or supported host integration.

## Pull requests

Create a branch from `main`, explain the motivation and user-visible impact,
and link related issues. Include the commands you ran and their results. Do not
include generated output, local environment data, or unrelated files.

For agent-assisted application setup, see the public
[installation contract](../docs/agent-install.md).
