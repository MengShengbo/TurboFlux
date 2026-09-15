import { isAbsolute, relative, sep } from 'node:path'

const nativePath = { isAbsolute, relative, sep }

export function isPathInside(root, target, pathImplementation = nativePath) {
  const child = pathImplementation.relative(root, target)
  return Boolean(child)
    && child !== '..'
    && !child.startsWith(`..${pathImplementation.sep}`)
    && !pathImplementation.isAbsolute(child)
}
