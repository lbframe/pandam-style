# Agentic evaluation report smoke-20261019-r2

## Cells

| Task | Model | k/n (valid) | point | lower bound | contested | missing | first pass (t/f/?) | tool calls | tokens in | tokens out | cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| composition-positive-order-summary | claude-haiku | 0/1 | 0% | 0% | 0 | 0 | 0/1/0 | 12 | 130634 | 4449 | 0.006519080000000001 |
| composition-positive-order-summary | claude-sonnet | 0/1 | 0% | 0% | 0 | 0 | 0/1/0 | 6 | 66732 | 1851 | 0.0572211 |
| composition-positive-order-summary | gpt-sol | 0/1 | 0% | 0% | 0 | 0 | 0/1/0 | 8 | 126724 | 991 | ? |
| discovery-positive-card-vocabulary | claude-haiku | 1/1 | 100% | 100% | 0 | 0 | 0/0/1 | 5 | 46737 | 1927 | 0.00364889 |
| discovery-positive-card-vocabulary | claude-sonnet | 1/1 | 100% | 100% | 0 | 0 | 0/0/1 | 2 | 25389 | 694 | 0.0339823 |
| discovery-positive-card-vocabulary | gpt-sol | 1/1 | 100% | 100% | 0 | 0 | 0/0/1 | 5 | 72084 | 635 | ? |

Values are listed per valid repetition; `?` is unknown. Stream-derived values are estimates (`cli-stream-unattested`). Latencies are indicative.

## Policy and scope breaches

- composition-positive-order-summary / claude-haiku rep 1 attempt 1 (verdict pass): local-install (detected)
- composition-positive-order-summary / claude-sonnet rep 1 attempt 1 (verdict fail): local-install (detected); vocabulary: fail
- composition-positive-order-summary / gpt-sol rep 1 attempt 1 (verdict pass): local-install (detected)

## Unsupported / not run

None.

## Missing repetitions

None.

## Infrastructure

```json
{}
```
