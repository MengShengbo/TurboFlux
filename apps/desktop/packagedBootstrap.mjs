import { runPackagedDesktopBootstrap } from './packagedBootstrapRuntime.mjs'

await runPackagedDesktopBootstrap(() => import('./main.mjs'))
