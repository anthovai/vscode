import { createContext, useContext } from 'react'

/** What a structured chat tells its rows about an Kingu stop: the name of the machine whose Kingu runs
 *  it, as Kingu shows that host everywhere (null when it has none to show), whether that machine is a
 *  remote host rather than this desktop, and whether its host can continue a cut, which only a host
 *  known not to has no Continue for. */
export type NativeChatKinguStopView = {
  hostLabel: string | null
  remoteHost: boolean
  continueAvailable: boolean
  /** The cut turn whose row carries Continue right now, if any. */
  offeredTurnItemId: string | null
  continueNow: () => void
}

export const NativeChatKinguStopContext = createContext<NativeChatKinguStopView>({
  hostLabel: null,
  remoteHost: false,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: () => {}
})

export function useNativeChatKinguStopView(): NativeChatKinguStopView {
  return useContext(NativeChatKinguStopContext)
}
