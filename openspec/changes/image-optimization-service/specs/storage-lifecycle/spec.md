## ADDED Requirements

### Requirement: Prefix layout

Object storage SHALL be partitioned into four prefixes with distinct trust levels and lifecycle policies: staging for untrusted uploads, originals for immutable sources, masters for optional intermediates, and derivatives for delivery artifacts.

#### Scenario: Object placement is inspected

- **WHEN** an asset has been uploaded and processed
- **THEN** its untrusted bytes are gone from staging, its source resides under the originals prefix, any intermediate resides under the masters prefix, and every deliverable resides under the derivatives prefix

#### Scenario: Only derivatives are CDN-readable

- **WHEN** the distribution's read permissions are inspected
- **THEN** only the derivatives prefix is readable, so staging, originals, and masters are unreachable from the public internet

### Requirement: Keys embed asset and version

Storage keys SHALL include the asset identifier and version so that all objects belonging to one asset version can be enumerated and removed by prefix.

#### Scenario: Version-scoped cleanup

- **WHEN** a superseded asset version is to be removed
- **THEN** all of its objects are addressable by a single prefix and can be deleted without a per-object lookup

### Requirement: Staging expiry

Objects under the staging prefix SHALL expire automatically within a short window, and incomplete multipart uploads MUST be aborted automatically.

#### Scenario: Upload is abandoned after presigning

- **WHEN** a client obtains a presigned target, uploads bytes, and never calls completion
- **THEN** the staged object is removed by lifecycle policy within the configured window and the corresponding pending asset record is reaped

#### Scenario: Multipart upload is abandoned midway

- **WHEN** a multipart upload is started and never completed or aborted
- **THEN** the incomplete parts are aborted automatically so they do not accrue storage charges indefinitely

### Requirement: Storage class transitions for originals

Originals SHALL transition to cheaper storage classes on a configurable schedule, remaining retrievable without restore delay.

#### Scenario: Original ages past the first threshold

- **WHEN** an original passes the configured infrequent-access age
- **THEN** it transitions to the infrequent-access class while remaining immediately retrievable for master or derivative generation

#### Scenario: Original ages past the archival threshold

- **WHEN** an original passes the configured archival age
- **THEN** it transitions to an instant-retrieval archival class, so generation from it still succeeds without a restore step

### Requirement: Derivatives remain in standard storage

Derivative objects SHALL remain in a storage class optimized for frequent access and MUST NOT be transitioned to classes that add per-request retrieval cost.

#### Scenario: Frequently served derivative ages

- **WHEN** a derivative has existed beyond the originals' transition thresholds
- **THEN** it remains in standard storage, because retrieval-priced classes would add cost to every cache miss

### Requirement: Superseded version retention

Derivatives belonging to a superseded asset version SHALL be retained for a configurable grace period and then removed.

#### Scenario: Source is replaced and HTML is still cached

- **WHEN** an asset's source is replaced while consumer pages still reference the previous version's URLs
- **THEN** the previous version's derivatives continue to serve for the retention window rather than immediately breaking those pages

#### Scenario: Grace period elapses

- **WHEN** the retention window for a superseded version expires
- **THEN** that version's derivatives and original are removed and its bookkeeping rows are cleared

### Requirement: Deletion propagates across all layers

Deleting an asset SHALL remove its objects from every prefix, mark its registry rows deleted, and invalidate its cached representations.

#### Scenario: Asset with many derivatives is deleted

- **WHEN** an asset with derivatives across several versions and formats is deleted
- **THEN** every object under its key prefixes is removed, the registry marks it deleted, and a wildcard invalidation is issued for its delivery path

#### Scenario: Deletion request is repeated

- **WHEN** deletion is invoked again for an already-deleted asset
- **THEN** the operation succeeds idempotently without error

### Requirement: Orphan collection

A scheduled maintenance job SHALL reconcile stored objects against the registry and remove objects that belong to no live asset version.

#### Scenario: Objects remain after a partially failed deletion

- **WHEN** deletion fails partway and leaves objects behind
- **THEN** the next reconciliation run identifies them as orphans and removes them

#### Scenario: A live asset's objects are examined

- **WHEN** reconciliation encounters objects belonging to a current, non-deleted asset version
- **THEN** they are left untouched

#### Scenario: Reconciliation encounters a recently written object

- **WHEN** an object was written within the safety window before the run
- **THEN** it is skipped, so a derivative generated concurrently with reconciliation is never mistaken for an orphan

### Requirement: Storage accounting

The service SHALL track byte totals per asset and in aggregate, distinguishing originals, masters, and derivatives.

#### Scenario: Operator reviews storage growth

- **WHEN** an operator inspects storage metrics
- **THEN** totals are reported separately for originals, masters, and derivatives, so the cost effect of warm-set configuration is directly visible

### Requirement: Encryption at rest

All stored objects SHALL be encrypted at rest, and the bucket MUST deny unencrypted writes.

#### Scenario: Object is written

- **WHEN** any component writes an object
- **THEN** it is encrypted at rest by default with no per-request configuration required
