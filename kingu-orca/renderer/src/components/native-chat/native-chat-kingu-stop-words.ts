// The words for a reply Kingu's own stop cut off, by cause and machine. One function, so the chat's
// row wording can change in one place.

import { translate } from '@/i18n/i18n'
import type { AgentSessionKinguStopCause } from '../../../../shared/agent-session-kingu-stop'
import { joinSentences } from '../../../../shared/sentence-joining'

const STOPPED: Record<AgentSessionKinguStopCause, (machine: string) => string> = {
  update: (machine) =>
    translate(
      'components.native-chat.notices.kinguStopUpdate',
      'Kingu on {{machine}} restarted for an update while this response was in progress.',
      { machine }
    ),
  quit: (machine) =>
    translate(
      'components.native-chat.notices.kinguStopQuit',
      'Kingu on {{machine}} was closed while this response was in progress.',
      { machine }
    ),
  crash: (machine) =>
    translate(
      'components.native-chat.notices.kinguStopCrash',
      'Kingu on {{machine}} stopped unexpectedly while this response was in progress.',
      { machine }
    )
}

// A remote graceful stop is a server stop or a shared desktop's quit; "stopped" is true of both.
const remoteQuit = (machine: string): string =>
  translate(
    'components.native-chat.notices.kinguStopRemote',
    'Kingu on {{machine}} stopped while this response was in progress.',
    { machine }
  )

function stoppedSentence(
  cause: AgentSessionKinguStopCause,
  machine: string,
  remoteHost: boolean
): string {
  return cause === 'quit' && remoteHost ? remoteQuit(machine) : STOPPED[cause](machine)
}

/** The row's sentence. Where the host can continue a cut, Continue is the way on, so the row does
 *  not say it again; decided by the host, not the button, so the words never change on screen. */
export function nativeChatKinguStopRowText(
  cause: AgentSessionKinguStopCause,
  machine: string,
  options: { continueAvailable: boolean; remoteHost: boolean }
): string {
  const stopped = stoppedSentence(cause, machine, options.remoteHost)
  return options.continueAvailable
    ? stopped
    : joinSentences([
        stopped,
        translate(
          'components.native-chat.notices.kinguStopCanContinue',
          'You can continue in this conversation.'
        )
      ])
}
