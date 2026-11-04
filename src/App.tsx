import * as Tooltip from '@radix-ui/react-tooltip'
import Shell from './ui/Shell'

export default function App() {
  return (
    <Tooltip.Provider delayDuration={350} skipDelayDuration={150}>
      <Shell />
    </Tooltip.Provider>
  )
}
