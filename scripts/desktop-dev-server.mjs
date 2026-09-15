export const DEFAULT_DESKTOP_DEV_PORT = 15_174

export function resolveDesktopDevServer(environment = process.env) {
  const configuredPort = environment.TURBOFLUX_DESKTOP_PORT?.trim()
  const port = configuredPort ? Number(configuredPort) : DEFAULT_DESKTOP_DEV_PORT

  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('TURBOFLUX_DESKTOP_PORT must be an integer between 1024 and 65535.')
  }

  const host = '127.0.0.1'
  return { host, port, url: `http://${host}:${port}` }
}
