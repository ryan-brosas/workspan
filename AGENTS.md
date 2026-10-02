# Workspan

Read [README.md](README.md) for current status and [the architecture](docs/architecture.md) for proposed ownership and acceptance gates. [Source research](docs/research-2026-10-02.md) records the verified `context:workspan` corpus and revision limits. Recheck decisive current source before implementation. The [Dot research](docs/dot-time-tracking-research-2026-10-02.md) records observed behavior, not a working integration.

## Implementation ownership

- Workspan is tool-independent. Omarchy is an optional interface; Pi is one adapter.
- The existing implementation is `../pi-time-tracker/`. Inspect its current source, instructions, and tests before extracting or integrating anything. Preserve its installed behavior and historical time records.
- Keep one accounting/storage authority. Do not duplicate the existing implementation here or create separate per-adapter totals that are later added together.
- Reuse the current TypeScript/SQLite and Bend accounting decisions unless an observed requirement justifies changing them.

## Evidence and privacy

- User-attested sessions, inferred work windows, and agent runtime are distinct measures. Merge concurrent intervals within a measure, never add different measures together.
- Work between questions can be part of an attended session. Agent activity alone does not establish attendance. Preserve uncertain gaps.
- Give imported evidence stable source/session/event identity and explicit project attribution. An application name, cloud thread, or missing cwd is not enough to assign a client.
- Keep metadata only by default. Do not store conversation bodies, screenshots, window titles, URLs, raw tool payloads, credentials, or customer data.
- Treat private client endpoints and local caches as versioned observations, not supported public APIs. Validate event coverage and replay behavior before claiming automatic tracking.

## Delivery boundary

Local implementation is separate from enabling a service, modifying desktop or agent configuration, importing live history, or changing official hours. Obtain the applicable approval before those actions. Load the installed Omarchy skill before desktop configuration or plugin installation. No remote push, publication, or release is implied by this project setup.
