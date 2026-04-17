/**
 * Dev server for the p5.js + nib example.
 * Run:  bun examples/browser/p5/serve.ts   (default port 3002)
 */

import { file } from 'bun'
import { join } from 'path'

const root = new URL('.', import.meta.url).pathname
const port = Number(process.env.PORT ?? 3002)

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
        return new Response('console.error(`nib p5 example build failed:\\n' + msg.replace(/`/g, '\\`') + '`)', {
          status: 500,
          headers: { 'content-type': 'application/javascript' },
        })
      }
      return new Response(await result.outputs[0].text(), {
        headers: { 'content-type': 'application/javascript' },
      })
    }

    const path = url.pathname === '/' ? '/index.html' : url.pathname
    const f = file(join(root, path))
    if (!(await f.exists())) return new Response('not found', { status: 404 })
    return new Response(f)
  },
})

process.stderr.write(`\n  nib + p5 flow-field demo  →  http://localhost:${server.port}/\n\n`)
