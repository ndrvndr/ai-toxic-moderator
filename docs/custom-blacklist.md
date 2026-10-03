# Custom Blacklist

## Implementation status

The first step defines strict public contracts and validation tests. Blacklist
entries are not yet accepted by the Settings API, persisted, shown in the dashboard,
or evaluated by the worker. Adding a contract does not enable moderation actions.
Existing settings and historical run snapshots retain their current format.

## Entry contract

Each entry has a UUID `id`, explicit `enabled` boolean, `match_type`, literal
`pattern`, and one action. A configuration has `schema_version: 1`, an explicit
`enabled` boolean, and at most 100 entries. This version describes the blacklist
contract, not a replacement for the existing moderation settings schema.

| Match type | Intended behavior                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WORD`     | Match one Unicode word at word boundaries. Punctuation and spaces require phrase matching.                                                                 |
| `PHRASE`   | Match a literal substring after normalization; regex metacharacters have no executable meaning.                                                            |
| `DOMAIN`   | Match an extracted URL hostname equal to the configured host or a subdomain with a dot boundary. Never match arbitrary text containing a domain substring. |

The future matcher must use the same NFKC, lowercase, trim, and whitespace
normalization as the contract. Invisible control/format characters in configured
patterns are rejected. Domain patterns use ASCII hostnames, including punycode,
without schemes, paths, ports, wildcards, or IP addresses. Domain extraction and
message matching are not implemented by this validation step.

| Action           | Required behavior                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DELETE`         | Delete the matched message.                                                                                         |
| `DELETE_TIMEOUT` | Delete the message and request a timeout for its verified author. Requires `duration_seconds` between 1 and 86,400. |
| `DELETE_BAN`     | Delete the message and request a permanent ban for its verified author.                                             |

Duration bounds are application limits. Each executor must still enforce provider
constraints and target eligibility. IDs are canonicalized to lowercase; patterns
are canonicalized before duplicate checks. Duplicate IDs and duplicate patterns
within the same matching mode are rejected, including disabled entries. Different
matching modes may overlap; their resolution belongs to the future planner.
Client-supplied author/message targets and unknown fields are rejected.

Example validated entry:

```json
{
  "id": "10000000-0000-4000-8000-000000000001",
  "enabled": true,
  "match_type": "PHRASE",
  "pattern": "kantorbola99",
  "action": "DELETE_TIMEOUT",
  "duration_seconds": 300
}
```

## Remaining implementation

1. Versioned settings persistence, API validation, and immutable run snapshots.
2. Settings editor for creating, editing, disabling, and removing entries.
3. Literal matcher and deterministic conflict handling before AI processing.
4. Combined message/author action plans with separate execution outcomes and
   idempotency. Ban takes priority over timeout; deletion remains independent.
5. Decision provenance in chat and History, plus integration and live verification.

Exceptions and AI thresholds are separate follow-up work. Blacklist matches are
explicit streamer policy; AI scores do not change their configured action.

## Manual validation

Run from the repository root:

```powershell
npm run format
npm run check
npm run test:custom-blacklist-contracts
npm run test:moderation-settings-contracts
npm run build:core
```

No migration or environment change is required for this contract-only step.
Commands and tests are executed manually by the developer.
