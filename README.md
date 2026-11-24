# Cloudflare R2 Services Section

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

This section contains the repository's Cloudflare R2 mechanics: S3-compatible
SigV4 requests, content-addressed ownership, verified short-lived reads, and
free-tier admission.  It does not own a customer, an ActivityStreams contract,
or A2A validation; those are adapters supplied by their respective sections.
The immutable-custody adapter accepts an explicit `maximumBytes` and passes it
unchanged to the provider-neutral ownership owner; its default remains 8 MiB.

## From the copy in red-cup-engineering/cloudflare-engineering-services-section

This section contains the repository's Cloudflare R2 mechanics: S3-compatible
SigV4 requests, content-addressed ownership, verified short-lived reads, and
free-tier admission.  It does not own a customer, an ActivityStreams contract,
or A2A validation; those are adapters supplied by their respective sections.

## Git LFS object custody

`scripts/git-lfs-r2-transfer-agent.mjs` is a git-lfs standalone transfer agent that keeps a repository's LFS objects in a Cloudflare R2 bucket, so large binaries (PDFs, books, recordings, video) stay out of the git object database and out of GitHub's LFS metering; R2 bills per gigabyte-month and charges no egress. Objects are stored uncompressed, so a bucket object's SHA-256 equals its git-lfs object id and can be verified with any S3 client without git-lfs (`rclone cat :s3:<bucket>/<oid> | sha256sum` equals `<oid>`). Credentials are read from the repository `.env` at invocation and passed to the transfer program through the environment, never as arguments and never into git config. Which file patterns become LFS objects is declared by the repository-root `.gitattributes`. Bare Cedar Fog's bucket, credential names and custody law are in `data/records/git-lfs-custody-records/bare-cedar-fog/`.
