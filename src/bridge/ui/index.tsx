import './bridge.css'

/*
 * Bridge UI entry points mounted by the shell (no props):
 *  HardwarePanel  → right rail, under the DRIVE SOURCE switch, when source = HARDWARE
 *                   (link state, E-STOP / HOME, transport + board + connect, stats, level).
 *  HardwareDrawer → bottom drawer body when source = HARDWARE
 *                   (serial monitor, telemetry table, calibration tabs).
 */
export { HardwarePanel } from './HardwarePanel'
export { HardwareDrawer } from './HardwareDrawer'
