## MODIFIED Requirements

### Requirement: Workers record their results through the control plane

Background workers on the delivery and processing paths SHALL NOT hold their own connection to the registry database. The optimizer and the generator SHALL record their results by calling the control plane, so that the database is reachable only from the control-plane host.

Reclamation is exempt and SHALL run where the database is: it walks the whole registry and issues deployment-wide deletes, which is batch database work rather than a remote call.

#### Scenario: The optimizer completes a job

- **WHEN** the optimizer finishes generating an asset's warm set
- **THEN** it posts the version metadata and readiness in one call, and the control plane applies both in a single transaction

#### Scenario: The optimizer starts a job

- **WHEN** the optimizer receives a job from the queue
- **THEN** it fetches the job's context from the control plane, and a job whose asset is deleted, missing, or superseded is skipped without processing

#### Scenario: The generator writes a derivative

- **WHEN** the generator renders a derivative on a cache miss
- **THEN** it records the derivative through the control plane, and a failure of that call MUST NOT fail the viewer's request

#### Scenario: The control plane is unavailable when a derivative is generated

- **WHEN** the generator cannot reach the control plane
- **THEN** the derivative is still written to its canonical key and returned, and the missing record is reconciled later

#### Scenario: A worker is deployed without registry credentials

- **WHEN** the optimizer or generator starts
- **THEN** it holds no database connection string and no database secret

## ADDED Requirements

### Requirement: Reclamation runs adjacent to the database

Scheduled reclamation SHALL run on a host with direct database access and MUST NOT require the database to be reachable from outside that host.

#### Scenario: A reclamation run is scheduled

- **WHEN** the configured schedule elapses
- **THEN** reclamation runs to completion without the database accepting a connection from outside its private network

#### Scenario: A reclamation run overlaps the previous one

- **WHEN** a run is triggered while a previous run is still in progress
- **THEN** the new run does not start, and the overlap is recorded
