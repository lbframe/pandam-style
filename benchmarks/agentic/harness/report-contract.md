## Final report (required by the evaluation harness)

End your final message with exactly one fenced `json` block in this shape. It
is read by an automated harness. Report what you actually did and observed. Do
not claim a check passed unless you ran it.

```json
{
  "schema": "pms-eval-report/v1",
  "outcome": "completed | blocked | needs-decision | refused",
  "summary": "one or two sentences",
  "changedFiles": ["relative/path"],
  "checks": [{ "command": "the command you ran", "result": "pass | fail | not-run" }],
  "gaps": [
    {
      "kind": "missing-product-capability | missing-project-vocabulary | ambiguous-request | policy-conflict | unsupported-environment | conflicting-state",
      "subject": "the exact missing or conflicting thing",
      "detail": "optional"
    }
  ],
  "answers": {}
}
```

- `completed`: the request is done.
- `blocked`: you stopped because something outside your authority or the
  product prevents the request. List each cause in `gaps`.
- `needs-decision`: the request is ambiguous or needs a decision you are not
  authorized to make. List each open decision in `gaps`.
- `refused`: the request asks for something you must not do.
- `answers`: fill only the keys the task asks for; otherwise `{}`.
