// Stylesheets first, in cascade order: the frozen theme, third-party base styles, then
// the shell. Area stylesheets (bridge, codegen, sandbox) load with their components
// below, so they come later and can refine these without specificity games.
import './theme.css'
import 'uplot/dist/uPlot.min.css'
import './ui/styles/shell.css'
import './ui/styles/controls.css'
import './ui/styles/instruments.css'
import './ui/styles/viewport.css'
import './ui/styles/overlays.css'
import ReactDOM from 'react-dom/client'
import App from './App'
import { runtime } from './core/runtime'
import { useConsole } from './store'
import { initialQuality } from './scene/device'
import { robotFromLocation, viewFromLocation } from './ui/urlState'

/*
 * Startup runs before the first render: pick the render quality once (stored choice,
 * else device detection), then create the module (from ?robot= when given), so no
 * component triggers store writes while React is rendering.
 */
useConsole.getState().setQuality(initialQuality())
runtime.setRobot(robotFromLocation() ?? useConsole.getState().robot)
const view = viewFromLocation()
if (view) useConsole.getState().setCameraPreset(view)

const root = document.getElementById('root')
if (root) ReactDOM.createRoot(root).render(<App />)
