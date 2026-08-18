## MODIFIED Requirements

### Requirement: API keys are stored hashed

API keys SHALL be persisted only as hashes, and the plaintext value MUST be shown exactly once at creation. The hash is an unsalted SHA-256 of the whole key: the secret half is 32 bytes from a cryptographic RNG, so there is no dictionary for a salt to defeat and no password-stretching to do. A key store holding user-chosen secrets would require both.

Every key SHALL belong to exactly one tenant, and that attribution SHALL be immutable — moving a key between tenants would silently change what it can already reach.

#### Scenario: Key is created

- **WHEN** an administrator creates a key
- **THEN** it is attributed to a tenant at creation, only its hash is stored, and the plaintext is returned exactly once

#### Scenario: Stored key material is inspected

- **WHEN** the key table is read
- **THEN** no plaintext key is recoverable from it

### Requirement: Authenticated write operations

All mutating control-plane endpoints SHALL require a valid API key, and every operation SHALL act only on the tenant that key belongs to. Delivery of public assets MUST NOT require authentication.

#### Scenario: Upload without credentials

- **WHEN** an unauthenticated client attempts to upload
- **THEN** the request is rejected with `401` and no asset record is created

#### Scenario: Delete with a valid key

- **WHEN** a client presents a valid API key with delete permission for an asset its tenant owns
- **THEN** the deletion proceeds

#### Scenario: Delete of another tenant's asset

- **WHEN** a client presents a valid key with delete permission for an asset owned by a different tenant
- **THEN** the response is `404` and nothing is deleted, because a `403` would confirm the asset exists

#### Scenario: Public image is fetched anonymously

- **WHEN** a browser requests a public delivery URL with no credentials
- **THEN** the image is served
