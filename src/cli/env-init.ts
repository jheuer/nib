// This module must be imported first in cli/index.ts.
// It sets NO_COLOR in the environment before chalk or ora load,
// so all downstream modules see the correct color state.
import '../tui/env.ts'
