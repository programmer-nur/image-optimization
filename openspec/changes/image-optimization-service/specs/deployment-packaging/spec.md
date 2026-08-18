## ADDED Requirements

### Requirement: Infrastructure is defined as code

The complete AWS footprint SHALL be defined in TypeScript infrastructure code and MUST be deployable without manual console steps beyond initial account bootstrapping and domain delegation.

#### Scenario: Fresh deployment into a clean account

- **WHEN** an operator configures the required settings and deploys
- **THEN** storage, distribution, edge function, queues, functions, database, container service, permissions, and monitoring are all created, and the service is functional end to end

#### Scenario: Infrastructure change is applied

- **WHEN** an operator changes a stack parameter and redeploys
- **THEN** the change is applied through the deployment tool and no drift is introduced by hand-editing resources

### Requirement: Stacks are separated by lifecycle

Infrastructure SHALL be organized into separate stacks by change frequency and blast radius, so that frequently changing compute can be deployed without touching stateful resources.

#### Scenario: Application code is redeployed

- **WHEN** only the application image or function code changes
- **THEN** the compute stack is updated while storage and database stacks remain untouched

#### Scenario: Stateful resource deletion is attempted

- **WHEN** a deployment would delete the storage bucket or database
- **THEN** the retention policy prevents accidental destruction of stored data

### Requirement: Configuration is validated at startup

Every component SHALL validate its configuration against a schema at startup and MUST fail fast with an explicit message when a required value is missing or malformed.

#### Scenario: Required setting is absent

- **WHEN** a required configuration value is not supplied
- **THEN** the process exits during startup naming the missing key, rather than failing later during a request

#### Scenario: Setting has the wrong shape

- **WHEN** a numeric setting is supplied as an unparseable string
- **THEN** startup fails with a message identifying the key and the expected type

### Requirement: Secrets are never in source or plain environment configuration

Database credentials and API signing material SHALL be delivered through a managed secret store and MUST NOT appear in the repository or in plain deployment parameters.

#### Scenario: Repository is scanned

- **WHEN** the repository is searched for credentials
- **THEN** none are present, and configuration references secret identifiers rather than values

#### Scenario: Container starts

- **WHEN** the control-plane container starts
- **THEN** it resolves its database credentials from the secret store at runtime

### Requirement: Custom domain provisioning

Deployment SHALL serve the CDN custom domain with a managed certificate and a DNS record pointing at the distribution. DNS is managed outside the infrastructure-as-code app, so provisioning is three phases — issue the certificate, deploy, then reconcile DNS — and the app itself SHALL create no DNS record and issue no certificate.

#### Scenario: Certificate is issued before deployment

- **WHEN** a certificate is needed for a hostname whose zone the deployment account does not hold
- **THEN** it is requested ahead of the deployment, its validation record is written into the external zone, and its ARN is supplied to the deployment as configuration

#### Scenario: Deployment publishes what DNS must point at

- **WHEN** the distribution and load balancer are deployed
- **THEN** each stack emits the hostname it answers to as an output, because those names are assigned at deploy time and a recorded copy goes stale the moment a stack is replaced

#### Scenario: DNS is reconciled after deployment

- **WHEN** DNS is reconciled against a deployed environment
- **THEN** the reconciler reads those outputs, reports the changes it would make before making any, leaves records it does not own untouched, and creates every record with CDN proxying disabled

#### Scenario: No custom domain is configured

- **WHEN** a deployment is made without a certificate
- **THEN** it succeeds and serves on the provider-assigned hostnames, so a first deployment does not require DNS to be settled first

### Requirement: Edge normalizer is generated during the build

The edge function SHALL be produced from the shared core library by a build step, and the build MUST fail when the generated function disagrees with the core library on the shared conformance vectors.

#### Scenario: Ladder is modified

- **WHEN** a developer changes the width ladder in the core library and builds
- **THEN** the edge function is regenerated from the new definition and both implementations pass the conformance suite

#### Scenario: Edge function is hand-edited

- **WHEN** the generated edge function is modified directly so that it diverges from the core library
- **THEN** the build fails on the conformance check rather than deploying a divergence that would silently destroy cache effectiveness

### Requirement: Database migrations run as a controlled step

Schema migrations SHALL execute as an explicit deployment step, MUST be forward-only during initial development, and MUST NOT run implicitly on container start in a way that allows concurrent instances to race.

#### Scenario: Deployment includes a schema change

- **WHEN** a release contains a migration
- **THEN** the migration runs once as a dedicated task before the new application version receives traffic

#### Scenario: Several instances start simultaneously

- **WHEN** multiple control-plane instances start at once
- **THEN** no instance attempts to apply migrations concurrently

### Requirement: Environment separation

The deployment SHALL support multiple named environments with fully isolated resources and no shared storage, database, distribution, or domain.

#### Scenario: Staging and production coexist

- **WHEN** two environments are deployed from the same source
- **THEN** each has its own bucket, database, distribution, domain, and queues, and neither can read the other's data

### Requirement: Lambda artifacts are built for their target runtime

Function artifacts containing native image-processing binaries SHALL be built for the exact target architecture and runtime, and the build MUST NOT rely on binaries resolved on a developer workstation.

#### Scenario: Developer on a different platform builds a release

- **WHEN** a release is built on a workstation whose platform differs from the function runtime
- **THEN** the produced artifact contains binaries matching the target architecture and executes correctly once deployed

#### Scenario: Deployed function is smoke-tested

- **WHEN** a deployment completes
- **THEN** an automated check invokes the deployed function against a known image and verifies a correct result, so native binary problems surface at deploy time rather than on first user traffic

### Requirement: Local development without cloud dependencies

The project SHALL provide a local environment covering database, object storage, and queueing so the control plane and processing logic can be run and tested without an AWS account.

#### Scenario: Contributor runs the stack locally

- **WHEN** a contributor starts the local environment and runs the service
- **THEN** uploads, processing, and metadata operations work against local substitutes for storage and queueing

#### Scenario: Core transform logic is tested

- **WHEN** the core library's tests run
- **THEN** they execute without any cloud service or local emulator, because the core contains no cloud dependencies

### Requirement: Bootstrap documentation

The repository SHALL document the complete path from empty AWS account to working deployment, including prerequisites, configuration, deployment order, verification, and the encoder epoch procedure.

#### Scenario: New project adopts the service

- **WHEN** an engineer follows the bootstrap documentation for a new project
- **THEN** they reach a working deployment with a custom CDN domain by following the documented steps

#### Scenario: Encoder policy must change after launch

- **WHEN** an operator needs to change encoder settings for already-published assets
- **THEN** the documented epoch procedure explains how to mint a new URL space, how consumers pick it up, and how superseded objects are reclaimed
