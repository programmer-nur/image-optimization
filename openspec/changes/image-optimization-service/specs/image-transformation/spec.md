## ADDED Requirements

### Requirement: EXIF orientation is applied before resizing

The processing pipeline SHALL apply the source image's EXIF orientation before any resize operation, and MUST NOT emit the orientation tag on output.

#### Scenario: Portrait photo with orientation tag 6

- **WHEN** a photo stored as 4000x3000 with EXIF orientation 6 is requested at `w=640`
- **THEN** the image is rotated to its upright 3000x4000 form first, then resized so the output is 640 pixels wide and correctly oriented

#### Scenario: Output carries no orientation tag

- **WHEN** any derivative is generated
- **THEN** the output contains no EXIF orientation tag, so no downstream viewer applies a second rotation

### Requirement: Metadata is stripped from derivatives

All derivatives SHALL be generated without EXIF, IPTC, XMP, or GPS metadata.

#### Scenario: Photo containing GPS coordinates

- **WHEN** a photograph containing GPS EXIF data is uploaded and a derivative is delivered
- **THEN** the delivered bytes contain no GPS data and no other EXIF blocks

### Requirement: Color is normalized to sRGB

The pipeline SHALL convert output to the sRGB colorspace rather than passing through a wide-gamut profile untouched, and MUST NOT attach a redundant ICC profile to sRGB output.

#### Scenario: Adobe RGB source image

- **WHEN** an image tagged Adobe RGB is processed
- **THEN** its pixel values are converted into sRGB so colors render correctly on standard displays, and the output carries no embedded profile

### Requirement: Resize fit modes

The pipeline SHALL support the fit modes `cover`, `contain`, `inside`, `outside`, and `fill`, with gravity applied only for `cover` — the one mode that discards source pixels. `pad` is an accepted request spelling that normalizes to `contain` before the key is built, because both reach the encoder as the same call and two keys would mean two objects holding one image.

#### Scenario: Cover fit with both dimensions

- **WHEN** a derivative is requested with `w=640&h=640&fit=cover`
- **THEN** the output is exactly 640x640 with the source scaled to fill and the overflow cropped according to the requested gravity

#### Scenario: Pad fit with a background color

- **WHEN** a derivative is requested with `fit=pad` and a background color
- **THEN** the full source is scaled to fit inside the target box and the remaining area is filled with the requested color

#### Scenario: Contain fit without a background on an opaque format

- **WHEN** `fit=contain` is requested targeting JPEG with no background specified
- **THEN** the configured default background is applied rather than producing an undefined or black fill

### Requirement: Upscaling is not performed

The pipeline SHALL NOT enlarge an image beyond its intrinsic dimensions.

#### Scenario: Requested size exceeds source dimensions

- **WHEN** a 800px-wide source is requested at `w=1920`
- **THEN** the output is at most 800 pixels wide, stored under the canonical key naming the requested bucket

### Requirement: Format encoding

The pipeline SHALL support JPEG, PNG, WebP, and AVIF output, each with format-appropriate encoder settings rather than a single shared quality number.

#### Scenario: Same nominal quality across formats

- **WHEN** `q=75` is requested for AVIF and for JPEG
- **THEN** each encoder receives its own calibrated setting for that quality level, because equal numeric quality values do not represent equal perceptual quality across codecs

#### Scenario: Source with alpha targeted at JPEG

- **WHEN** a PNG with transparency is requested as JPEG
- **THEN** the transparent regions are flattened onto the configured background color rather than rendering as black

#### Scenario: AVIF effort scales with output size

- **WHEN** an AVIF derivative larger than the configured effort-reduction threshold is generated
- **THEN** a lower encoder effort is used to bound generation time while retaining the format's size advantage

### Requirement: Optional effects

The pipeline SHALL support blur, sharpen, and background fill as optional operations applied only when explicitly requested.

#### Scenario: Blur is requested

- **WHEN** a derivative is requested with a blur value
- **THEN** a Gaussian blur with the corresponding sigma is applied after resizing and before encoding

#### Scenario: No effects are requested

- **WHEN** a derivative is requested with no effect parameters
- **THEN** no effect operation is invoked and the canonical key contains no effect component

### Requirement: Input safety limits

The pipeline SHALL enforce a maximum decoded pixel count and MUST fail closed on truncated input rather than emitting a partially decoded image.

#### Scenario: Image exceeding the pixel limit reaches the processor

- **WHEN** an image whose decoded size would exceed the configured pixel limit is processed
- **THEN** the operation aborts with a classified error and no unbounded memory allocation occurs

#### Scenario: Truncated source file

- **WHEN** the stored original is truncated or corrupt
- **THEN** processing fails with a `corrupt_source` classification rather than producing a half-rendered image

### Requirement: Large sources are read efficiently

The pipeline SHALL prefer a master rendition over the original whenever one exists, and SHALL bound peak memory by capping source size rather than by streaming: a worker reads the whole source object into memory, which is safe at the configured 100MB maximum against the workers' configured allocations. Raising that maximum without re-sizing the workers MUST be treated as a memory change rather than a limits change.

#### Scenario: Derivative generated from a very large original

- **WHEN** a derivative is requested for an asset whose original exceeds the master threshold and whose master exists
- **THEN** the pipeline decodes the master rather than the original, substantially reducing decode time and peak memory

#### Scenario: Source at the configured maximum size is rendered

- **WHEN** a derivative is generated from a source at the configured maximum upload size
- **THEN** the whole object is read into the worker's memory and rendered within its allocation, because the upload cap — not a streaming read — is what bounds this

### Requirement: Deterministic output

Given identical input bytes and an identical normalized transform specification, the pipeline SHALL produce byte-identical output for a fixed library version and encoder epoch.

#### Scenario: Same variant generated twice

- **WHEN** the same canonical key is generated on two separate invocations against the same source
- **THEN** the resulting bytes are identical, so concurrent generation races cannot produce divergent cached content
