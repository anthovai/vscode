import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** Copies the chat's Kingu session ID from the host: `kingu_session_id:<root>`, which `/clear` keeps. */
export function NativeChatCopyKinguSessionIdMenuItem({
  resolveKinguSessionId
}: {
  resolveKinguSessionId: () => Promise<string | null>
}): React.JSX.Element {
  const copyKinguSessionId = async (): Promise<void> => {
    try {
      const kinguSessionId = await resolveKinguSessionId()
      if (!kinguSessionId) {
        throw new Error('no Kingu session ID')
      }
      await window.api.ui.writeClipboardText(kinguSessionId)
      toast.success(
        translate(
          'components.native-chat.contextMenu.kinguSessionIdCopied',
          'Kingu session ID copied'
        )
      )
    } catch {
      toast.error(
        translate(
          'components.native-chat.contextMenu.kinguSessionIdCopyFailed',
          'Unable to copy Kingu session ID'
        )
      )
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem onSelect={() => void copyKinguSessionId()}>
          <Copy />
          {translate(
            'components.native-chat.contextMenu.copyKinguSessionId',
            'Copy Kingu Session ID'
          )}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        {translate(
          'components.native-chat.contextMenu.kinguSessionIdTooltip',
          "Kingu's ID for this chat, separate from the agent CLI's own session ID. Agents use it to refer to each other through Kingu."
        )}
      </TooltipContent>
    </Tooltip>
  )
}
