import { defineConfig } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDesktopDevServer } from '../../scripts/desktop-dev-server.mjs'

const desktopDirectory = dirname(fileURLToPath(import.meta.url))
const desktopServer = resolveDesktopDevServer(process.env)

export default defineConfig({
  root: resolve(desktopDirectory, 'renderer'),
  base: './',
  server: {
    host: desktopServer.host,
    port: desktopServer.port,
    strictPort: true,
  },
  build: {
    outDir: resolve(desktopDirectory, '../../dist-desktop/renderer'),
    emptyOutDir: true,
  },
})
