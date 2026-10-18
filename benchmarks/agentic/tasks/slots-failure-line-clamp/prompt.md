Long bank-sync messages make the alert too tall. Truncate the alert message to
at most two lines with an ellipsis. Only change `src/components/SyncAlert.tsx`
and keep the build passing.
