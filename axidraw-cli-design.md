# axidraw — Design Spec for an Ergonomic AxiDraw CLI

A Bun CLI wrapper around `axicli` that adds profiles, persistent config, guided multi-pen workflows, watch mode, and job history. The goal is to eliminate the friction of repeated flag-typing and manual coordination that makes the official CLI exhausting to use in a real plotting session.

## What This Is Not

- Not a reimplementation of the EBB serial protocol
- Not a dependency on `@thi.ng/axidraw` (too idiosyncratic, alpha, ecosystem lock-in)
- Not a GUI

The hardware layer is `axicli` (Python), invoked as a subprocess. This tool handles everything `axicli` punts on: UX, persistence, workflow, and state.

---

## Architecture

```
axidraw (Bun CLI)
├── profiles.toml         ~/.config/axidraw/profiles.toml
├── axidraw.toml          per-project config (optional)
└── jobs/                 ~/.local/share/axidraw/jobs/
    ├── 0004.toml
    └── ...

        ↓ subprocess

axicli (Python)           handles SVG parsing, EBB protocol, hardware
```

Commands are treated as serializable data internally — the command sequence is built and inspected before being handed to `axicli`. This makes dry-run, preview stats, and job logging trivial.

---

## Command Structure

```
axidraw plot <file>         Plot an SVG file
axidraw preview <file>      Simulate and report stats, no hardware
axidraw watch <file>        Re-plot when file changes
axidraw pen up|down|cycle   Manual pen control
axidraw move [options]      Move carriage to position
axidraw home                Return carriage to origin
axidraw profile <cmd>       Manage pen profiles
axidraw job <cmd>           View and resume past jobs
axidraw config              Show/edit persistent config
axidraw completions         Generate shell completions
```

---

## Profiles

The single biggest ergonomic win. Save calibrated settings per pen type and reference them by name.

### Creating profiles

```bash
axidraw profile create fineliner \
  --speed-down 20 --speed-up 80 \
  --pen-down 38 --pen-up 62 \
  --accel 60

axidraw profile create brush \
  --speed-down 8 --speed-up 70 \
  --pen-down 45 --pen-up 68 \
  --const-speed

axidraw profile list
axidraw profile show fineliner
axidraw profile delete fineliner
axidraw profile clone fineliner fineliner-fast --speed-down 30
```

### Profile storage (`~/.config/axidraw/profiles.toml`)

```toml
[profiles.fineliner]
speed_pendown = 20
speed_penup = 80
pen_pos_down = 38
pen_pos_up = 62
accel = 60
description = "Staedtler 0.3mm"

[profiles.brush]
speed_pendown = 8
speed_penup = 70
pen_pos_down = 45
pen_pos_up = 68
const_speed = true
description = "Pentel brush pen"

[profiles.default]
# Falls back to axicli defaults if no profile specified
```

### Using profiles

```bash
axidraw plot drawing.svg --profile fineliner
axidraw plot drawing.svg -P brush
axidraw preview drawing.svg --profile fineliner  # check stats before committing
```

---

## Per-Project Config (`axidraw.toml`)

Optional file checked into each project. Defines defaults and layer assignments so you don't specify them at the command line.

```bash
axidraw init    # creates axidraw.toml in current directory
```

```toml
# axidraw.toml
model = "A3"
default_profile = "fineliner"
paper = "297x420mm"

[[layers]]
id = 1
name = "outlines"
profile = "fineliner"

[[layers]]
id = 2
name = "fills"
profile = "brush"
prompt = "Swap to brush pen (red)"

[[layers]]
id = 3
name = "hatching"
profile = "fineliner"
```

With this file present, `axidraw plot drawing.svg --guided` knows exactly which profile to use per layer and what prompt to show at each pen swap.

---

## Plotting

### Basic

```bash
axidraw plot drawing.svg
axidraw plot drawing.svg --profile fineliner
axidraw plot drawing.svg --layer 2 --profile brush
axidraw plot drawing.svg --copies 3 --page-delay 20
```

### Path optimization

```bash
axidraw plot drawing.svg --optimize 2     # allow path reversal
axidraw plot drawing.svg --optimize 0     # adjacent paths only (default)
```

Optimization level maps to axicli's `--reordering` flag but with a cleaner name.

### Output

A successful plot prints something like:

