# Semantic oracle v1

The semantic oracle is a contributor and CI verification suite for public
PandamStyle behavior. It is development-only: applications and published
packages do not import the oracle or its harness.

## Cases and expectations

`tests/semantic/cases/` records authored scenarios and expected results.
`fixtures/` contains small synthetic projects, and `expectations/` contains
independent expected values. The implementation adapter exercises the compiler;
the browser adapter checks emitted artifacts in Chromium where browser behavior
is part of the contract.

The suite covers tokens and themes, static authoring, finite recipe selection,
imports and forwarding, source resolution, incremental revisions, publication
and recovery, diagnostics, and representative browser output. Expected values
are authored independently of compiler output so that two execution paths
agreeing with each other does not by itself count as correctness.

Known gaps, if any, are listed in the
[semantic gap register](semantic-gap-register.md). No case is currently
classified as a known gap.

## Verification

Run `./verify-pms.sh` from the repository root for the complete normal
verification sequence. It reports suite totals and fails if cases, assertions,
or gates are missing. Generated reports belong under the configured verifier
output directory and are not source files.
