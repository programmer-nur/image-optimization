## ADDED Requirements

### Requirement: The internal worker surface is authenticated and isolated

The control plane SHALL expose a route prefix used only by background workers, authenticated by a shared secret compared in constant time. That prefix MUST NOT be reachable with an API key, and API-key routes MUST NOT be reachable with the worker secret.

#### Scenario: A worker calls an internal route with the correct secret

- **WHEN** a worker presents the configured secret
- **THEN** the request is served

#### Scenario: A worker calls an internal route with a wrong or absent secret

- **WHEN** the secret is missing, empty, or incorrect
- **THEN** the request is rejected with `401` and no registry read or write occurs

#### Scenario: A customer API key is presented to an internal route

- **WHEN** a valid API key is presented to the internal prefix
- **THEN** the request is rejected, because the two credential types are not interchangeable

#### Scenario: The worker secret is not configured

- **WHEN** the control plane starts with no worker secret set
- **THEN** startup fails rather than serving the internal prefix unauthenticated

### Requirement: The database is not reachable from the public internet

The registry database SHALL accept connections only from the control-plane host's private network, and MUST NOT be exposed publicly.

#### Scenario: A connection is attempted from outside

- **WHEN** a client attempts to connect to the database from any address outside its private network
- **THEN** the connection does not succeed

#### Scenario: The control plane connects

- **WHEN** the control plane opens a connection over its private network
- **THEN** the connection succeeds and requires TLS

## MODIFIED Requirements

### Requirement: Rate limiting on the control plane

The control plane SHALL limit request rates per client. Where no managed web application firewall is attached to the host, the limit SHALL be enforced in the application and the host firewall SHALL restrict inbound traffic to the ports the control plane serves.

The application port SHALL NOT be reachable except through the local reverse proxy, since the limiter identifies a client by a proxy-set header.

The delivery plane carries no web application firewall and MUST NOT depend on one: its protection is structural — the edge refuses an unbucketed width without an origin fetch, and the generator's concurrency is capped.

#### Scenario: A client exceeds the configured rate

- **WHEN** a client issues requests above the configured rate
- **THEN** further requests are rejected with `429` until the window elapses

#### Scenario: Inbound traffic to an unused port

- **WHEN** a connection is attempted to a port the control plane does not serve
- **THEN** the host firewall refuses it

#### Scenario: The application port is probed directly

- **WHEN** a client attempts to reach the control plane's application port from outside the host
- **THEN** the connection is refused, so the limiter's source attribution cannot be forged

#### Scenario: An unbucketed delivery width is requested

- **WHEN** a viewer requests a width that is not on the ladder
- **THEN** the edge normalizes it to a ladder rung before any origin is contacted, bounding the variant space without a web application firewall