```
  axidraw — meridian.svg
  Profile:    fineliner (20% down · 80% up · accel 60%)
  Model:      V3 A3  ·  /dev/tty.usbserial-AK06WJNB

  Optimizing...  143 → 89 lifts  (-38%)

  ████████████████████  100%  done in 7m 14s
  Pen-down: 3.2m  ·  Travel: 1.1m  ·  Pen lifts: 89

  Job #5 saved.
```

---

## Guided Multi-Pen Workflow

For multi-color or multi-pen plots, `--guided` walks you through each layer interactively, prompting for pen swaps.

```bash
axidraw plot drawing.svg --guided
```

```
  axidraw — drawing.svg  (guided mode)
  3 layers: outlines (1), fills (2), hatching (3)

┌─ Layer 1/3 — outlines ──────────────────────────────┐
│  Profile:  fineliner                                  │
│  Est. time: 4m 12s  ·  Pen-down distance: 2.1m       │
└──────────────────────────────────────────────────────┘
  Pen loaded? [Enter to plot · s skip · q quit] >

  ████████████████░░░░░░  74% — 1m 05s remaining

  ✓ Layer 1 done.

┌─ Layer 2/3 — fills ─────────────────────────────────┐
│  Profile:  brush                                      │
│  Swap pen → brush (red)                               │
│  Est. time: 2m 40s  ·  Pen-down distance: 1.4m       │
└──────────────────────────────────────────────────────┘
  Ready? [Enter to plot · s skip · q quit] >
```

If `axidraw.toml` is present, layer names and swap prompts come from there. Otherwise it reads layer IDs from the SVG.

### Pause during a plot

`Ctrl-C` during a plot prompts:

```
  Paused at 74%. What next?
  [r] resume   [s] skip to next layer   [q] quit and save position
```

Choosing `q` saves the resume position to the current job file.

---

## Preview

Simulate a plot without touching hardware. Reports the same stats you'd see during a real plot.

```bash
axidraw preview drawing.svg --profile fineliner
```

```
  axidraw preview — drawing.svg
  Profile: fineliner

  Pen-down distance:   3.24 m
  Travel distance:     1.87 m   (37% overhead)
  Estimated time:      6m 48s
  Pen lifts:           143      (try --optimize 2 to reduce)
  Bounding box:        180 × 240 mm
  Fits on:             A3 ✓  A4 ✗
```

```bash
axidraw preview drawing.svg --open
# Writes a self-contained SVG to /tmp and opens it in the browser.
# Travel paths shown in light gray, pen-down paths in black.
```

---

## Watch Mode

Re-plots automatically when the source SVG changes. Designed for iterative development — edit your sketch, save, see it plotted.

```bash
axidraw watch drawing.svg --profile fineliner
```

```
  Watching drawing.svg — plots on save.

  [14:22:01] File changed.
  Preview: 6m 48s · 143 lifts · fits A3
  Plot now? [y · n · d diff] > y

  ████████████████████  100%  done in 7m 02s

  Watching...
```

`d` opens a terminal diff of the SVG (path count, bounding box changes) so you can decide if it's worth plotting.

---

## Job History

Every completed or aborted plot is saved as a TOML file in `~/.local/share/axidraw/jobs/`.

```bash
axidraw job list
```

```
  #5  2026-04-13 14:22  meridian.svg        fineliner   COMPLETE   7m 14s
  #4  2026-04-13 11:05  hatching.svg        brush       ABORTED    2m 12s  (stopped at 34%)
  #3  2026-04-12 20:44  test-page.svg       fineliner   COMPLETE   0m 45s
```

```bash
axidraw job show 4          # full settings, file path, stop position
axidraw job resume 4        # resume an aborted job from saved position
axidraw job resume          # resume the most recent aborted job
```

### Job file format (`~/.local/share/axidraw/jobs/0004.toml`)

```toml
id = 4
file = "/Users/jeff/work/gen-art/gestural/hatching.svg"
profile = "brush"
status = "aborted"
stopped_at = 0.34          # fraction complete
started_at = "2026-04-13T11:05:22Z"
duration_s = 132
pendown_m = 0.48
travel_m = 0.31
pen_lifts = 49

[settings]
speed_pendown = 8
speed_penup = 70
pen_pos_down = 45
pen_pos_up = 68
const_speed = true
reordering = 2
```

