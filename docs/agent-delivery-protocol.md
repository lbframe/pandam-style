# Agent delivery and review protocol

This document defines how contributing agents deliver and review repository
work. It is a **contribution process**: it is not a PandamStyle API, a product
behavior or a shipped capability. It applies to every delegated implementation
task and every independent review in this repository, across initiatives.

It was adopted on 2026-10-18 by the core-evolution (#39) and agentic
optimizations (#4) orchestrators, after review loops of 7 rounds (CE-00.2), 5
rounds (AG-00.1) and 3 rounds (CE-00.1). Those loops came from scope added
during fix rounds, unvetted mechanisms prescribed in briefs, expectations
inferred instead of observed, fixes that closed one instance instead of the
class, and the absence of a severity and exit contract.

## Implementation

1. **No scope added during fix rounds.** A tool, checker or capability that is
   not required by the issue's acceptance criteria becomes a follow-up issue.
   It is never added as part of a fix.
2. **Design note before implementation** when the task has a privacy, security
   or adversarial-oracle surface. The note covers the threat model, the
   invariants that hold by construction and exactly what is published. It gets
   a short review before code is written. A brief never prescribes a concrete
   mechanism without checking it against that threat model.
3. **Execute, don't infer.** No expectation, baseline or claimed diagnostic is
   committed unless it was observed by running it. A claim made only by reading
   source must be labeled unverified.

   This rule never requires decrypting a sealed dataset, such as the AG
   held-out set. For sealed data, observation goes through digests, manifests
   and checks that need no passphrase. Decryption stays limited to the uses
   listed in that dataset's access policy.
4. **Self-review before handoff.** For each acceptance criterion and
   invariant, the implementer enumerates the failure classes that could make
   the delivery wrong. Each class is covered by class-level tests or mutations,
   not only by the reproduction that revealed it.

## Review

5. **Review contract.**
   - The reviewer judges against the issue's acceptance criteria and
     constraints.
   - `block` is reserved for:
     - a violated acceptance criterion or constraint;
     - a privacy violation;
     - a false proof in an oracle or check the issue requires: a false
       acceptance, or a false rejection of idiomatic code.
   - Every other finding is `follow-up` and is filed as an issue.
   - The reviewer generalizes each finding to its class and lists the other
     instances found.
6. **Round limit.**
   - At most two full review rounds, then one bounded verification of the
     specific fixes.
   - In the bounded verification, a regression introduced by the fix diff
     itself is `block`.
   - The orchestrator decides residual non-blocking findings.
   - A `block` finding that survives the bounded verification can be accepted
     as a residual risk only by the user, or by an orchestrator the user has
     explicitly delegated that decision to. It is never turned into a follow-up
     issue without that authority.
7. **Fixes close the class.** A fix is accepted when it closes the class of
   failure, with class-level tests, not only the reproduction.

## Publication

8. **Local leak scan before the first push.** Any branch containing data
   derived from a private or sealed source is scanned locally before its first
   push. Pushing a branch to this public repository publishes its commits;
   deleting the branch afterwards does not make them unreachable by SHA.
   Existing guards include the CE-00.2 publication gate
   (`tools/coverage/publication.mjs`). The AG held-out guard
   (`pms-agentic heldout guard`) lands with AG-00.1 (PR #88).

## Reviewer briefs

When briefing reviewers on adversarial oracles or checks, describe the review
in terms of scoring correctness: false acceptances and false rejections.
Avoid sandbox-escape wording, which has triggered provider safety filters on
otherwise legitimate review tasks.
