# nib

Ergonomic AxiDraw plotter control for TypeScript — a CLI, a Node library, and a browser library, all over native USB serial. No Python, no `axicli`.

```bash
nib plot drawing.svg --profile fineliner
```

```typescript
import { plotStrokes, geom } from 'nib'

await plotStrokes([
  geom.circle({ x: 50, y: 50 }, 20),
  geom.polyline(points),
], { profile: 'fineliner', optimize: 2 })
```

---

## Why

The stock `axicli` stack is powerful but Python-based, CLI-only, and has no browser story. nib speaks the EBB serial protocol directly from TypeScript and is built for code-first generative work:

- **Works in the browser.** WebSerial transport ships in the same package. Plot from a p5 sketch, a React app, or an interactive canvas — no Node, no server, no Python subprocess.
- **Live / streaming sessions.** `LivePlotter` keeps the port open and motors armed between submissions. Each `drawStroke()` call plots immediately; subsequent strokes queue if the arm is busy. Useful for interactive sessions where strokes arrive one at a time.
- **Fast plots.** Native LM motion planning with trapezoidal acceleration and junction-velocity pipelining. Connected strokes don't stop at every internal corner.
- **Code-first API.** Compose polylines and primitives with `geom`, render Hershey text directly to strokes, plot from a script without SVG round-tripping.
- **Typed errors.** Programmatic consumers get `PortNotFoundError`, `EnvelopeViolationError`, `DeviceDisconnectedError`, `ValidationError`, `ConfigError` — all subclasses of `NibError` with a `.code` field for `switch` dispatch.
- **Safe by default.** Machine-envelope bounds check, persistent position state across invocations, confirmation prompts before destructive commands.
- **No Python dependency.** Communicates directly with the EBB firmware via USB CDC serial (macOS, Linux today; Windows is possible with a serialport dep but not wired in).

---

## Install

```bash
bun add nib
# or: npm install nib
```

To install the CLI globally from a local checkout:

```bash
bun run build
ln -s "$(pwd)/dist/nib" ~/.local/bin/nib   # or copy it somewhere on your PATH
```

### Hardware prerequisites

- An AxiDraw V3, V3/A3, SE, V3XL, or Mini with a USB cable.
- macOS or Linux. On macOS, the EBB enumerates as `/dev/cu.usbmodem*`; on Linux, `/dev/ttyACM*`.
- EBB firmware **2.7+** recommended (enables LM motion and trapezoidal acceleration). Older firmware falls back to constant-velocity SM moves automatically.
- Read/write permission on the USB device (add your user to the `dialout` group on Linux if needed).

---

## CLI quickstart

```bash
# 1. Position the arm by hand at top-left of your paper
nib motors off     # release steppers so you can push the carriage

# 2. Park it, then lock in origin
nib motors on      # origin = wherever the arm is now

# 3. Calibrate pen height (first time only, then save to a profile)
nib calibrate fineliner

# 4. Preview before you commit paper + ink
nib preview drawing.svg --profile fineliner

# 5. Plot
nib plot drawing.svg --profile fineliner --optimize 2

# Ctrl-C at any time — emergency stop, pen up, return home
```

### Key commands

| Command | What it does |
|---|---|
| `nib plot <file>` | Plot an SVG. Flags: `--profile`, `--layer`, `--copies`, `--optimize`, `--dry-run`, `--guided`, `--list-layers` |
| `nib preview <file>` | Planner-driven stats: pen-down distance, travel, lifts, ETA, machine fit. No hardware. |
| `nib calibrate <profile>` | Interactive pen-height wizard. ↑/↓ for coarse, shift for fine. |
| `nib profile` | CRUD for pen profiles (list/show/create/set/clone/delete). |
| `nib pen up\|down\|cycle` | Manual servo control. Uses profile's pen positions if given. |
| `nib move --x N --y N` | Relative carriage move in mm. `--home` returns to tracked origin. |
| `nib home` | Walk back to tracked origin. |
| `nib position` | Show the tracked carriage position. |
| `nib motors on\|off` | Enable/disable steppers. `on` sets the current position as origin. |
| `nib job list\|show\|resume` | Persistent plot history; resume an aborted plot from its stop point. |
| `nib watch <file>` | Re-plot on SVG save. |
| `nib series <script>` | Run a generator script N times, plot each, prompt for paper change. |
| `nib fw` | Query EBB firmware version. |
| `nib machine register\|list\|current\|models` | Tag an EBB board (EEPROM `ST`/`QT`) and pick an envelope automatically when it's connected. |

Run `nib <command> --help` for full flag lists. `-v` / `--verbose` shows raw EBB commands on stderr.

### Visual preview

`nib preview <svg> --open` opens an HTML preview in the browser rendered at
real machine scale, with:

- Machine envelope outline
- Paper sheet (if configured) at its offset, with a subtle drop shadow
- To-scale AxiDraw schematic: black gantry rail, silver traverse arm, home block
- Strokes rendered at the profile's real nib width and ink colour
- Applied auto-rotate so what you see matches what will plot

Flags:
```bash
--rotate auto|none|90       # auto (default) fits portrait SVG → landscape envelope
--paper A4|A3|letter|WxH    # paper size for the overlay
--paper-orientation portrait|landscape
--paper-offset X,Y          # mm from home to paper top-left
--paper-color '#fdfcf7'     # paper sheet colour (try black for metallic pen previews)
--hide-envelope             # just the content, no machine chrome
```

### Multi-machine setup

If you drive multiple AxiDraws from one computer, tag each board:

```bash
nib machine register A3 --model V3A3 --description "studio A3"
# writes "A3" to the board's EEPROM (ST), saves a [machines.A3] config entry

nib machine register mini --model Mini --description "travel kit"
```

Plot just works after that — `nib plot` reads the connected board's EEPROM
tag (QT) at startup, picks the matching envelope, and prints `Machine: A3`
in the header. `nib machine current` shows the detected board.

---

## Library (Node)

### Plot a stroke list from code (no SVG)

```typescript
import { plotStrokes, geom } from 'nib'

const strokes = [
  geom.polyline(generateWaveform()),
  geom.circle({ x: 50, y: 50 }, 20),
  geom.rect(100, 30, 40, 20, 5, 5),   // rounded corners
]

await plotStrokes(strokes, {
  profile: 'v5',                       // name from ~/.config/nib/profiles.toml
  optimize: 2,                         // path reordering: 0/1/2
  onProgress: f => console.log(`${(f * 100).toFixed(0)}%`),
})
```

### Plot an SVG string

```typescript
import { plot } from 'nib'

const svg = generateSvgForSeed(42)
await plot(svg, { profile: 'fineliner' })
```

SVG support: `<path>`, `<line>`, `<rect>`, `<circle>`, `<ellipse>`, `<polyline>`,
`<polygon>`, `<text>` (Hershey Simplex), `<use>`. Full affine transform support
(`translate`, `rotate`, `scale`, `skewX`, `skewY`, `matrix`).

### Hershey text

Render single-stroke plottable text without touching an SVG:

```typescript
import { hersheyStrokes, hersheyTextWidth } from 'nib'

const strokes = hersheyStrokes('Hello world', x, y, fontSizeMm)
const w = hersheyTextWidth('Hello world', fontSizeMm)  // for centering / layout
```

`x, y` is the top-left of the cap-height box (not the baseline). `<text>` elements
in SVG use the same font automatically.

### Inline profile (no config-file lookup)

```typescript
import { plotStrokes, geom } from 'nib'

await plotStrokes([geom.circle({ x: 50, y: 50 }, 20)], {
  profile: {
    speedPendown: 30,
    speedPenup: 50,
    penPosDown: 15,
    penPosUp: 32,
    accel: 25,
  },
  optimize: 2,
})
```

### Utilities

```typescript
import { deduplicateStrokes, validateProfile, strokeStats } from 'nib'

// Remove exact-duplicate strokes (forward or reverse) within a mm tolerance
const clean = deduplicateStrokes(strokes, 0.1)

// Validate a profile object before passing it to plotStrokes
const errors = validateProfile(profile)   // string[] — empty means valid

// Stroke stats without hardware
strokeStats(strokes)
// → { strokeCount, pointCount, pendownMm, bbox }
```

### `geom` module

Pure functions that return `Stroke` objects:

```typescript
import { geom, type Stroke } from 'nib'

geom.line({ x: 0, y: 0 }, { x: 100, y: 50 })
geom.polyline(points)
geom.polygon(points)                                    // closed
geom.rect(x, y, w, h, rx?, ry?)                         // sharp or rounded
geom.circle({ x, y }, r)
geom.ellipse({ x, y }, rx, ry)
geom.arc({ x, y }, r, angleStart, angleEnd)
geom.bezier(p0, p1, p2, p3)                             // cubic
geom.quadBezier(p0, p1, p2)                             // quadratic

// Transform helpers
geom.translate(strokes, dx, dy)
geom.scale(strokes, 2)                                  // or { x, y }
geom.rotate(strokes, Math.PI / 4, pivot?)
```

### Typed errors

All error paths throw typed subclasses of `NibError`:

```typescript
import { NibError, PortNotFoundError, EnvelopeViolationError } from 'nib'

try {
  await plotStrokes(strokes, options)
} catch (e) {
  if (e instanceof PortNotFoundError) {
    console.error('No EBB device found — is the USB cable plugged in?')
  } else if (e instanceof EnvelopeViolationError) {
    console.error(`Move to (${e.x}, ${e.y}) exceeds machine envelope`)
  } else if (e instanceof NibError) {
    console.error(`Plotter error [${e.code}]: ${e.message}`)
  } else throw e
}
```