---

## Manual Hardware Control

```bash
axidraw pen up
axidraw pen down
axidraw pen cycle              # lower then raise (ink flow test)

axidraw move --x 50mm --y 30mm
axidraw move --x 2in
axidraw move --home
axidraw move --center          # center on current paper size

axidraw motors off             # disable steppers (free carriage)
axidraw motors on
```

All distances accept `mm`, `in`, or `cm`.

---

## Global Config

```bash
axidraw config show
axidraw config set default-profile fineliner
axidraw config set model A3
axidraw config set port /dev/tty.usbserial-AK06WJNB
```

Stored at `~/.config/axidraw/config.toml`:

```toml
default_profile = "fineliner"
model = "A3"
port = "/dev/tty.usbserial-AK06WJNB"
history_limit = 50
```

---

## Implementation Notes

**Runtime:** Bun  
**Config format:** TOML (via `@std/toml` or `smol-toml`)  
**TUI:** `@clack/prompts` for interactive prompts, `cli-progress` for progress bars  
**Hardware:** subprocess to `axicli` — no EBB protocol reimplementation  
**Shell completions:** generated via `axidraw completions zsh|bash|fish`  

The command pipeline internally builds a job description object (settings, file, layers) before invoking `axicli`. This object is what gets saved to job history and used for preview stats — the same data structure whether or not hardware runs.

### Why not `@thi.ng/axidraw`

`@thi.ng/axidraw` solves the right problem (commands as data, async control, native EBB in TypeScript) but brings an idiosyncratic ecosystem, alpha stability, and deep dependency chains. The value unique to that library is the EBB protocol implementation — but `axicli` already provides that via subprocess with excellent SVG support. The command-as-data pattern is worth stealing as an internal design principle; the library itself is not needed.

---

## Handling axicli Version Updates

If we clone axicli's functionality rather than subprocessing it, we own the maintenance burden of tracking upstream changes. The right approach is to be selective about what we clone vs. delegate.

### Stability varies by layer

| Layer | Stability | Change driver |
|---|---|---|
| EBB serial protocol (`XM`, `SM`, `SP`, etc.) | High — hardware-defined | EBB firmware releases by Evil Mad Scientist |
| SVG parsing + path extraction | Medium | SVG edge cases, Inkscape compatibility |
| Path optimization / reordering | Low — actively developed | Algorithm improvements, bug fixes |

### Implement against the EBB spec, not axicli's code

The EBB protocol is a published spec (`evil-mad.github.io/EggBot/ebb.html`), not an internal implementation detail. If we implement against the spec directly, we're only exposed to firmware changes — which are infrequent and announced — not to churn in the Python library's higher-level code.

### Abstract the backend behind an interface

Whether subprocessing axicli or talking EBB natively, the hardware layer should be behind a swappable interface:

```typescript
interface PlotBackend {
  connect(port: string): Promise<void>
  moveTo(x: number, y: number, speed: number): Promise<void>
  penUp(height: number, rate: number): Promise<void>
  penDown(height: number, rate: number): Promise<void>
  home(): Promise<void>
  disconnect(): Promise<void>
}
```

Two implementations:

- `AxicliBackend` — subprocess to Python axicli (default, ships first)
- `EBBBackend` — direct serial via `serialport`, implements EBB natively

Start with `AxicliBackend`. Swap to `EBBBackend` if dropping the Python dependency becomes important. Both can coexist — selectable via `--backend axicli|native` or config.

### Don't clone SVG parsing

The messiest part of axicli isn't the EBB protocol — it's SVG parsing. Handling transforms, nested groups, text-to-paths, bezier flattening, and Inkscape-specific attributes changes frequently and is full of edge cases. Use a maintained JS library for this rather than reimplementing axicli's parser.

### Own path optimization selectively

Path optimization (reordering for fewer lifts) is where axicli improves most actively. The pragmatic split:

- **Own:** EBB protocol, profiles, TUI, job history, watch mode — the differentiation
- **Delegate:** path optimization — call axicli's reorder mode as a preprocessing step, even if the rest is native

### Behavioral fixture tests

Keep reference SVG inputs with expected command output sequences. When axicli ships a new version, run the fixture suite against it to detect behavioral changes as a specific diff, not vague breakage.

