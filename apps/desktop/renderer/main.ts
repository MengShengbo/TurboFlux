import './styles.css'
import './profileCenter.css'
import './apiSettings.css'
import { mountWorkbench } from './workbench'
import { initializeTheme } from './theme'
import { initializeWorkbenchMode } from './workbenchMode'
import { initializeBackgroundMedia } from './backgroundMedia'

const app = document.querySelector<HTMLDivElement>('#app')!

initializeTheme()
initializeWorkbenchMode()
mountWorkbench(app)
void initializeBackgroundMedia(window.turbofluxDesktop)
