import './styles.css'
import './apiSettings.css'
import './userProfile.css'
import { mountWorkbench } from './workbench'
import { initializeTheme } from './theme'
import { initializeWorkbenchMode } from './workbenchMode'
import { initializeBackgroundMedia } from './backgroundMedia'

const app = document.querySelector<HTMLDivElement>('#app')!

initializeTheme()
initializeWorkbenchMode()
const dispose = mountWorkbench(app)
window.addEventListener('pagehide', dispose, { once: true })
if (import.meta.hot) import.meta.hot.dispose(() => {
  window.removeEventListener('pagehide', dispose)
  dispose()
})
void initializeBackgroundMedia(window.turbofluxDesktop)