```
test/fixtures/
  simple-rect/
    input.svg
    expected-commands.json
  multi-layer/
    input.svg
    expected-commands.json
```

### Keep axicli as a dev dependency regardless

Even if the native EBB backend is preferred at runtime, keep axicli installed in dev for:

- Reference behavior when something is ambiguous in the spec
- Generating fixture expected output against the authoritative implementation
- A fallback backend during development

---

## New Possibilities

The ergonomics improvements are the floor. The more interesting question is what a scriptable, composable, TS-native tool unlocks that's genuinely new.

### Pipe-based workflow — no intermediate files

```bash
node sketch.js | axidraw plot --profile fineliner
```

Your generative script writes SVG to stdout, axidraw reads from stdin and plots. No saving to disk, no filename management. Combine with a file watcher on the source script:

```bash
watchexec -e js -- 'node sketch.js | axidraw preview --stats'
```

Tight iteration loop: save the script, instantly see updated preview stats before committing to paper.

### Direct library import

Because it's TypeScript, your sketch script can import and trigger the plotter directly:

```typescript
import { plot } from 'axidraw'

const svg = generateSVG(seed)
await plot(svg, { profile: 'fineliner', guided: true })
```

Generate and plot in one script. No shell, no intermediate file, no context switch. The plotter becomes an output device your code talks to directly — the same way you'd call `fs.writeFile`.

### Series and edition plotting

Plot N unique outputs with paper-change pauses and edition tracking baked in:

```bash
axidraw series sketch.js --seeds 1-20 --profile fineliner
```

```
  Edition 1/20  seed=1
  Preview: 6m 48s · fits A3
  Paper loaded? [Enter · s skip · q quit] >

  ████████████████████  100%

  Edition 2/20  seed=2
  Remove print, load fresh paper.
  [Enter when ready] >
```

The job history becomes the edition ledger — each entry records the seed, settings, and timestamp. You know exactly which physical print corresponds to which output.

### Preprocessing pipeline

Composable SVG transformations before plotting, as named steps:

```bash
axidraw plot drawing.svg \
  --pre strip-fills \
  --pre center \
  --pre scale-to-paper \
  --pre registration-marks
```

Or defined in `axidraw.toml`:

```toml
[preprocess]
steps = ["strip-fills", "center", "scale-to-paper"]
registration_marks = true
margin_mm = 10
```

These are operations every plotter artist does manually in Inkscape before every plot. Automating them as a pipeline step means plotting directly from raw generator output.

### Hook system

Long plots (20–45min) are painful to babysit. Hooks make them autonomous:

```toml
[hooks]
on_layer_complete = "osascript -e 'display notification \"Layer done\" with title \"AxiDraw\"'"
on_complete = "terminal-notifier -message 'Plot done in {{duration}}'"
on_complete = "curl -X POST https://ntfy.sh/my-plotter -d 'Done: {{file}}'"
```

Camera trigger for timelapse:

```toml
[hooks]
on_layer_complete = "gphoto2 --capture-image"
```

### Scheduled and queued plotting

```bash
axidraw plot drawing.svg --profile fineliner --at 23:30
axidraw plot drawing.svg --profile fineliner --after 45m
```

Queue multiple jobs:

```bash
axidraw queue add layer1.svg --profile fineliner
axidraw queue add layer2.svg --profile brush
axidraw queue start --guided     # prompts for pen swaps between jobs
```

### Pen wear tracking

Because every job logs distance traveled per profile, the CLI accumulates wear data automatically:

```bash
axidraw profile show fineliner
```

```
  fineliner (Staedtler 0.3mm)
  Total plotted:  127.4m  across 34 jobs
  Last used:      2026-04-13

  ⚠ Typical lifespan ~150m — consider having a spare ready.
```

Warning before a long plot if the pen might not make it:

```
  ⚠ This plot is 8.2m. fineliner has ~12m remaining — should be fine.
```

Lifespan estimates are set per profile and updated from experience.

### SVG diff in watch mode

When a file changes during watch, show what changed before asking to re-plot:

```
  [14:22:01] drawing.svg changed

  Paths:        143 → 151  (+8)
  Bounding box: unchanged
  Est. time:    6m 48s → 7m 12s  (+24s)

  Plot now? [y · n · d visual-diff] >
```

