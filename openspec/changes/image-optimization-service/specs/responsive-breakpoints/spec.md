## ADDED Requirements

### Requirement: Fixed width ladder

The system SHALL define a single fixed ladder of permitted output widths comprising an icon range and a device range, and no derivative MAY be generated at a width outside this ladder except where capped by the source's intrinsic width.

#### Scenario: Ladder covers both icon and device scales

- **WHEN** the ladder is evaluated
- **THEN** it contains small icon widths beginning at 16 and device widths through 3840, so that thumbnails and avatars are not forced up to display-sized renditions

### Requirement: Requested widths snap up to the ladder

A requested width SHALL be mapped to the smallest ladder value greater than or equal to it.

#### Scenario: Width falls between ladder entries

- **WHEN** a request specifies `w=602`
- **THEN** the resolved width is 640

#### Scenario: Width just above a ladder entry

- **WHEN** a request specifies `w=641`
- **THEN** the resolved width is 750

#### Scenario: Width matches a ladder entry exactly

- **WHEN** a request specifies `w=1080`
- **THEN** the resolved width is 1080 with no adjustment

#### Scenario: Mid-range width

- **WHEN** a request specifies `w=980`
- **THEN** the resolved width is 1080

### Requirement: Delivered pixels never exceed the source width

Delivered bytes SHALL NOT exceed the source image's intrinsic width. Because the edge normalizer has no access to asset metadata, the canonical key is derived from the URL alone and MAY name a bucket wider than the source; the delivered image MUST still be capped at the source width.

#### Scenario: Request exceeds source dimensions

- **WHEN** `w=3840` is requested for a source that is 2000 pixels wide
- **THEN** the canonical key names the 3840 bucket, and the object stored at that key contains an image at most 2000 pixels wide

#### Scenario: Source is smaller than the smallest ladder entry

- **WHEN** a request is made against a 12-pixel-wide source
- **THEN** the delivered image is 12 pixels wide and no upscaled derivative is produced

#### Scenario: Client with access to asset metadata builds URLs

- **WHEN** the client SDK generates candidate URLs for an asset whose intrinsic width is known
- **THEN** it caps candidate widths at the largest ladder value not exceeding the source width, so oversized buckets are never requested in practice

### Requirement: Width is bounded above

A requested width greater than the ladder maximum SHALL be clamped to the ladder maximum before the source cap is applied.

#### Scenario: Absurdly large width requested

- **WHEN** a request specifies `w=99999`
- **THEN** the width is clamped to the ladder maximum, producing a valid bounded output capped at the source width

### Requirement: Device pixel ratio folds into width

The `dpr` parameter SHALL be multiplied into the requested width before snapping and MUST NOT appear as an independent dimension in the canonical key.

#### Scenario: Retina request

- **WHEN** a request specifies `w=400&dpr=2`
- **THEN** the effective width is 800, the resolved width is 828, and the canonical key is identical to that produced by `w=828&dpr=1`

#### Scenario: High DPR against a limited source

- **WHEN** a request specifies `w=1920&dpr=2` against a 1920-pixel-wide source
- **THEN** the effective width of 3840 resolves to the 3840 bucket, and the delivered image is capped at 1920 pixels wide

### Requirement: Aspect ratio is quantized instead of height

When both width and height are supplied, the system SHALL snap the width to the ladder and quantize the requested aspect ratio to a bounded set of ratios, deriving the output height from the resolved width and the quantized ratio. Height MUST NOT be snapped independently to the width ladder.

#### Scenario: Common ratio requested

- **WHEN** a request specifies `w=640&h=360`
- **THEN** the ratio is recognized as 16:9 and the output is 640x360

#### Scenario: Near-miss ratio within tolerance

- **WHEN** a request specifies `w=640&h=362`
- **THEN** the ratio quantizes to 16:9 within tolerance and the output is 640x360, sharing a cache key with the exact request

#### Scenario: Unusual ratio outside tolerance

- **WHEN** a request specifies a ratio matching no listed ratio within tolerance
- **THEN** the ratio is rounded to a bounded precision and the height is derived from the resolved width, keeping the total variant count finite

#### Scenario: Only height is supplied

- **WHEN** a request specifies `h=480` with no width
- **THEN** the height is snapped on the ladder and the width is derived from the source aspect ratio

#### Scenario: Only width is supplied

- **WHEN** a request specifies `w=640` with no height
- **THEN** the height is derived from the source aspect ratio and contributes no independent component to the canonical key

### Requirement: Quality is quantized

Requested quality SHALL be snapped to the nearest value in a small fixed set of levels. The levels are a perceptual scale shared across formats; translation into per-codec encoder settings MUST happen at encode time rather than in the requested value.

#### Scenario: Arbitrary quality requested

- **WHEN** a request specifies `q=82`
- **THEN** the quality resolves to the nearest permitted level and the canonical key contains that level

#### Scenario: Quality omitted

- **WHEN** quality is omitted for any negotiated format
- **THEN** the same nominal default applies, and each codec receives its own calibrated setting for that level

#### Scenario: Explicit quality against a modern format

- **WHEN** a request specifies `q=75` and the negotiated format is AVIF
- **THEN** the encoder receives AVIF's calibrated setting for that perceptual level, not a raw quality of 75, so the format's size advantage is retained

### Requirement: Effect parameters are quantized

Blur and sharpen values SHALL be snapped to fixed permitted levels, and background colors MUST be normalized to a canonical lowercase hexadecimal form.

#### Scenario: Arbitrary blur requested

- **WHEN** a request specifies a blur value between two permitted levels
- **THEN** it snaps to the nearest permitted level

#### Scenario: Background specified in mixed case

- **WHEN** a request specifies `background=FFAA00` and another specifies `background=ffaa00`
- **THEN** both normalize to the same value and share a cache key

#### Scenario: Background specified with a non-padding fit

- **WHEN** a background is supplied with a fit mode that never produces empty area
- **THEN** the background is dropped during normalization so it does not fragment the cache key

### Requirement: Canonical key is deterministic and shared

Normalization SHALL produce a single canonical string that serves simultaneously as the CDN cache key path and the S3 object key. The same normalization logic MUST govern both the edge and the generator.

#### Scenario: Equivalent requests collapse

- **WHEN** requests for `w=602`, `w=610`, `w=640`, and `w=320&dpr=2` are made against the same asset with all other parameters equal
- **THEN** all four produce the identical canonical key, a single cached object, and at most one generation

#### Scenario: Edge and generator agree

- **WHEN** the edge normalizer and the core normalization library are run against the shared conformance vectors
- **THEN** every vector produces identical output from both implementations

#### Scenario: Implementations disagree

- **WHEN** any conformance vector produces differing output between the edge normalizer and the core library
- **THEN** the build fails, because a divergence would cause the CDN to cache one key while the generator writes another

### Requirement: Bounded variant space

For a given asset version, the number of distinct derivatives reachable through the public delivery API SHALL be bounded by a fixed constant determined by the ladder, ratio set, quality levels, formats, and effect levels.

#### Scenario: Enumeration of reachable variants

- **WHEN** the reachable variant space for one asset version is enumerated
- **THEN** it is finite and computable from configuration alone, independent of how many distinct URLs clients construct

#### Scenario: Client requests thousands of distinct widths

- **WHEN** a client iterates every integer width from 1 to 4000 against one asset
- **THEN** the number of generations performed is bounded by the ladder size rather than by the number of requests
