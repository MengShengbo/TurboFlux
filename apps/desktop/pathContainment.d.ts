export interface PathImplementation {
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  sep: string
}

export function isPathInside(root: string, target: string, pathImplementation?: PathImplementation): boolean
