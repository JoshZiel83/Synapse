'use client';

import { ArrowDown, MoreHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';

import ChatAvatar from '@/app/dashboard/chat/chat-avatar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { ConversationMember, ConversationSummary } from '@/stores/chat-store';
import {
  getConversationMemberContactHref,
  getConversationMemberSubtitle,
} from './member-utils';

function summarizeMemberCounts(conversation: ConversationSummary) {
  const userCount = conversation.members.filter((member) => member.type === 'user').length;
  const actorCount = conversation.members.filter((member) => member.type === 'actor').length;
  const externalCount = conversation.members.filter((member) => member.type === 'external').length;
  const userLabel = `${userCount} user${userCount === 1 ? '' : 's'}`;
  const actorLabel = `${actorCount} actor${actorCount === 1 ? '' : 's'}`;
  if (externalCount === 0) return `${userLabel} · ${actorLabel}`;
  return `${userLabel} · ${actorLabel} · ${externalCount} external${externalCount === 1 ? '' : 's'}`;
}

function orderMembers(members: ConversationMember[]) {
  return [...members].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'actor' ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

interface MobileConversationDetailsDialogProps {
  conversation: ConversationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMemberClick?: (member: ConversationMember) => void;
  contactBasePath?: string;
}

export default function MobileConversationDetailsDialog({
  conversation,
  open,
  onOpenChange,
  onMemberClick,
  contactBasePath = '/dashboard/contacts',
}: MobileConversationDetailsDialogProps) {
  const router = useRouter();
  const title =
    conversation.title ||
    conversation.participants.map((participant) => participant.name).join(', ');
  const memberSummary = summarizeMemberCounts(conversation);
  const orderedMembers = orderMembers(conversation.members);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 start-0 h-[100dvh] max-w-none translate-x-0 rtl:translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 ring-0"
      >
        <DialogTitle className="sr-only">Conversation details</DialogTitle>
        <div className="flex min-h-svh flex-col bg-background">
          <header className="sticky top-0 z-20 border-b border-border bg-background px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <div className="relative flex items-center justify-between">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex h-8 w-8 items-center justify-center text-foreground transition-colors hover:text-primary"
                aria-label="Back"
              >
                <ArrowDown className="size-4 rotate-90" />
              </button>
              <div className="pointer-events-none absolute inset-x-12 left-1/2 -translate-x-1/2 text-center">
                <h1 className="truncate text-sm font-semibold text-foreground">
                  Conversation details
                </h1>
              </div>
              <div className="flex h-8 w-8 items-center justify-center text-muted-foreground">
                <MoreHorizontal className="size-4 opacity-0" />
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
            <section className="border-b border-border/70 px-4 py-6">
              <div className="flex flex-col items-center text-center">
                <ChatAvatar
                  name={title}
                  avatarUrl={conversation.avatarUrl}
                  entityType="conversation"
                  size="lg"
                  className="size-16"
                />
                <h2 className="mt-4 max-w-full truncate text-base font-semibold text-foreground">
                  {title}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {memberSummary}
                </p>
              </div>
            </section>

            <section className="px-4 py-5">
              <div className="mb-4 text-sm font-medium text-foreground">
                Members
              </div>
              <div className="divide-y divide-border/70 rounded-3xl border border-border/70 bg-background">
                {orderedMembers.map((member) => {
                  const href = getConversationMemberContactHref(
                    member,
                    contactBasePath
                  );
                  const subtitle = getConversationMemberSubtitle(member);
                  const canOpen = Boolean(onMemberClick || href);
                  return (
                  <button
                    key={`${member.type}-${member.id}`}
                    type="button"
                    onClick={() => {
                      if (onMemberClick) {
                        onMemberClick(member);
                        return;
                      }
                      if (!href) return;
                      onOpenChange(false);
                      router.push(href);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/25 disabled:cursor-default disabled:hover:bg-transparent"
                    disabled={!canOpen}
                  >
                    <ChatAvatar
                      name={member.name}
                      avatarUrl={member.avatarUrl}
                      emoji={member.emoji}
                      entityType={member.type}
                      size="lg"
                      className="size-12"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {member.name}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {subtitle}
                      </div>
                    </div>
                  </button>
                )})}
              </div>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
