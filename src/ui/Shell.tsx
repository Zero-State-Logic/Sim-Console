import Viewport from '../scene/Viewport'
import { CodegenDialog } from '../codegen/ui'
import TopBar from './TopBar'
import InstrumentRail from './InstrumentRail'
import ControlRail from './ControlRail'
import BottomDrawer from './BottomDrawer'
import HelpDialog from './HelpDialog'
import ProfilesDialog from './profiles/ProfilesDialog'
import Timeline from './recording/Timeline'
import Tour from './tour/Tour'
import { useKeyboard } from './keyboard/useKeyboard'
import { useUi } from './uiStore'
import { useRobotUrlSync } from './urlState'

/*
 * The console layout: top bar, instrument rail | viewport | control rail, then the
 * replay timeline and the drive-source drawer in flow below (the viewport shrinks
 * instead of being covered). At <= 1100 px the rails turn into overlays toggled from
 * the top bar; at <= 700 px everything stacks (see src/ui/styles/shell.css).
 */
export default function Shell() {
  useKeyboard()
  useRobotUrlSync()
  const railOpen = useUi((s) => s.railOpen)
  const closeRails = useUi((s) => s.closeRails)

  return (
    <div className="app">
      <TopBar />
      <div className={`stage${railOpen ? ` show-${railOpen}` : ''}`}>
        <aside id="rail-instruments" className="rail rail-left" aria-label="Instruments">
          <InstrumentRail />
        </aside>
        <main className="viewport" aria-label="3D viewport">
          <Viewport />
        </main>
        <aside id="rail-controls" className="rail rail-right" aria-label="Controls">
          <ControlRail />
        </aside>
        {railOpen && <button type="button" className="rail-scrim" aria-label="Close panel" onClick={closeRails} />}
      </div>
      <Timeline />
      <BottomDrawer />
      <ProfilesDialog />
      <HelpDialog />
      <CodegenDialog />
      <Tour />
    </div>
  )
}
