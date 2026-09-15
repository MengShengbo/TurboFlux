export async function runPackagedDesktopBootstrap(loadMain, options = {}) {
  const environment = options.environment ?? process.env
  if (environment.TURBOFLUX_DESKTOP_QA_HIDDEN !== '1') return loadMain()

  const processTarget = options.processTarget ?? process
  const report = options.report ?? ((label, error) => console.error(label, error))
  const terminate = options.terminate ?? (code => process.exit(code))
  let failed = false
  const fail = error => {
    if (failed) return
    failed = true
    report('TurboFlux hidden QA bootstrap failure', error)
    terminate(1)
  }
  processTarget.on('uncaughtException', fail)
  processTarget.on('unhandledRejection', fail)
  try {
    await loadMain()
  } catch (error) {
    fail(error)
  }
}
