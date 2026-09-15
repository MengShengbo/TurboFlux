export type JavaScriptRuntime = 'node' | 'bun' | 'unknown'

export interface RuntimeInfo {
  name: JavaScriptRuntime
  version: string
  platform: NodeJS.Platform
  arch: string
}

export function getRuntimeInfo(): RuntimeInfo {
  const globalRecord = globalThis as typeof globalThis & {
    Bun?: { version?: string }
  }
  if (globalRecord.Bun) {
    return {
      name: 'bun',
      version: globalRecord.Bun.version || 'unknown',
      platform: process.platform,
      arch: process.arch,
    }
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    return {
      name: 'node',
      version: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    }
  }
  return { name: 'unknown', version: 'unknown', platform: process.platform, arch: process.arch }
}
