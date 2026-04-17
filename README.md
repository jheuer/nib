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

The stock `axicli` stack is powerful but Python-based, and the EBB firmware's serial protocol is simple enough that a TypeScript implementation is straightforward. nib is that — built for code-first generative work:

- **Fast plots.** Native LM motion planning with trapezoidal acceleration and junction-velocity pipelining. Connected strokes don't stop at every internal corner.
- **Code-first API.** Compose polylines and primitives with a small `geom` module, plot from a script without SVG round-tripping.
- **Works in the browser.** WebSerial transport ships in the same package — no changes to your pipeline to go from Node to a web app.
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

Run `nib <command> --help` for full flag lists. `-v` / `--verbose` shows raw EBB commands on stderr.

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

### Offline stats / preview (no hardware)

```typescript
import { previewStatsFromSvg, strokeStats, geom } from 'nib'

// From an SVG
const stats = previewStatsFromSvg(svgString, profile, /* optimize */ 2)
// → { pendownM, travelM, travelOverheadPct, estimatedS, penLifts, boundingBoxMm, fitsA4, fitsA3 }

// From strokes
strokeStats(strokes)
// → { strokeCount, pointCount, pendownMm, bbox }
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
paper = "297x420mm"
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

See [`axidraw-cli-design.md`](./axidraw-cli-design.md) for the full schema.

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

See [`ebb-only-plan.md`](./ebb-only-plan.md) for the full design history and open work.

---

## References

- EBB firmware command reference: <https://evil-mad.github.io/EggBot/ebb.html>
- AxiDraw Python library (canonical reference for motion math): <https://github.com/evil-mad/axidraw>
- Inkscape layer control convention: <https://wiki.evilmadscientist.com/AxiDraw_Layer_Control>

## License

MIT.
