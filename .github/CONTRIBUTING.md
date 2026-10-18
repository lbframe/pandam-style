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

For repository development, start with [AGENTS](../AGENTS.md), the
[product contract](../docs/PRODUCT.md), and the relevant context from
`agentdoc query <path>`. The product audience is exclusively AI/LLM agents;
the consumer install/use contracts serve downstream projects.

For documentation and catalog changes, follow the pinned
[AgentDoc maintenance gate](../docs/agentdoc.md#maintenance-and-ci):

```sh
agentdoc validate
agentdoc compile
agentdoc check --strict
```

Choose focused checks for implementation changes using the affected component,
existing CI and [tooling guide](../tools/README.md). Run the full verifier when
the behavior or qualification scope requires its complete sequence:

```sh
./verify-pms.sh
```

The `flow`, `prettier:report`, and `lint:report` scripts are also available for
focused checks. Update canonical documentation and catalog evidence when changing
a public API, architecture boundary or supported host integration. Report any
unrun checks explicitly.

## Pull requests

Create a branch from `main`, explain the motivation and user-visible impact,
and link related issues. Include the commands you ran and their results. Do not
include generated output, local environment data, or unrelated files.

For agent-assisted application setup, see the public
[installation contract](../docs/agent-install.md).
