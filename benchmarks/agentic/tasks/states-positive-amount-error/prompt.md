When `TransferForm` receives an `amountError`, the hint under the amount input
must use the critical feedback color (the input already reflects the invalid
state through `aria-invalid`). Without an error the hint keeps its current
subtle color. Only change `src/components/TransferForm.tsx`.
