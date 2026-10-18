# Runtime observations

An ObservationSet records what an authoritative external system actually said,
at a known time, with a durable reference to the raw evidence.

## Rules

1. Never put a secret, token or credentialed URL in an observation, an evidence
   bundle, or anywhere else in this directory. Run `agentdoc validate`; it
   fails on secret-shaped input.
2. Every fact needs a `subject` (an entity ref that exists) and a `key`
   (see "Fact keys" in the AgentDoc specification,
   docs/SPEC.md of https://github.com/lbframe/agent-doc-system). Two
   observation sets must not use the same key on the same subject.
3. `evidenceBundle` must be a committed, repository-relative file. A temp
   path, a console URL with a session token, or a screenshot filename is not
   evidence.
4. `maxAgeDays` is a promise. When the observation is older than that, every
   gate fails closed and says so. Re-observe, or restate the fact as authored
   intent if the divergence is intended.

## Shape

See the `observation.yaml` template shipped with the agentdoc CLI
(templates/observation.yaml in the installed package).
