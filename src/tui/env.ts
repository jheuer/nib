/**
 * Runtime environment detection.
 * Import this before chalk or ora to ensure color/interactivity state is set.
 */

export const isTTY = process.stdout.isTTY === true
export const isStderrTTY = process.stderr.isTTY === true

/** True when running in a known CI environment */
export const isCI = !!(
  process.env.CI ||
  process.env.CONTINUOUS_INTEGRATION ||
  process.env.GITHUB_ACTIONS ||
  process.env.GITLAB_CI ||
  process.env.CIRCLECI
)

/** True when the user or environment has requested no ANSI output */
export const noColor = !!(
  process.env.NO_COLOR !== undefined ||
  process.env.TERM === 'dumb'
)

/** True when it's safe to show spinners, prompts, and ANSI formatting */
export const isInteractive = isTTY && !isCI && !noColor

// Propagate NO_COLOR so chalk, ora, etc. all respect it automatically
if (!isTTY || noColor) {
  process.env.NO_COLOR = '1'
}
