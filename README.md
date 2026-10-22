# Cloudflare R2 Services Section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

This section contains the repository's Cloudflare R2 mechanics: S3-compatible
SigV4 requests, content-addressed custody, verified short-lived reads, and
free-tier admission.  It does not own a customer, an ActivityStreams contract,
or A2A validation; those are adapters supplied by their respective sections.
The immutable-custody adapter accepts an explicit `maximumBytes` and passes it
unchanged to the provider-neutral custody owner; its default remains 8 MiB.
