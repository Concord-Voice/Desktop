import ContextMenu from '../ui/ContextMenu';
import { EnforcementMenuItems } from '../ui/EnforcementMenuItems';
import { ParticipantVolumeRow } from './ParticipantVolumeRow';
import { useVoiceStore, type VoiceParticipant } from '../../stores/voiceStore';
import { MUTE_MEMBERS, DEAFEN_MEMBERS } from '../../utils/permissions';

interface ParticipantContextMenuProps {
  participant: VoiceParticipant;
  position: { x: number; y: number };
  onClose: () => void;
}

export function ParticipantContextMenu({
  participant,
  position,
  onClose,
}: Readonly<ParticipantContextMenuProps>) {
  const activeServerId = useVoiceStore((s) => s.activeServerId);
  const isDMCall = useVoiceStore((s) => s.isDMCall);
  const isGroupDM = useVoiceStore((s) => s.isGroupDM);
  const callerDMRole = useVoiceStore((s) => s.callerDMRole);
  const activeChannelId = useVoiceStore((s) => s.activeChannelId);
  const permissions = useVoiceStore((s) => s.effectivePermissions);

  let enforcementContext: React.ComponentProps<typeof EnforcementMenuItems>['context'] | null =
    null;

  if (!isDMCall && activeServerId) {
    enforcementContext = {
      type: 'server',
      serverId: activeServerId,
      canMute: !!(permissions & MUTE_MEMBERS),
      canDeafen: !!(permissions & DEAFEN_MEMBERS),
      canModerate: true, // Backend enforces hierarchy — client shows optimistically
    };
  } else if (isDMCall && activeChannelId) {
    if (isGroupDM) {
      enforcementContext = {
        type: 'dm_group',
        conversationId: activeChannelId,
        isAdmin: callerDMRole === 'admin',
      };
    } else {
      enforcementContext = {
        type: 'dm_1on1',
        conversationId: activeChannelId,
      };
    }
  }

  return (
    <ContextMenu position={position} onClose={onClose}>
      <ContextMenu.Header>{participant.displayName || participant.username}</ContextMenu.Header>
      <ParticipantVolumeRow userId={participant.userId} />
      {enforcementContext && (
        <>
          <ContextMenu.Separator />
          <EnforcementMenuItems
            targetUserId={participant.userId}
            targetServerMuted={participant.serverMuted}
            targetServerDeafened={participant.serverDeafened}
            targetIsMuted={participant.isMuted}
            targetIsInVoice={true}
            context={enforcementContext}
            onClose={onClose}
          />
        </>
      )}
    </ContextMenu>
  );
}
