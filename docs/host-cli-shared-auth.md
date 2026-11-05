# Shared authentication for host CLI providers

A fixed host provider may request unnamed cookies for the Adapter primary host or an exact host in the installed manifest's `runtime_allowed_hosts`. For example, an Adapter on `app.example.com` can declare `auth.example.org` when its host provider uses that service for account authentication. Wildcard helper patterns do not grant unnamed cookie access.

The Bridge verifies the installed builtin Adapter and original invocation. The extension independently captures exact helper hosts from the selected package manifest, binds them to the active host call, and returns only URL-matching, non-partitioned cookies. Caller payloads cannot add hosts, select another cookie store, or select a partition. Values stay in the host-only channel and are not returned to Adapter scripts.

Update the Bridge and extension together. Older extensions reject cross-site unnamed cookie requests; providers must fail without credential creation or fallback. Providers remain responsible for fixed authentication endpoints and shared secure-store account locks. This mechanism does not transfer business-specific credential logic to the public runtime.
