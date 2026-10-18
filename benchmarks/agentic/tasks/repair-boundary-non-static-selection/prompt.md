After a refactor that made `hot` optional in `src/ui/DestinationCard.jsx`, the
build fails with a PandamStyle diagnostic. Fix it without changing what users
see. Only that file may change.
