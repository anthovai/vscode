/*---------------------------------------------------------------------------------------------
 *  Kingu Intelligence
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const vendored = resolve(import.meta.dirname)
const forkRoot = resolve(import.meta.dirname, '..')

/**
 * Re-roots asset imports that escape the vendored tree.
 *
 * The ADE reaches `resources/` from its own repository root, so a file at
 * `renderer/src/components/x/y.tsx` writes `../../../../../resources/logo.svg`.
 * Vendored one directory deeper that climbs one level too far and lands on the
 * *fork's* root — which has a `resources/` of its own.
 *
 * The rule is positional, not "whichever file happens to exist": anything that
 * escapes `kingu-orca/` is re-rooted back into it, and an asset is only ever
 * read from the vendored tree. Preferring an existing file would mean a name
 * the fork also uses — `icon.png`, say — silently resolving to the fork's copy,
 * which is a wrong picture rather than a build error.
 *
 * Same rule as `build/kingu-orca/build.mjs` applies to the main bundle. Two
 * builders, one rule; if it ever needs changing it needs changing in both.
 */
function reRootEscapingAssets(): Plugin {
  return {
    name: 'kingu-orca-rerooted-assets',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || isAbsolute(source) || !source.startsWith('.')) {
        return null
      }
      // `?url`, `?asset`, `?raw`: vite's own suffixes, which say what to do with
      // the file rather than which file it is. Split before touching disk and
      // put back afterwards, or every asset import resolves to a path with a
      // query glued onto its extension and nothing is found.
      const queryAt = source.indexOf('?')
      const specifier = queryAt === -1 ? source : source.slice(0, queryAt)
      const query = queryAt === -1 ? '' : source.slice(queryAt)
      const direct = resolve(importer, '..', specifier)
      const inside = relative(vendored, direct)
      if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
        return null
      }
      const fromForkRoot = relative(forkRoot, direct)
      if (!fromForkRoot || fromForkRoot.startsWith('..') || isAbsolute(fromForkRoot)) {
        return null
      }
      const rerooted = resolve(vendored, fromForkRoot)
      return existsSync(rerooted) ? `${rerooted}${query}` : null
    }
  }
}

/**
 * Builds the vendored ADE renderer into `out-kingu-orca/renderer`.
 *
 * Lifted from the ADE's own `electron.vite.config.ts` renderer section rather
 * than written fresh: the aliases, the strict entry signatures and the worker
 * format are all load-bearing, and a config that merely looked equivalent would
 * fail in ways that surface as a blank window.
 *
 * What is dropped is electron-vite itself. This builds only the renderer, so
 * there is no main or preload section, and the output is a plain set of HTML
 * entries the fork's own window can load.
 *
 * The dependency tree comes from `kingu-orca/node_modules`, installed from the
 * `package.json` beside this file. It is deliberately not the fork's: the
 * renderer is browser-only — `renderer-node-builtin-boundary.test.ts` walks the
 * import graph from every entry and refuses any `node:` builtin — so nothing
 * here needs to agree with the fork about `node-pty`, `@xterm/headless` or the
 * other native packages whose versions the two repositories disagree on.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'renderer'),
  // Relative, because the window loads these files from disk rather than from
  // the root of a server.
  base: './',
  plugins: [reRootEscapingAssets(), react(), tailwindcss()],
  resolve: {
    alias: {
      '@renderer': resolve(import.meta.dirname, 'renderer/src'),
      '@': resolve(import.meta.dirname, 'renderer/src'),
      // A dependency's dependency reaches for a Node builtin the sandboxed
      // renderer does not have. See the shim for which one and why a no-op is
      // the right answer rather than a polyfill.
      'diagnostics_channel': resolve(import.meta.dirname, 'renderer-shims/diagnostics-channel.js'),
      'node:diagnostics_channel': resolve(import.meta.dirname, 'renderer-shims/diagnostics-channel.js')
    }
  },
  worker: {
    format: 'es'
  },
  build: {
    outDir: resolve(import.meta.dirname, '../out-kingu-orca/renderer'),
    emptyOutDir: true,
    manifest: true,
    modulePreload: { polyfill: true },
    minify: 'oxc',
    target: 'es2020',
    rollupOptions: {
      // Shared chunks must never import an HTML entry whose module mounts a
      // different React root — the ADE's own note, and the reason the pop-out
      // and the main window can coexist.
      preserveEntrySignatures: 'strict',
      input: {
        index: resolve(import.meta.dirname, 'renderer/index.html'),
        popout: resolve(import.meta.dirname, 'renderer/popout.html')
      }
    }
  }
})