Error classes: `PortNotFoundError`, `EnvelopeViolationError`, `DeviceDisconnectedError`, `ValidationError`, `ConfigError`.

### Offline preview (no hardware)

```typescript
import { renderPreview, renderPreviewSvg, previewStatsFromSvg } from 'nib'

// Paint a to-scale plotter preview onto any CanvasRenderingContext2D
const stats = renderPreview(moves, ctx, {
  paper: { widthMm: 210, heightMm: 297 },
  envelope: { widthMm: 280, heightMm: 218 },
  inkColor: '#1a3a5c',
  showTravel: true,
})
// stats → { pendownM, travelM, penLifts, travelOverheadPct, contentMm }

// Same output as a self-contained SVG string (no DOM — works in Node, CI)
const svg = renderPreviewSvg(moves, options)

// Quick stats from an SVG string
const stats = previewStatsFromSvg(svgString, profile, /* optimize */ 2)
// → { pendownM, travelM, travelOverheadPct, estimatedS, penLifts, boundingBoxMm, fitsA4, fitsA3 }
```

---

## Library (browser)

nib ships a dedicated browser entry point that uses WebSerial and does not include any Node APIs. Available in Chrome, Edge, and Opera (WebSerial is not supported in Firefox or Safari).

```typescript
import { plotStrokes, geom, requestEbbPort } from 'nib/browser'

connectButton.addEventListener('click', async () => {
  const transport = await requestEbbPort()   // native USB device picker

  await plotStrokes([
    geom.circle({ x: 50, y: 50 }, 20),
    geom.rect(0, 0, 100, 100),
  ], {
    transport,
    profile: {
      speedPendown: 30, speedPenup: 50,
      penPosDown: 15, penPosUp: 32,
      accel: 25,
    },
    onProgress: f => progressBar.style.width = `${f * 100}%`,
    onStroke: i => console.log(`stroke ${i} done`),
  })

  await transport.close()
})
```

The transport is long-lived — one `requestEbbPort()` can host many plots. Call `transport.close()` when you're done.

### Live / streaming sessions

For interactive workflows — draw on a canvas, generative sketches that emit
strokes over time — use `LivePlotter`. It keeps the transport open and motors
enabled between stroke submissions, so each `drawStroke()` call plots
immediately without per-stroke setup/teardown.

```typescript
import { LivePlotter, requestEbbPort } from 'nib/browser'

const transport = await requestEbbPort()
const live = new LivePlotter(transport, {
  profile: { speedPendown: 25, speedPenup: 50, penPosDown: 35, penPosUp: 55, accel: 40 },
})
await live.start()

canvas.addEventListener('pointerup', async () => {
  await live.drawStroke(currentPoints)   // plots now; queues if arm is busy
})

// Track where the arm is at any point
console.log(live.currentPosition)   // { x: number, y: number } in mm

// later
await live.close()   // homes, disables motors, releases the port
```

### Examples

```bash
bun run example:canvas   # draw on an HTML canvas, strokes stream to the plotter
bun run example:p5       # p5.js flow-field — any p5 sketch can plot via nibCapture()
```

The p5 bridge (`examples/browser/p5/p5-nib.ts`) is a ~60-line monkey-patch of
`p5.line` / `p5.beginShape` / `p5.vertex` / `p5.endShape` / `p5.rect` that
silently captures strokes in mm. Drop it on any p5 instance and call
`capture.strokes()` to get the plottable list.

### Bring-your-own SerialPort

If you already have a `SerialPort` (e.g. auto-reconnecting via `navigator.serial.getPorts()`):

```typescript
import { WebSerialTransport } from 'nib/browser'

const port = savedPort ?? await navigator.serial.requestPort({
  filters: [{ usbVendorId: 0x04d8, usbProductId: 0xfd92 }],
})
await port.open({ baudRate: 115200 })
const transport = await WebSerialTransport.connect(port)
```

---

## Configuration

nib reads and writes two kinds of config on Node:

### Global — `~/.config/nib/`

- `profiles.toml` — named pen profiles (`fineliner`, `brush`, `v5`, …)
- `config.toml` — CLI defaults: default profile, default model, port, history limit

### Per-project — `axidraw.toml` (in the project root)

