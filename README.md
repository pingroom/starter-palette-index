# PingRoom palette index

Choose a constrained display's target palette through PingRoom, then convert a small RGB array into palette indices locally. One named operator selects the destination palette; code maps every pixel and records exact numerical errors. The example is a six-pixel practice badge.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or later:

```sh
npm ci
npm test
npm run demo
```

The demo exercises the pinned SDK against an in-memory transport: monochrome conversion, accent-color conversion and Unknown. It requires no credentials and makes no network calls. Tests also run the actual CLI in temporary directories.

## Define the asset and destinations

```sh
cp examples/asset.json asset.json
cp config.example.json config.json
npm run preview
```

Edit `asset.json` before starting. Supply `assetId`, `title`, `usage`, `width`, `height`, `pixels` and `palettes`. Width and height are positive integers whose product is at most 256. Each pixel is exactly `[red, green, blue]`, with integer channels 0–255. List pixels in row-major order: left to right, then top to bottom. The array length must equal width × height.

Provide two or three palettes. Each has a unique `id`, a `label` distinct ignoring case, a short destination `purpose` and an ordered `colors` array of 1–16 RGB triples. Keep entry order identical to the destination device or catalog. Duplicate RGB entries are allowed and remain distinct indices. IDs and labels must not conflict with Unknown.

Export these arrays from your asset pipeline, using a common encoded RGB convention and handling transparency upstream. This starter does not open, decode, render or inspect image files, verify device catalogs, or send pixel/color arrays to PingRoom.

The operator consults the device specification or palette catalog. The Question shows asset identity, dimensions, use, palette names, purposes and entry counts, with source/policy hashes in metadata; it contains no palette RGB values or preview. Choose Unknown if the destination cannot be established.

## Connect and select

```sh
npm run connect
npm run inspect
```

`connect` prints installation and pairing links. Approve a standard private room containing the operator. Run `inspect`, verify the intended person in the app, then put their exact member UUID and a descriptive label in `config.json`. Names alone do not establish identity. Credentials remain in ignored `.pingroom/`.

For an existing connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. If either is present in the shell, both must come from the shell. Partial pairs never borrow values from another source.

```sh
npm start
# The operator taps a palette button; then run again:
npm start
npm run status
npm run report
npm run export
```

Each session creates at most one direct Question, lasting 15 minutes. Run again to read the response; there is no automatic polling or resend. A valid palette response produces the conversion. Unknown, pending, missing, expired, cancelled or invalid answer evidence withholds conversion and complete export. There is no fallback palette.

## Mapping and output

For pixel `(r,g,b)` and palette entry `(R,G,B)`, code minimizes:

```text
(r-R)² + (g-G)² + (b-B)²
```

Equal distances choose the lowest original zero-based palette index. No colors are invented or palette entries reordered. This is squared distance between encoded channel values, with equal channel weights. It is not a perceptual or color-managed metric. There is no gamma conversion, dithering, alpha processing, PNG encoder or device transfer.

`report` writes private `.palette/report.json`, including partial evidence. `export` writes `.palette/indexed.json` only after a valid known selection. The artifact includes the immutable source, chosen palette, dimensions, row-major indices, per-pixel squared errors, palette-entry use counts and attributed Question evidence. Reconstruct a pixel as `conversion.palette.colors[conversion.indices[y * width + x]]` in your own consumer.

Metrics include exact/changed pixel counts, squared-error sums per channel, total squared error and maximum per-pixel squared error. Mean squared error per pixel is total error divided by pixel count; mean per channel divides by three times pixel count. They are unreduced exact `{numerator, denominator}` fractions. All calculations remain exact integers under the bounds: maximum total error is 49,939,200. Metrics describe supplied byte arrays, not visual quality or suitability for a display.

Palette objects canonicalize by ID, so rearranging that outer array preserves identity. Pixel order, channel order, palette-entry order, dimensions and descriptions remain bound. `sourceHash` binds the complete canonical input; `policyHash` binds the mapping rules. Local hashes detect changes relative to saved data, not an independently authenticated history. `imageFilesInspected: false` describes application code; `pixelsSent: false` means no RGB arrays go to PingRoom. Metadata still leaves the machine.

Adapt your upstream export to `asset.json`, then review and consume the indexed artifact. `indexPixels` is a pure numeric helper; use the export command when the operator's recorded choice is required. Version `POLICY` and start a new session when changing mapping rules. No downstream execution follows export.

## Recovery and bounds

For `create_unknown`, keep state:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

Recover only the original Question. An empty bounded recent search does not prove creation failed. Terminal failures remain recorded. Resolve pending/uncertain work before archiving `.palette/` for a new session. Resolve or revoke uncertain pairing in Connected Agents before archiving its pending record.

Run/recover exit codes: `0` complete; `2` Unknown/incomplete or a newly invalid, expired or cancelled answer; `3` ready/pending/interrupted; `4` uncertain creation; `1` setup, provenance or operational error. Offline status/report success exits `0`; inspect JSON status.

Metadata limits: asset ID 40 characters; palette ID 16; title 40, usage 60, palette label 20 and purpose 24 UTF-16 units. Text must be trimmed, well-formed, single-line Unicode without control/format characters. Input/config/state/HTTP caps are 64 KiB/16 KiB/1 MiB/512 KiB; transport deadlines are five seconds.

Private output and credential files use `0600`, directories `0700`, with atomic writes and local locks. Remove a stale lock only after its process stops. Inputs are ignored but keep their existing file permissions. SDK `0.7.1` is pinned with a lockfile; `.npmrc` requests a 14-day minimum release age where npm supports it. MIT licensed; mock CI runs Node.js 22 and 24.
