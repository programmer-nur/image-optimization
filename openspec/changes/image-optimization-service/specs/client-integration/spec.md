## ADDED Requirements

### Requirement: Typed URL builder

The client package SHALL provide a typed function that builds delivery URLs from an asset identifier, version, and transform options, and MUST reject options outside the supported grammar at compile time where the type system allows.

#### Scenario: Developer builds a URL

- **WHEN** a developer calls the builder with a width and fit mode
- **THEN** a correctly formed delivery URL against the configured CDN host is returned

#### Scenario: Developer supplies an unsupported fit mode

- **WHEN** a developer passes a fit value outside the enum
- **THEN** the code fails to type-check rather than producing a URL that errors at request time

### Requirement: Ladder-aligned srcset generation

The client SHALL generate `srcset` candidates drawn from the same width ladder the service buckets to, and MUST omit candidates exceeding the source's intrinsic width.

#### Scenario: srcset generated for a wide source

- **WHEN** a srcset is generated for a 3000-pixel-wide source
- **THEN** every candidate width is a ladder value at or below 3000, so no candidate triggers a wasteful or upscaled generation

#### Scenario: srcset generated for a narrow source

- **WHEN** a srcset is generated for a 500-pixel-wide source
- **THEN** candidates stop at the largest ladder value not exceeding 500

#### Scenario: Candidate widths align with buckets

- **WHEN** any generated candidate URL is requested
- **THEN** its width requires no snapping, so the browser's selected candidate maps directly to a stored object

### Requirement: Intrinsic dimensions are always emitted

The client's image component SHALL emit intrinsic width and height attributes so the browser reserves layout space before the image loads.

#### Scenario: Image renders in a page

- **WHEN** the component renders an asset with known intrinsic dimensions
- **THEN** width and height attributes are present and no layout shift occurs when the image loads

#### Scenario: Intrinsic dimensions are not yet known

- **WHEN** the component renders an asset still being processed
- **THEN** it falls back to a caller-supplied aspect ratio rather than omitting dimensional information entirely

### Requirement: Format fallback without markup branching

The client SHALL rely on server-side format negotiation for AVIF and WebP delivery rather than emitting per-format markup, while still supporting the picture element for art direction.

#### Scenario: Same URL served to browsers with different capabilities

- **WHEN** the same generated URL is requested by an AVIF-capable browser and by one that supports neither modern format
- **THEN** each receives an appropriate format from a single URL with no source elements required

#### Scenario: Art direction is required

- **WHEN** a developer needs a genuinely different crop at different breakpoints
- **THEN** the client supports composing a picture element with distinct sources per breakpoint

### Requirement: Loading priority controls

The client SHALL support marking an image as high priority, applying eager loading and high fetch priority, and SHALL default all other images to lazy loading with asynchronous decoding.

#### Scenario: Above-the-fold hero image

- **WHEN** an image is marked as priority
- **THEN** it is not lazily loaded, it carries a high fetch priority hint, and a preload hint including its candidate set and sizes can be emitted

#### Scenario: Below-the-fold image

- **WHEN** an image is rendered without the priority flag
- **THEN** it is lazily loaded and decoded asynchronously

### Requirement: Placeholder support

The client SHALL support rendering the stored low-quality placeholder inline while the full image loads, with no additional network request.

#### Scenario: Placeholder is available

- **WHEN** an asset's placeholder is present in its metadata
- **THEN** the component renders it inline as a blurred background and transitions to the loaded image, issuing no extra request for the placeholder

#### Scenario: Placeholder is absent

- **WHEN** no placeholder exists
- **THEN** the component renders a solid dominant-color background or nothing, according to the caller's choice

### Requirement: Next.js loader

The client SHALL provide a loader compatible with the Next.js image component so that optimization is delegated to this service rather than performed by the application server.

#### Scenario: Next.js application configures the loader

- **WHEN** an application configures the provided loader and renders images
- **THEN** requests are routed to this service's CDN domain and the application's own image optimization is not exercised

#### Scenario: Next.js requests a non-ladder width

- **WHEN** the framework requests a width not present on the ladder
- **THEN** the resulting URL still resolves correctly because the service snaps it, and the loader additionally aligns configured device sizes to the ladder to avoid the mismatch

### Requirement: Server-side upload helper

The client SHALL provide helpers for both the proxied and presigned upload flows, including presigned-target acquisition, direct upload, and completion.

#### Scenario: Backend uploads a file

- **WHEN** a backend calls the upload helper with a stream and content type
- **THEN** the helper selects the appropriate ingest mode by size, completes the flow, and returns the asset identifier, version, and delivery URLs

#### Scenario: Browser uploads a large file directly

- **WHEN** a browser uses the presigned helper for a large file
- **THEN** the bytes go directly to storage without transiting the application server, and progress can be observed

### Requirement: Framework-agnostic core

The URL building and srcset logic SHALL be usable without React or any framework, so non-React consumers can integrate.

#### Scenario: Plain server-rendered application integrates

- **WHEN** a non-React application imports the client
- **THEN** it can generate URLs, srcset strings, and sizes values without pulling in a UI framework dependency

### Requirement: Configuration is centralized

The client SHALL be configured once with the CDN host and defaults, and generated URLs MUST reflect that configuration everywhere.

#### Scenario: CDN host changes

- **WHEN** a deployment's CDN host is reconfigured in one place
- **THEN** all generated URLs across the consuming application reflect the new host without per-call-site edits
