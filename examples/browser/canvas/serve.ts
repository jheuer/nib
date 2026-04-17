/**
 * Dev server for the live-canvas example.
 *
 * Bundles `main.ts` on each request (no cache) so edits to the example or
 * to nib's browser module show up on refresh. Serves the static HTML from
 * this directory.
 *
 * Run:  bun examples/browser/canvas/serve.ts
 */

import { file } from 'bun'
import { join } from 'path'

const root = new URL('.', import.meta.url).pathname
const port = Number(process.env.PORT ?? 3001)

const server = Bun.serve({
  port,
  async fetch(req: Request) {
    const url = new URL(req.url)

    if (url.pathname === '/main.js') {
      const result = await Bun.build({
        entrypoints: [join(root, 'main.ts')],
        target: 'browser',
        sourcemap: 'inline',
      })
      if (!result.success) {
        const msg = result.logs.map(l => String(l)).join('\n')
        return new Response('/* build failed */\nconsole.error(`' + msg.replace(/`/g, '\\`') + '`)', {
          status: 500,
          headers: { 'content-type': 'application/javascript' },
        })
      }
      const text = await result.outputs[0].text()
      return new Response(text, { headers: { 'content-type': 'application/javascript' } })
    }

    const path = url.pathname === '/' ? '/index.html' : url.pathname
    try {
      const f = file(join(root, path))
      if (!(await f.exists())) return new Response('not found', { status: 404 })
      return new Response(f)
    } catch {
      return new Response('not found', { status: 404 })
    }
  },
})

process.stderr.write(`\n  nib live-canvas demo  →  http://localhost:${server.port}/\n\n`)
