# Cloudflare R2 Services Section

This section contains the repository's Cloudflare R2 mechanics: S3-compatible
SigV4 requests, content-addressed custody, verified short-lived reads, and
free-tier admission.  It does not own a customer, an ActivityStreams contract,
or A2A validation; those are adapters supplied by their respective sections.
The immutable-custody adapter accepts an explicit `maximumBytes` and passes it
unchanged to the provider-neutral custody owner; its default remains 8 MiB.
