## ADDED Requirements

### Requirement: The control plane host is replaceable

The control plane SHALL be deployable to any host that can run its container image, and MUST NOT depend on a capability specific to one hosting service. The application SHALL hold no local state: no data written to local disk that outlives a request, no in-process cache another replica would need to see, and no session affinity.

#### Scenario: The application reads its database configuration

- **WHEN** the control plane starts
- **THEN** it obtains its connection string from `DATABASE_URL` alone, and no code path is aware of which service hosts the database

#### Scenario: The host is changed

- **WHEN** the control plane is moved to a different compute service
- **THEN** the same image is deployed with the same environment, and no domain or business logic is modified

#### Scenario: A second replica is started

- **WHEN** two instances of the image run against one database
- **THEN** neither depends on local state held by the other, and requests may be served by either

### Requirement: Delivery survives a control-plane outage

Image delivery SHALL NOT depend on the availability of the control plane or its database. A viewer request for a derivative that does not yet exist MUST still be generated and persisted while the control plane is unavailable.

#### Scenario: The control plane is down and a cached derivative is requested

- **WHEN** the control plane is unreachable and a viewer requests an already-generated derivative
- **THEN** it is served from CloudFront or S3 with no error

#### Scenario: The control plane is down and an ungenerated derivative is requested

- **WHEN** the control plane is unreachable and a viewer requests a derivative that has never been generated
- **THEN** the generator renders it, writes it to its canonical key, and returns it; only the bookkeeping record is missed

#### Scenario: Bookkeeping was missed during an outage

- **WHEN** reclamation next runs and finds a derivative object with no registry row
- **THEN** it treats a recently written object as live rather than as an orphan, and does not delete it

### Requirement: The control plane terminates TLS with automatically renewed certificates

The control plane SHALL serve HTTPS on its public hostname, and certificate renewal MUST NOT depend on a scheduled action an operator can forget.

#### Scenario: A certificate approaches expiry

- **WHEN** the serving certificate is within its renewal window
- **THEN** it is renewed without operator action and without a service restart

#### Scenario: A plain HTTP request arrives

- **WHEN** a client connects over HTTP to the control-plane hostname
- **THEN** it is redirected to HTTPS

### Requirement: The control plane restarts without intervention

The control plane SHALL restart automatically after a crash or a host reboot, and its health MUST be observable from outside the host.

#### Scenario: The process exits unexpectedly

- **WHEN** the API container exits with a non-zero status
- **THEN** it is restarted automatically

#### Scenario: The host reboots

- **WHEN** the instance is restarted
- **THEN** the control plane comes back without an operator logging in

#### Scenario: Liveness is probed

- **WHEN** `GET /healthz` is requested
- **THEN** it answers `200` without authentication and without touching the database

### Requirement: Database backups are recoverable, and recovery is exercised

The database SHALL be backed up automatically, and a documented restore procedure MUST exist that has been followed end to end rather than only written down.

#### Scenario: A backup is taken

- **WHEN** the configured backup window elapses
- **THEN** a recoverable snapshot exists without operator action

#### Scenario: A restore is performed

- **WHEN** an operator follows the documented restore procedure
- **THEN** a working database is produced and the control plane serves against it after a single configuration change

### Requirement: Large uploads bypass the control-plane host

Uploads above the configured proxy threshold SHALL be written by the client directly to object storage, and MUST NOT be streamed through the control-plane host.

#### Scenario: A file above the proxy threshold is uploaded

- **WHEN** a client uploads a file larger than `UPLOAD_PROXY_THRESHOLD_BYTES`
- **THEN** the control plane issues a presigned target and the bytes never transit the control-plane host

#### Scenario: A file above the proxy threshold is posted to the proxied endpoint

- **WHEN** a client posts an oversized body to the multipart endpoint
- **THEN** the request is rejected with `413` and the presigned flow is named in the error
