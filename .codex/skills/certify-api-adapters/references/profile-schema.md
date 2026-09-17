# Developer profile schema

Profiles are private local JSON. Create or update one only after batching and confirming the user's facts.

## Required shape

```json
{
  "schemaVersion": 1,
  "profileId": "developer-chosen-alias",
  "updatedAt": "2026-09-14T00:00:00.000Z",
  "policy": {
    "allowAuthenticatedReads": true,
    "allowDryRuns": true,
    "allowConfirmedMutations": false
  },
  "adapters": {
    "api.example.com": {
      "updatedAt": "2026-09-14T00:00:00.000Z",
      "auth": {
        "mode": "browser-session",
        "lastVerifiedAt": null
      },
      "capabilities": {
        "projects": [
          {
            "alias": "safe-test-project",
            "id": "<developer-specific-id>",
            "name": null
          }
        ]
      },
      "fixtures": {},
      "pageContexts": []
    }
  }
}
```

## Field rules

- `profileId`: explicit local alias matching `[a-z0-9][a-z0-9_-]{0,63}`.
- `updatedAt`: ISO timestamp. Update the top-level field for policy changes and the Adapter field for Adapter-specific changes.
- `policy.allowConfirmedMutations`: keep `false` by default. Setting it to `true` does not replace per-run explicit authorization.
- Optional `liveScope.deferredAdapters`: developer-local Adapter IDs that the user explicitly chose not to live-test. Preserve their existing result, never promote them to PASS, and omit them from targeted live commands until the user removes the deferral. Use the structured `USER_EXCLUDED` reason code instead of free-form notes.
- `auth`: may store mode, login URL, and last verification time; never session material.
- `capabilities`: use business capability names such as `projects`, `workspaces`, or `roles`. Values remain local.
- `fixtures`: store only dedicated UAT/sandbox aliases and the minimum parameter bindings needed to find them. Mark reversibility and cleanup requirements.
- `pageContexts`: store non-sensitive site URLs or route patterns needed to establish a matching tab.

## Forbidden content

The validator rejects fields named like Cookie, token, authorization, password, secret, API key, access key, private key, credential, or session ID. Also exclude raw request/response bodies, downloaded business files, personal account IDs, local filesystem paths, and arbitrary free-form notes that could contain sensitive data.

## Updating a profile

1. Ask once for all missing login, permission, fixture, and page-context facts.
2. Show the intended non-secret fields before writing.
3. Modify only the selected profile.
4. Run `validate-profile`.
5. Rerun `plan`; only changed Adapter profiles should be scheduled for conditional recheck.
