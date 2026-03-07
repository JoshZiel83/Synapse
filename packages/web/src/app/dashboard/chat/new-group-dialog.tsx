'use client';

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { Send, Bot, Star } from 'lucide-react';

interface Actor {
  id: string;
  name: string;
  role: string;
  title?: string;
  config?: { avatar_emoji?: string };
}

interface NewGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onCreateGroup: (actorId: string, content: string) => void;
  preselectedActorId?: string;
}

export default function NewGroupDialog({ open, onOpenChange, workspaceId, onCreateGroup, preselectedActorId }: NewGroupDialogProps) {
  const [actors, setActors] = useState<Actor[]>([]);
  const [selectedActor, setSelectedActor] = useState<Actor | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !workspaceId) return;
    (async () => {
      try {
        const data = await api.getActors(workspaceId);
        const list: Actor[] = data?.actors || data || [];
        // Sort: secretary first
        list.sort((a, b) => {
          if (a.role === 'secretary') return -1;
          if (b.role === 'secretary') return 1;
          return a.name.localeCompare(b.name);
        });
        setActors(list);

        // Auto-select preselected actor
        if (preselectedActorId) {
          const found = list.find((a) => a.id === preselectedActorId);
          if (found) setSelectedActor(found);
        }
      } catch (err) {
        console.error('Failed to load actors:', err);
      }
    })();
  }, [open, workspaceId, preselectedActorId]);

  useEffect(() => {
    if (!open) {
      setSelectedActor(null);
      setMessage('');
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedActor || !message.trim()) return;

    setLoading(true);
    try {
      onCreateGroup(selectedActor.id, message.trim());
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="glass-card border-blue-500/10 max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-foreground">New Conversation</DialogTitle>
        </DialogHeader>

        {!selectedActor ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Select an actor to chat with:</p>
            <ScrollArea className="max-h-[400px]">
              <div className="space-y-2">
                {actors.map((actor) => (
                  <button
                    key={actor.id}
                    onClick={() => setSelectedActor(actor)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 transition-all text-left group"
                  >
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg flex items-center justify-center text-lg shrink-0">
                      {actor.config?.avatar_emoji || <Bot className="w-5 h-5 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{actor.name}</span>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">{actor.role}</Badge>
                        {actor.role === 'secretary' && (
                          <Badge className="text-[10px] px-1.5 py-0 bg-amber-500/10 text-amber-400 border-amber-500/20">
                            <Star className="w-2.5 h-2.5 mr-0.5" />
                            Recommended
                          </Badge>
                        )}
                      </div>
                      {actor.title && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{actor.title}</p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex items-center gap-3 p-3 rounded-xl bg-white/5">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-lg shrink-0">
                {selectedActor.config?.avatar_emoji || <Bot className="w-5 h-5 text-white" />}
              </div>
              <div>
                <span className="text-sm font-medium text-foreground">{selectedActor.name}</span>
                <p className="text-xs text-muted-foreground">{selectedActor.title || selectedActor.role}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto text-xs text-muted-foreground"
                onClick={() => setSelectedActor(null)}
              >
                Change
              </Button>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Your message:</label>
              <div className="flex gap-2">
                <Input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder={`Message ${selectedActor.name}...`}
                  className="flex-1 bg-background/50 border-border/50 rounded-xl h-11 text-sm"
                  autoFocus
                  disabled={loading}
                />
                <Button
                  type="submit"
                  disabled={!message.trim() || loading}
                  className="bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white rounded-xl h-11 w-11 p-0 shadow-lg"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
