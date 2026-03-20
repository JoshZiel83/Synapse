'use client';

import { ArrowDown, MoreHorizontal } from 'lucide-react';

import ChatAvatar from '@/app/dashboard/chat/chat-avatar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { Group, GroupMember } from '@/stores/chat-store';

function summarizeMemberCounts(group: Group) {
  const userCount = group.members.filter((member) => member.type === 'user').length;
  const actorCount = group.members.filter((member) => member.type === 'actor').length;
  const userLabel = `${userCount} user${userCount === 1 ? '' : 's'}`;
  const actorLabel = `${actorCount} actor${actorCount === 1 ? '' : 's'}`;
  return `${userLabel} · ${actorLabel}`;
}

function orderMembers(members: GroupMember[]) {
  return [...members].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'actor' ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

interface MobileGroupDetailsDialogProps {
  group: Group;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function MobileGroupDetailsDialog({
  group,
  open,
  onOpenChange,
}: MobileGroupDetailsDialogProps) {
  const title = group.title || group.participants.map((participant) => participant.name).join(', ');
  const memberSummary = summarizeMemberCounts(group);
  const orderedMembers = orderMembers(group.members);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="inset-0 top-0 start-0 h-[100dvh] max-w-none translate-x-0 rtl:translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 ring-0"
      >
        <DialogTitle className="sr-only">Group details</DialogTitle>
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
                  Group details
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
                  avatarUrl={group.avatarUrl}
                  entityType="group"
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
              <div className="grid grid-cols-4 gap-x-3 gap-y-5">
                {orderedMembers.map((member) => (
                  <div
                    key={`${member.type}-${member.id}`}
                    className="flex min-w-0 flex-col items-center gap-2"
                  >
                    <ChatAvatar
                      name={member.name}
                      avatarUrl={member.avatarUrl}
                      emoji={member.emoji}
                      entityType={member.type}
                      size="lg"
                      className="size-12"
                    />
                    <div className="w-full truncate text-center text-xs text-foreground">
                      {member.name}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
