import type { ChatObservation } from '@moderator/contracts';

import { ChatAiDecision } from './chat-ai-decision';
import { ChatAiShadow } from './chat-ai-shadow';
import { ChatAuthorAction } from './chat-author-action';
import { ChatBlacklist } from './chat-blacklist';
import { ChatDeletion } from './chat-deletion';
import { ChatEvaluation } from './chat-evaluation';
import { ChatMessageSummary } from './chat-message-summary';
import { ChatUnban, type UnbanScope } from './chat-unban';

const eventLabels: Record<string, string> = {
  textMessageEvent: 'Message',
  superChatEvent: 'Super Chat',
  superStickerEvent: 'Super Sticker',
  newSponsorEvent: 'New member',
  memberMilestoneChatEvent: 'Member milestone',
  membershipGiftingEvent: 'Membership gift',
  giftMembershipReceivedEvent: 'Membership received',
  giftEvent: 'Gift',
  pollEvent: 'Poll',
  userBannedEvent: 'User moderation event',
  messageDeletedEvent: 'Message removal event',
  tombstone: 'Unavailable message',
  chatEndedEvent: 'Chat ended',
};

export function ChatMessage({
  message,
  compact = false,
  unbanScope,
}: {
  message: ChatObservation;
  compact?: boolean;
  unbanScope?: UnbanScope;
}) {
  const label = eventLabels[message.event_type] ?? 'Chat event';
  const details = (
    <div
      className={
        compact
          ? 'space-y-4 [&>div]:rounded-none [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0'
          : 'space-y-2'
      }
    >
      <ChatEvaluation evaluation={message.evaluation} />
      <ChatBlacklist decision={message.blacklist} />
      <ChatAiShadow result={message.ai_shadow} />
      <ChatAiDecision decision={message.ai_decision} />
      <ChatDeletion deletion={message.deletion} />
      <ChatAuthorAction action={message.author_action} />
      {message.author_action?.action === 'BAN' && message.author_action.status === 'SUCCEEDED' && (
        <ChatUnban action={message.author_action} scope={unbanScope} />
      )}
    </div>
  );
  const hasDetails = Boolean(
    message.evaluation ||
      message.blacklist ||
      message.ai_shadow ||
      message.ai_decision ||
      message.deletion ||
      message.author_action,
  );

  return (
    <li className="space-y-2 border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 wrap-break-word text-sm font-medium">
          {message.author_display_name ?? 'Unknown author'}
        </span>

        <time dateTime={message.published_at} className="text-xs text-muted-foreground">
          {new Date(message.published_at).toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          })}
        </time>
      </div>

      <p className="whitespace-pre-wrap wrap-break-word text-sm">{message.display_text ?? label}</p>

      {(!compact || message.event_type !== 'textMessageEvent') && (
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span className="rounded-md border px-2 py-1">{label}</span>
        </div>
      )}

      {compact ? (
        <>
          <ChatMessageSummary message={message} />
          {hasDetails && (
            <details className="group">
              <summary className="cursor-pointer px-1 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                Moderation details
              </summary>
              <div className="border-l-2 pl-4 py-2">{details}</div>
            </details>
          )}
        </>
      ) : (
        details
      )}
    </li>
  );
}
