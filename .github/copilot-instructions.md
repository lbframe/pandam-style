# PandamStyle review guidance

- Check that changes preserve the documented public API and package boundaries.
- Require tests for compiler, runtime, or host-integration behavior changes.
- Review generated JavaScript, declarations, and CSS when output behavior changes.
- Check that package versions and exact internal dependency versions stay aligned.
- Keep private environment data, generated build output, and unrelated artifacts
  out of changes.
- Report concrete correctness, compatibility, or security issues with file and
  line context; avoid style-only suggestions.
