# Changelog

## 1.0.1 - Bug fixes

- Bound streaming and recovery journal buffers to prevent runaway memory usage during slow or failed disk writes.
- Reduced conversation restore memory by replaying only the latest valid snapshot and joining streamed chunks once.
- Added a visible circuit breaker for repeated identical tool-call failures.
- Fixed unchanged conversations being skipped during explicit compaction.
- Prevented empty `Untitled` conversation shells from being persisted or listed.