```toml
model = "V3A3"                      # machine envelope lookup
# envelope = "280x218"              # or explicit WxH
margin_mm = 5                       # safety inset on all sides
simplify_mm = 0.2                   # Douglas–Peucker tolerance (0 = off)

paper = "A4"                        # named or "210x297"
paper_orientation = "landscape"     # optional; flips natural size
paper_offset = "10,10"              # mm from home; shifts content into paper space
paper_color = "#fdfcf7"             # preview rendering

default_profile = "fineliner"

[[layers]]                          # multi-pen workflows
id = 1
name = "outlines"
profile = "fineliner"

[[layers]]
id = 2
name = "fills"
profile = "brush"
prompt = "Swap to brush (red)"

[preprocess]
steps = ["strip-fills", "center"]   # applied before plotting

[hooks]
on_complete = "terminal-notifier -message 'Done: {{file}}'"
```

Paper offset auto-translates content so SVG (0,0) lands at the paper's top-left
instead of the machine's home corner — i.e. "plot this SVG onto that sheet,"
which is almost always what you want. Add `--machine-origin` on the CLI to opt
out and work in raw machine coords.

### Layer conventions

nib follows the AxiDraw Inkscape layer convention. In Inkscape, name your layers `1 outline`, `2 fills`, `3 hatching`; prefix with `!` to skip:

```bash
nib plot --list-layers drawing.svg
# → # 1        outline
#   # 2        fills
#   # 3  SKIP  scratch notes

nib plot --layer 2 drawing.svg       # just the fills
nib plot --guided drawing.svg        # walk layers, pen-swap prompts
```

---

## Hardware details

### Position tracking

Each `nib` invocation starts fresh in software. The CLI persists carriage position to `~/.local/share/nib/state.toml` after every motor-touching command so subsequent plots know where the arm actually is. If position isn't at origin when you run `nib plot`, you'll get a warning with a hint to run `nib home` or pass `--yes`.

### Machine envelope

With `model = "V3A3"` (or `envelope = "280x218"`) in `axidraw.toml`, nib refuses to plot SVGs whose bounding box exceeds the machine's physical travel. Catches runaway generators before you hit the end-stop.

### Calibration caveats

- Pen percentages outside 20–60% can push the servo past the pen mechanism's mechanical travel. The `nib calibrate` defaults stay inside that range.
- The EBB firmware command `EM` has an **inverted** argument mapping: `EM,1,1` = 1/16 microstep, `EM,5,5` = full step. nib handles this; mentioned here because it's easy to miss when debugging.
- On some firmware (seen on 2.8.1), `SP,0` / `SP,1` can be silently no-op'd on repeated state transitions. nib always fires an `S2` direct-PWM command after `SP` to guarantee the servo moves.
- Board nickname commands are `ST`/`QT` (set/query tag). The similarly-named `SN`/`QN` commands are "Set/Query Node Count" — a different feature. `nib machine` uses ST/QT.

### Firmware compatibility

nib inspects the connected board's firmware version (`V` command) on connect
and exposes per-feature capability flags. Tested against **2.8.1** but also
handles older boards gracefully:

| Feature | Min firmware | Fallback if older |
|---|---|---|
| `LM` (trapezoidal moves) | 2.7.0 | SM constant-speed, no junction velocities |
| `QM` (motor-idle poll) | 2.4.4 | fixed sleep for planned duration |
| `ES` (emergency stop) | 2.2.7 | wait for FIFO drain on ^C |
| `HM` (firmware home) | 2.6.2 | resume-after-pause is disabled |
| `ST`/`QT` (nickname) | 2.0.0 | `nib machine` unavailable |

---

## How it works

```
 SVG or Strokes → svg-to-moves / strokesToMoves
                        ↓
                     reorder              (path ordering, NN + 2-opt)
                        ↓
                     planner              (trapezoid + junction velocities)
                        ↓
                     EbbCommands          (protocol layer, transport-agnostic)
                        ↓
           ┌────────────┴────────────┐
           ↓                         ↓
  NodeSerialTransport       WebSerialTransport
  (stty + fs.createReadStream)     (SerialPort.readable/writable)
```

- **`src/core/`** — planner, reorder, geom, envelope, state, svg-layers. All pure, browser-safe.
- **`src/backends/`** — `ebb-protocol.ts` (EbbCommands), `transport.ts` (interface), `node-serial.ts` (Node transport), `web-serial.ts` (browser transport), `ebb.ts` (EBBBackend + runMoves/runStrokes/runJob).
- **`src/cli/`** — the `nib` command-line interface. Node-only.
- **`src/tui/`** — terminal formatting helpers for the CLI.

---

## References

- EBB firmware command reference: <https://evil-mad.github.io/EggBot/ebb.html>
- AxiDraw Python library (canonical reference for motion math): <https://github.com/evil-mad/axidraw>
- Inkscape layer control convention: <https://wiki.evilmadscientist.com/AxiDraw_Layer_Control>

## License

MIT © 2026 Jeff Heuer
