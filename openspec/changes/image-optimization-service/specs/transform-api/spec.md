## ADDED Requirements

### Requirement: Delivery URL shape

The public delivery URL SHALL take the form `/i/{assetId}/{version}/{slug}` with transformation expressed entirely as query parameters. The `{slug}` segment is optional decoration and MUST NOT affect which bytes are returned.

#### Scenario: Two different slugs on the same asset

- **WHEN** `/i/abc123/v3-1/red-shoes?w=640` and `/i/abc123/v3-1/chaussures-rouges?w=640` are requested
- **THEN** both resolve to the same normalized path, the same cache key, and the same stored object

#### Scenario: Slug is omitted

- **WHEN** `/i/abc123/v3-1?w=640` is requested
- **THEN** it resolves identically to the same request with any slug present

### Requirement: Supported parameters

The transform API SHALL accept exactly the parameters `w`, `h`, `q`, `fit`, `format`, `crop`, `background`, `blur`, `sharpen`, and `dpr`. Each MUST have a defined type, range, and default.

#### Scenario: All parameters omitted

- **WHEN** a delivery URL is requested with no query parameters
- **THEN** the asset is served at its intrinsic dimensions using the default fit, the default quality for the negotiated format, and no effects

#### Scenario: Parameter outside its permitted range

- **WHEN** a request specifies `q=250`
- **THEN** the value is clamped to the maximum permitted quality rather than rejected, because clamping keeps a slightly wrong URL working

#### Scenario: Parameter with an invalid enum value

- **WHEN** a request specifies `fit=squish`
- **THEN** the request is rejected with `400` and a short cache lifetime, because silently substituting a fit mode would deliver a visually wrong image

### Requirement: Inert parameters are elided from the canonical key

A parameter that cannot affect the output for a given request SHALL be dropped during normalization, so that requests producing identical pixels produce identical cache keys.

#### Scenario: Fit supplied with only one dimension constrained

- **WHEN** `?w=640` and `?w=640&fit=cover` are requested, and separately `?h=480` and `?h=480&fit=contain`
- **THEN** each pair produces one shared canonical key, because with a single dimension the resize is proportional and no fit mode can change the output

#### Scenario: Background supplied with a non-padding fit

- **WHEN** a background color is supplied alongside a fit mode that never leaves empty area
- **THEN** the background is dropped from the canonical key

#### Scenario: Effects supplied at their identity level

- **WHEN** a request specifies a blur or sharpen level of zero
- **THEN** no effect component appears in the canonical key

### Requirement: Unknown parameters are ignored

The transform API SHALL ignore query parameters it does not recognize, and unrecognized parameters MUST NOT contribute to the cache key.

#### Scenario: Analytics parameter appended to an image URL

- **WHEN** `/i/abc123/v3-1?w=640&utm_source=newsletter` is requested
- **THEN** the tracking parameter is discarded during normalization and the request resolves to the same cache key as `?w=640` alone

### Requirement: Parameter order does not matter

Requests differing only in query parameter order or in the letter case of enum values SHALL resolve to the same canonical key.

#### Scenario: Reordered and re-cased parameters

- **WHEN** `?w=640&fit=cover&q=75` and `?q=75&fit=COVER&w=640` are requested
- **THEN** both produce the identical canonical key and are served from the same cached object

### Requirement: Absolute pixel crops are not a public parameter

The public `crop` parameter SHALL accept only named gravity values. Arbitrary pixel rectangles MUST NOT be expressible in a delivery URL.

#### Scenario: Attempt to pass a pixel rectangle

- **WHEN** a request specifies `crop=100,200,300,400`
- **THEN** the request is rejected with `400`, because arbitrary rectangles would reintroduce an unbounded cache-key space

#### Scenario: Named gravity is used

- **WHEN** a request specifies `crop=attention` together with `fit=cover`
- **THEN** the crop region is selected by the processor's attention heuristic and the gravity forms part of the canonical key

### Requirement: Validation occurs at the edge

Parameter validation and normalization SHALL occur before any origin request is made, so that malformed requests consume no storage or compute.

#### Scenario: Malformed request arrives

- **WHEN** a request contains an unparseable parameter value
- **THEN** the edge returns an error response directly without contacting the origin, without invoking any generator, and without creating any object

### Requirement: Error responses are cached briefly

Error responses on the delivery plane SHALL carry a short cache lifetime, and generation failures MUST NOT be cached at all.

#### Scenario: Request for a nonexistent asset

- **WHEN** a delivery URL references an asset identifier that does not exist
- **THEN** a `404` is returned with a short cache lifetime, so that an asset later created at that identifier becomes visible promptly

#### Scenario: Generator fails while producing a variant

- **WHEN** derivative generation fails
- **THEN** the response is a `502` marked non-storable, so a transient failure is never persisted at the edge

### Requirement: Extensibility without cache invalidation

New transform parameters SHALL be additive with an identity default: adding a parameter MUST NOT change the canonical key produced by any URL that omits it.

#### Scenario: A new parameter is introduced

- **WHEN** a new optional parameter is added to the grammar and a previously cached URL that omits it is requested
- **THEN** the canonical key is unchanged and the existing cached object continues to be served

#### Scenario: A change would alter existing keys

- **WHEN** a change to normalization or encoder policy would alter the canonical key of existing URLs
- **THEN** the change is accompanied by an encoder epoch increment rather than shipped silently

### Requirement: Control-plane and delivery-plane separation

The delivery URL SHALL be served from the CDN domain and MUST NOT require authentication for public assets, while all write operations remain on the authenticated API domain.

#### Scenario: Unauthenticated delivery request

- **WHEN** a browser requests a delivery URL with no credentials
- **THEN** the image is served normally

#### Scenario: Write attempted against the CDN domain

- **WHEN** a client attempts a mutating request against the CDN domain
- **THEN** the request is rejected, because the delivery distribution permits only safe read methods
