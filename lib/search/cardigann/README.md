# Cardigann compatibility

`schema-v11.json` is pinned from Prowlarr Indexers commit
`b6af805b1441881354cb3f7422a7d6f2602efe24`:

<https://github.com/Prowlarr/Indexers/blob/b6af805b1441881354cb3f7422a7d6f2602efe24/definitions/v11/schema.json>

The upstream repository is MIT licensed. Keep the schema pinned and review schema
changes explicitly. TorPlay does not execute code from a definition or bundle a
pre-enabled catalog. **Explore Cardigann indexers** requests a community directory
only when the user browses; an individual selected YAML definition is imported,
validated against this schema, and stored privately. The directory revision is
held stable while selecting an entry. See [Torrent search providers](../../../docs/torrent-providers.md)
for supported operations, optional FlareSolverr transport, and verification.
