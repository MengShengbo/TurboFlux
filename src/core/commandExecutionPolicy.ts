const PACKAGE_MANAGER_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add|update|upgrade|link|rebuild|dedupe|prune)\b/i
const PACKAGE_SCRIPT_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|type-check|lint|check|dev|watch|start)\b/i
const TOOLCHAIN_COMMAND = /\b(?:npx|pnpm\s+dlx|bunx)\s+(?:tsc|vitest|jest|eslint|prettier)\b|\b(?:pip|pip3|uv)\s+(?:install|sync)\b|\b(?:cargo)\s+(?:build|check|test|fetch|install)\b|\b(?:go)\s+(?:build|test|generate)\b|\b(?:dotnet)\s+(?:restore|build|test)\b|\b(?:mvn|gradle|make)\b/i

export function shouldAutoBackgroundCommand(command: string): boolean {
  const normalized = command.replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  return PACKAGE_MANAGER_COMMAND.test(normalized)
    || PACKAGE_SCRIPT_COMMAND.test(normalized)
    || TOOLCHAIN_COMMAND.test(normalized)
}
