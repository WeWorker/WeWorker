# Multi-user certification architecture

## Storage layers

### Shared and versioned

The repository owns:

- `SKILL.md` and generic run policy;
- deterministic inventory, mock, live-runner, matrix, and packaging scripts;
- `adapter-playbooks.json`, containing non-user-specific requirements;
- `shared-baseline.json`, containing source fingerprints and sanitized static/mock evidence;
- sanitized product defects and static/mock evidence.

Shared data must never contain a person's accessible subsystem IDs, account identifiers, browser profile names, fixture IDs, or live authentication status.

A new developer may reuse a matching shared baseline for static and mock gates, but must establish their own live evidence. This prevents both zero-memory reruns and cross-user permission leakage.

### Developer-local and private

Each developer has an explicit profile below:

```text
~/.weworker/api-adapter-certification/
├── profiles/<profile-id>.json
└── memory/<profile-id>.json
```

`profile-id` is a user-chosen local alias. Do not derive it from the OS username, Git config, email, or an account response. Separate profiles allow multiple developers to use the same checkout or machine without mixing evidence.

The profile stores only capability facts needed to select safe probes: accessible subsystem aliases/IDs, approved UAT fixture aliases, required page URLs, and last verification times. The memory file stores fingerprints and sanitized certification categories. Neither file stores credentials or raw responses.

## Evidence portability

| Evidence | Reusable across developers | Invalidation |
| --- | --- | --- |
| Inventory and schema | Yes | Relevant source fingerprint changes |
| Mock success/error/safety | Yes | Adapter or shared Runner fingerprint changes |
| Stable product HTTP/response defect | Yes, as a known defect | Adapter code or environment remediation changes |
| Authentication result | No | Session changes or TTL expires |
| Permission result | No | Profile capability changes or TTL expires |
| Fixture/page-context result | No | Profile fixture/context changes or TTL expires |
| Confirmed mutation result | No | Never reuse outside the exact profile, fixture, and source fingerprint |

## Fingerprints

The memory script hashes:

- shared routing and certification code;
- `build-profile.json`;
- each Adapter's manifest, entrypoint, generated metadata, and ordered support files.

A shared fingerprint change requires all Adapters to rerun. A per-Adapter change reruns only that Adapter. Unchanged evidence is still refreshed when the live TTL expires; the default is 24 hours for release certification.

## Profile changes

Every Adapter-specific profile entry has its own `updatedAt`. Changing one Adapter's capability list should recheck that Adapter, not the whole inventory. Changing a global profile policy may recheck every affected mutation class.

Example separation:

```text
shared playbook: a tool requires an authorized project
developer A profile: project binding A
developer B profile: project binding B
```

The shared playbook knows the requirement and parameter mapping. Each local profile supplies only that developer's binding. Reports may say “authorized fixture used” but must not publish the binding value.

## Atomicity and concurrency

- Write memory atomically through a temporary sibling file followed by rename.
- Refuse to overwrite a profile during initialization unless explicitly requested.
- Validate schema version and forbidden secret fields before reading a profile.
- Keep one memory file per profile so concurrent developers never overwrite each other.

## Team aggregation

If centralized reporting is added later, upload only de-identified product evidence: fingerprints, tool names, result classes, latency ranges, and timestamps. Keep profile IDs, capability values, fixture values, auth state, and raw responses local.