`d` opens a browser showing old vs new paths overlaid — see exactly what moved before committing paper and ink.

### Multi-machine layer splitting

If you have two plotters, split layers across them and run in parallel:

```bash
axidraw plot drawing.svg --layer 1 --port machineA &
axidraw plot drawing.svg --layer 2 --port machineB &
```

Or defined in `axidraw.toml`:

```toml
[[layers]]
id = 1
port = "AxiDraw-A3"

[[layers]]
id = 2
port = "AxiDraw-V3"
```

### The compounding effect

Most of these are modest individually. The interesting thing is how they compose:

```bash
# Generate 10 seeds, preview each, pick one, plot the edition
axidraw series sketch.js --seeds 1-10 --preview-only \
  | axidraw pick \
  | axidraw series --count 20 --profile fineliner --notify
```

Or a fully automated overnight run: generate variations, filter out anything that doesn't fit the paper, plot the rest in a queue, notify on completion. The shift is from "tool you manually invoke before each plot" to "output device your generative pipeline talks to directly."

---

## Deeper Possibilities

The features above are ergonomic improvements. These are possibilities that change the nature of what plotting can be.

### The plotter in a feedback loop

Every possibility above treats the plotter as a one-way output device: code generates SVG, plotter draws it, done. But with direct library access and hooks, you can close the loop.

**Camera-in-the-loop generation:** Mount a camera above the plotter. After each stroke or layer, capture, analyze, feed back into generation. The physical output — actual ink on actual paper, with bleed and texture — influences what gets drawn next. Not simulated ink. Real ink.

```typescript
for (const layer of layers) {
  await plot(layer, { profile: 'fineliner' })
  const photo = await capture()
  const analysis = await analyzeInkSpread(photo)
  layers = regenerate(layers, analysis)  // next layer responds to what happened
}
```

**Adaptive speed control:** The same camera can detect when ink is pooling or lines are too thin and adjust the active profile mid-plot. The tool learns your pen's behavior on this specific paper in real time.

### Time as a medium

A 45-minute plot is 45 minutes of duration. Most tools throw that away.

**Live data plots:** The generative parameters aren't frozen at plot time — they're sampled continuously. A line drawn at minute 40 reflects the state of the world at minute 40. Weather, audio input, market data, a running script. The plot is a recording of something.

```bash
axidraw plot --live "node weather-lines.js --lat 37.7 --lon -122.4"
# weather-lines.js emits SVG paths to stdout continuously
# axidraw plots each path as it arrives
```

**The plot as performance:** The machine draws for an audience in real time. The duration isn't a cost — it's the piece.

**Scheduled temporal works:** A plot that starts at sunset and ends at sunrise. The generative system knows what time it is and what fraction of the plot is complete. Beginning and end are from different states of the same process.

### Generative programs, not SVG files

SVG is a snapshot of a finished computation. A richer format describes a *process* instead:

```json
{
  "type": "flow-field",
  "resolution": 0.5,
  "seed": "physical",
  "iterations": 800,
  "pen": "fineliner"
}
```

`"seed": "physical"` means the seed comes from something physical at plot time — the date, a word you type, a dice roll you enter. Two prints from the same program are different — not because the file changed, but because the program ran twice.

This inverts the current model. Instead of generate → export SVG → plot, you have: describe the process → plot. The plotter is the renderer, not just the output device. The physical print is the first and only render.

### The CLI learns from its own history

With enough job logs, the CLI stops being stateless.

**Pen behavior modeling:** After 20 jobs with your fineliner on Canson 300gsm, the CLI has real data — actual distance per job, actual time vs. estimated. It can predict line weight and ink pooling risk from speed settings alone.

```bash
axidraw profile calibrate fineliner --paper "Canson 300gsm"
# Plots a test grid. You rate each row 1-5.
# CLI fits a model: speed → line weight, consistency, pooling risk.
```

**Drift detection:** If your fineliner suddenly takes 15% longer than expected on a short plot, the ink is probably running low. Detectable from timing data alone — no camera needed.

**Automatic profile suggestions:** "You've plotted 12 files with this sketch. Your fastest successful settings were: speed-down 22, pen-down 36."

### Live streaming the plot

A WebSocket server broadcasting plotter position in real time:

```bash
axidraw plot drawing.svg --stream
# Plotting at localhost:3141 — share: https://axidraw.live/j/x7k2m
```

