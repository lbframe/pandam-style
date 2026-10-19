# Agentic evaluation report smoke-20261019-r3

## Cells

| Task | Model | k/n (valid) | point | lower bound | contested | missing | first pass (t/f/?) | tool calls | tokens in | tokens out | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| composition-positive-order-summary | claude-haiku | 1/1 | 100% | 100% | 0 | 0 | 0/0/1 | 11 | 126167 | 4488 | 0.00596704 |
| composition-positive-order-summary | claude-sonnet | 1/1 | 100% | 100% | 0 | 0 | 0/0/1 | 6 | 66793 | 1862 | 0.051062100000000006 |
| composition-positive-order-summary | gpt-sol | 0/1 | 0% | 0% | 0 | 0 | 0/1/0 | 9 | 136650 | 1082 | ? |
| discovery-positive-card-vocabulary | claude-haiku | 1/1 | 100% | 100% | 0 | 0 | 0/0/1 | 3 | 42806 | 1832 | 0.00263013 |
| discovery-positive-card-vocabulary | claude-sonnet | 1/1 | 100% | 100% | 0 | 0 | 0/0/1 | 2 | 25573 | 845 | 0.0278589 |
| discovery-positive-card-vocabulary | gpt-sol | 1/1 | 100% | 100% | 0 | 0 | 0/0/1 | 3 | 51612 | 519 | ? |

Values are listed per valid repetition; `?` is unknown. Stream-derived values are estimates (`cli-stream-unattested`). Latencies are indicative.

## Policy and scope breaches

- composition-positive-order-summary / gpt-sol rep 1 attempt 1 (verdict fail): vocabulary: fail

## Unsupported / not run

None.

## Missing repetitions

None.

## Infrastructure

```json
{}
```
