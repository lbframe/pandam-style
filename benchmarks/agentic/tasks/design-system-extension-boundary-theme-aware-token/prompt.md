Design approved a recessed surface token (ticket DS-87):

- Add a public token `colors.bg.sunken`: `gray200` in the default (light)
  theme, `gray900` in `dark`. The `highContrast` theme must render it pure
  black.
- Use it as the background of the transfer form (`transfer-form`).

You may edit `design.pandamstyle.config.js` and
`src/components/TransferForm.tsx` only. Do not change other vocabulary.