The browser view shows the current pen position moving on the canvas, paths drawn so far in black, remaining paths ghosted, and estimated time remaining. For a generative work plotted for an audience, the drawing's structure reveals itself over time in a way a finished image doesn't.

### The plot card — documentation printed on the piece

After each plot, automatically queue a small metadata strip in the margin:

```toml
[plot_card]
enabled = true
position = "bottom-margin"
content = ["title", "date", "seed", "edition", "profile"]
font = "Hershey Sans"   # single-stroke font, plottable
```

Prints directly onto the paper as part of the same job:

```
Meridian  ·  2026-04-13  ·  seed: 0x4a2f  ·  3/20  ·  Staedtler 0.3mm
```

No stickers, no stamps. The documentation is part of the drawing. Since it's single-stroke Hershey text, the plotter draws it. The signature is the machine's own handwriting.

### Multi-session serialized works

A piece plotted across days, weeks, or months:

```toml
[series]
name = "30 days of meridian"
total_sessions = 30
registration = "corner-marks"   # physical marks for re-alignment
```

```bash
axidraw plot --session     # plots today's layer, increments session counter
axidraw plot --session 12  # jump to a specific session (reprint)
```

Registration marks are plotted in the first session. Every subsequent session uses them to align. The work accumulates physically — each session logged as a job file. This is a genuinely different relationship with a generative system: not "generate and output" but generate, pause, live with it, generate again.

### Stroke physics in preview

Current preview shows paths as lines. A calibrated preview models what ink actually does:

- **Speed → line weight:** slow = thick, fast = thin, predicted from your profile's calibration data on a specific paper
- **Pooling risk:** flag strokes below a speed threshold where ink accumulates
- **Crossing wet strokes:** if layer 2 crosses layer 1 before it dries, flag those intersections
- **Chatter detection:** very short strokes (pen up, tiny move, pen down) look bad and wear the servo — surface them visually

Once per-profile calibration data exists, preview becomes genuinely predictive rather than just a path visualization.

### The underlying shift

What all of these share: they treat the plotter as a participant in the creative process rather than a peripheral you hand files to. The CLI is the interface between code and physical material — and that interface can be intelligent, stateful, and bidirectional.

The current axicli assumes the computation is finished before you touch the hardware. A more capable tool dissolves that boundary.

---

## What This Doesn't Do

- No SVG editing beyond the preprocessing pipeline
- No GUI or web interface
- No cloud/remote plotting

---

## Build Plan

### Guiding principles

- **Library-first, CLI second.** The CLI is a thin consumer of the library. `import { plot } from 'nib'` works from day one, which is how sketch scripts get direct plotter access.
- **AxicliBackend first.** Don't get distracted by native EBB. The backend interface makes swapping later painless. Ship something useful fast.
- **Job object as the canonical representation.** Everything flows through a `Job`. Build it → validate it → serialize it → execute it. Preview is execute-without-hardware. History is serialize-before/after. Hooks subscribe to its events.
- **Event-driven execution core.** The plot runner emits events (`layer:complete`, `pen:lift`, `progress`, `complete`) that all consumers subscribe to independently: progress bar, job logger, hook runner, WebSocket stream. Composable by default.

### Project structure

```
nib/
├── src/
│   ├── cli/              # thin command definitions
│   │   ├── plot.ts
│   │   ├── preview.ts
│   │   ├── watch.ts
│   │   ├── profile.ts
│   │   ├── job.ts
│   │   ├── series.ts
│   │   └── index.ts      # entry point, registers commands
│   ├── core/             # all domain logic
│   │   ├── job.ts        # Job type, builder, validator
│   │   ├── config.ts     # profiles, global config, axidraw.toml
│   │   ├── preprocess.ts # SVG pipeline steps
│   │   ├── history.ts    # read/write job store
│   │   └── events.ts     # EventEmitter for plot lifecycle
│   ├── backends/
│   │   ├── interface.ts  # PlotBackend interface
│   │   ├── axicli.ts     # subprocess wrapper (ships first)
│   │   └── ebb.ts        # native serial (phase 4)
│   ├── tui/
│   │   ├── progress.ts
│   │   ├── guided.ts     # multi-pen interactive flow
│   │   └── output.ts     # consistent print formatting
│   └── index.ts          # public library exports
├── test/
│   └── fixtures/         # reference SVGs + expected command sequences
├── package.json
└── axidraw.toml          # dogfoods itself
```

