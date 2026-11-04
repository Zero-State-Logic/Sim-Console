import * as Tooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

/* A small "?" affordance with a Radix tooltip. Needs <Tooltip.Provider> (Shell). */
export function Hint({ text }: { text: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" className="hint" aria-label={text}>
          ?
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side="left" sideOffset={6} collisionPadding={8}>
          {text}
          <Tooltip.Arrow className="tip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

/** Wrap any element with a tooltip (icon buttons in the top bar and viewport). */
export function WithTip({ tip, children, side = 'bottom' }: { tip: string; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tip" side={side} sideOffset={6} collisionPadding={8}>
          {tip}
          <Tooltip.Arrow className="tip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