### Dependencies

| Concern | Package | Why |
|---|---|---|
| CLI framework | `citty` | Lightweight, Bun-native feel, good TypeScript |
| Prompts / TUI | `@clack/prompts` | Best-in-class modern terminal UX |
| TOML | `smol-toml` | Tiny, fast, Bun-idiomatic |
| File watching | `chokidar` | More reliable than Bun's `fs.watch` across editors |
| SVG parsing | `svgson` | SVG ↔ JSON, lightweight |
| SVG path ops | `svg-pathdata` | Transform, flatten beziers for preprocessing |
| Serial port | `serialport` | EBBBackend only (phase 4) |
| WebSocket | Bun built-in | Streaming, no extra dep |
| Testing | Bun built-in | |

### The Job object

Everything flows through this type. Define it in Phase 1 and don't change the shape.

```typescript
interface Job {
  id: number
  file: string | null        // null if piped from stdin
  svg: string                // resolved SVG content
  profile: ResolvedProfile
  layers: LayerConfig[]
  preprocess: PreprocessStep[]
  copies: number
  status: 'pending' | 'running' | 'complete' | 'aborted'
  startedAt?: Date
  completedAt?: Date
  stoppedAt?: number         // fraction 0-1
  metrics: {
    pendownM: number
    travelM: number
    penLifts: number
    durationS: number
  }
  hooks: HookConfig
  backend: 'axicli' | 'ebb'
}
```

### Build phases

#### Phase 1 — MVP

Delivers the biggest daily friction reduction with minimal complexity. A solid weekend of work to something genuinely usable.

1. Define `Job` type and `PlotBackend` interface — the skeleton everything hangs on
2. `config.ts` — TOML load/save for profiles, global config, `axidraw.toml`
3. Profile CRUD commands (`profile create`, `list`, `show`, `clone`, `delete`)
4. `AxicliBackend` — subprocess wrapper, translates Job → axicli flags
5. `nib plot <file> --profile <name>` — the core command
6. Job logging — serialize to `~/.local/share/nib/jobs/` before and after execution

#### Phase 2 — Workflow

7. Progress display — parse axicli stdout to drive a `@clack/prompts` progress bar with ETA
8. `nib preview` — axicli preview mode, formatted stats output
9. Guided multi-pen flow — interactive layer-by-layer prompts from `axidraw.toml`
10. Pause/resume — catch `SIGINT`, prompt user, save position to job file
11. `nib job` commands — list, show, resume
12. `nib watch` — chokidar loop, preview stats on change, confirm before re-plot

#### Phase 3 — Intelligence

13. Preprocessing pipeline — `strip-fills`, `center`, `scale-to-paper`, `registration-marks`
14. SVG diff in watch mode — path count, bounding box, time delta between versions
15. Hook system — shell commands on lifecycle events with template variables
16. Pen wear tracking — accumulate distance per profile, warn before long plots
17. `nib profile calibrate` — test grid + rating → line weight model per paper type
18. Series/edition commands — `nib series`, edition ledger in job history

#### Phase 4 — Advanced

19. `EBBBackend` — native serial via `serialport`, drops Python dependency
20. Live streaming — Bun WebSocket server, browser viewer of pen position
21. `--live` mode — read SVG paths from stdout of a running process, plot as they arrive
22. Plot card — Hershey text metadata strip appended to each job
23. Multi-session works — session counter, registration mark support
24. Camera integration — hook into capture + analysis for feedback-loop generation

### Testing strategy

- **Unit tests** — config loading, profile resolution, SVG preprocessing. Pure functions, no hardware.
- **Fixture tests** — reference SVGs with expected axicli flag output. Run in CI.
- **Integration tests** — real `AxicliBackend` in preview mode. Requires Python + axicli. Run locally only.
- **No mocking the backend** — use preview mode against the real binary. Mocking it replicates exactly the mistake that makes axicli's own test suite unreliable.

### Distribution

```bash
bun build --compile src/cli/index.ts --outfile nib
```

Single native binary, no runtime required on the target machine. Published to npm as `nib` — installable via `bun add -g nib` or `npx nib`.
