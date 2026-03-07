'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useWorkspace } from '../workspace-provider';
import { useWebSocket } from '@/hooks/use-websocket';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Send,
  Bot,
  User,
  Sparkles,
  RotateCcw,
  Info,
  X,
  Cpu,
  Clock,
  Zap,
} from 'lucide-react';

interface ChatMessage {
  id?: string;
  type?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
  // AI request log fields
  logModelName?: string;
  logProviderType?: string;
  logGroupName?: string;
  logInputTokens?: number;
  logOutputTokens?: number;
  logLatencyMs?: number;
  logStatus?: string;
}

function mapApiMessages(msgs: any[]): ChatMessage[] {
  return msgs.map((m) => ({
    id: m.id,
    type: m.type,
    role: m.type === 'user_message' ? 'user' as const : 'assistant' as const,
    content: m.content,
    timestamp: m.created_at || m.createdAt,
    logModelName: m.log_model_name || undefined,
    logProviderType: m.log_provider_type || undefined,
    logGroupName: m.log_group_name || undefined,
    logInputTokens: m.log_input_tokens != null ? Number(m.log_input_tokens) : undefined,
    logOutputTokens: m.log_output_tokens != null ? Number(m.log_output_tokens) : undefined,
    logLatencyMs: m.log_latency_ms != null ? Number(m.log_latency_ms) : undefined,
    logStatus: m.log_status || undefined,
  }));
}

function RequestInfoPopup({ msg, onClose }: { msg: ChatMessage; onClose: () => void }) {
  return (
    <div className="absolute bottom-full mb-2 right-0 z-50 w-72 glass-card rounded-xl border border-blue-500/20 shadow-xl shadow-black/20 p-4 text-xs">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-foreground flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-blue-400" />
          Request Details
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-2.5">
        {msg.logModelName && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Model</span>
            <Badge className="bg-violet-500/10 text-violet-400 border-violet-500/20 text-xs font-mono">
              {msg.logModelName}
            </Badge>
          </div>
        )}
        {msg.logProviderType && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Provider</span>
            <span className="text-foreground capitalize">{msg.logProviderType}</span>
          </div>
        )}
        {msg.logGroupName && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Group</span>
            <span className="text-foreground">{msg.logGroupName}</span>
          </div>
        )}
        {msg.logInputTokens != null && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Input Tokens</span>
            <span className="text-foreground font-mono">{msg.logInputTokens.toLocaleString()}</span>
          </div>
        )}
        {msg.logOutputTokens != null && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Output Tokens</span>
            <span className="text-foreground font-mono">{msg.logOutputTokens.toLocaleString()}</span>
          </div>
        )}
        {msg.logLatencyMs != null && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Latency</span>
            <span className="text-foreground font-mono flex items-center gap-1">
              <Clock className="w-3 h-3 text-blue-400" />
              {msg.logLatencyMs >= 1000 ? `${(msg.logLatencyMs / 1000).toFixed(1)}s` : `${msg.logLatencyMs}ms`}
            </span>
          </div>
        )}
        {msg.logStatus && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">Status</span>
            <Badge className={`text-xs ${
              msg.logStatus === 'success'
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-red-500/10 text-red-400 border-red-500/20'
            }`}>
              {msg.logStatus}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SecretaryPage() {
  const { workspaceId } = useWorkspace();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [infoMsgId, setInfoMsgId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const lastMsgCountRef = useRef(0);

  const loadConversation = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await api.getConversation(workspaceId);
      const msgs = data?.messages || data || [];
      if (Array.isArray(msgs)) {
        const mapped = mapApiMessages(msgs);
        setMessages(mapped);
        return mapped.length;
      }
    } catch (err) {
      console.error('Failed to load conversation:', err);
    }
    return 0;
  }, [workspaceId]);

  // WS event handler
  const onEvent = useCallback((event: any) => {
    if (
      event?.type === 'secretary.response' ||
      event?.type === 'message.created' ||
      event?.type === 'actor.action'
    ) {
      loadConversation();
      stopPolling();
    }
  }, [loadConversation]);

  useWebSocket({ workspaceId, onEvent });

  // Initial load
  useEffect(() => {
    if (!workspaceId) return;
    loadConversation().then((count) => {
      lastMsgCountRef.current = count || 0;
      setLoading(false);
    });
  }, [workspaceId, loadConversation]);

  // Auto-scroll on new messages
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  function scrollToBottom() {
    if (scrollRef.current) {
      setTimeout(() => {
        scrollRef.current!.scrollTop = scrollRef.current!.scrollHeight;
      }, 50);
    }
  }

  function startPolling() {
    stopPolling();
    let attempts = 0;
    pollingRef.current = setInterval(async () => {
      attempts++;
      const count = await loadConversation();
      if ((count && count > lastMsgCountRef.current) || attempts > 30) {
        lastMsgCountRef.current = count || 0;
        stopPolling();
        setSending(false);
      }
    }, 2000);
  }

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  useEffect(() => {
    return () => stopPolling();
  }, []);

  async function handleNewConversation() {
    if (!workspaceId) return;
    if (!confirm('Start a new conversation? Chat history will be cleared, but memories are preserved.')) return;
    try {
      await api.clearConversation(workspaceId);
      setMessages([]);
      lastMsgCountRef.current = 0;
    } catch (err) {
      console.error('Failed to clear conversation:', err);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || !workspaceId || sending) return;

    const content = input.trim();
    const userMessage: ChatMessage = {
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    lastMsgCountRef.current = messages.length + 1;
    setInput('');
    setSending(true);

    try {
      await api.sendMessage(workspaceId, content);
      startPolling();
    } catch (err: any) {
      console.error('Failed to send message:', err);
      setSending(false);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Sorry, I encountered an error. Please try again.',
          timestamp: new Date().toISOString(),
        },
      ]);
    }

    inputRef.current?.focus();
  }

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-4">
          <Bot className="w-16 h-16 mx-auto text-muted-foreground/50" />
          <p className="text-muted-foreground">No workspace selected. Create or select a workspace first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-violet-600 shadow-lg shadow-blue-500/20 flex items-center justify-center">
          <Sparkles className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">AI Secretary</h1>
          <p className="text-sm text-muted-foreground">Your intelligent workforce coordinator</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleNewConversation}
            disabled={sending || messages.length === 0}
            className="border-border/50 hover:bg-white/5 text-muted-foreground text-xs"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            New Chat
          </Button>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full glass-card">
            <div className={`w-2 h-2 rounded-full ${sending ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
            <span className="text-xs text-muted-foreground">{sending ? 'Thinking...' : 'Ready'}</span>
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <Card className="flex-1 glass-card border-blue-500/5 flex flex-col overflow-hidden">
        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
              <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-blue-500/20 to-violet-500/20 flex items-center justify-center">
                <Bot className="w-10 h-10 text-blue-400" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground mb-2">Start a Conversation</h3>
                <p className="text-sm text-muted-foreground max-w-md">
                  I&apos;m your AI secretary. I can help you manage digital employees,
                  delegate tasks, and keep track of your organization&apos;s activities.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                {[
                  'Show me the org structure',
                  'What can the team do?',
                  'Create a new task',
                  'Give me a status report',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="px-3 py-2 text-xs rounded-xl glass-card hover:bg-blue-500/10 text-muted-foreground hover:text-blue-400 transition-all duration-200 border border-transparent hover:border-blue-500/20"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg, i) => (
              <div
                key={msg.id || i}
                className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
              >
                <Avatar className="h-8 w-8 shrink-0 mt-1">
                  <AvatarFallback
                    className={
                      msg.role === 'user'
                        ? 'bg-gradient-to-br from-blue-500 to-blue-600 text-white text-xs'
                        : 'bg-gradient-to-br from-violet-500 to-purple-600 text-white text-xs'
                    }
                  >
                    {msg.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                  </AvatarFallback>
                </Avatar>
                <div
                  className={`
                    max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed
                    ${
                      msg.role === 'user'
                        ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-tr-sm'
                        : 'glass-card text-foreground rounded-tl-sm'
                    }
                  `}
                >
                  {msg.role === 'assistant' ? (
                    <div className="prose prose-invert prose-sm max-w-none
                      prose-p:my-1.5 prose-p:leading-relaxed
                      prose-headings:text-foreground prose-headings:font-semibold prose-headings:mt-3 prose-headings:mb-1.5
                      prose-h1:text-base prose-h2:text-sm prose-h3:text-sm
                      prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
                      prose-code:text-blue-300 prose-code:bg-blue-500/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
                      prose-pre:bg-black/30 prose-pre:border prose-pre:border-blue-500/10 prose-pre:rounded-lg prose-pre:my-2
                      prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                      prose-strong:text-foreground
                      prose-blockquote:border-blue-500/30 prose-blockquote:text-muted-foreground
                      prose-table:text-xs prose-th:text-foreground prose-td:text-muted-foreground
                      prose-hr:border-blue-500/10"
                    >
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap">{msg.content}</p>
                  )}
                  {msg.timestamp && (
                    <div className={`flex items-center gap-1.5 mt-2 ${
                      msg.role === 'user' ? 'text-blue-200/60 justify-end' : 'text-muted-foreground/60'
                    }`}>
                      <span className="text-xs">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                      {msg.role === 'assistant' && msg.logModelName && (
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setInfoMsgId(infoMsgId === (msg.id || String(i)) ? null : (msg.id || String(i)));
                            }}
                            className="inline-flex items-center gap-1 text-muted-foreground/60 hover:text-blue-400 transition-colors ml-1"
                            title="View request details"
                          >
                            <Info className="w-3.5 h-3.5" />
                          </button>
                          {infoMsgId === (msg.id || String(i)) && (
                            <RequestInfoPopup
                              msg={msg}
                              onClose={() => setInfoMsgId(null)}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {/* Thinking indicator */}
          {sending && (
            <div className="flex gap-3">
              <Avatar className="h-8 w-8 shrink-0 mt-1">
                <AvatarFallback className="bg-gradient-to-br from-violet-500 to-purple-600 text-white text-xs">
                  <Bot className="w-4 h-4" />
                </AvatarFallback>
              </Avatar>
              <div className="glass-card rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                    <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                    <div className="w-2 h-2 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span className="text-xs text-muted-foreground ml-2">Secretary is thinking...</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div className="p-4 border-t border-blue-500/5">
          <form onSubmit={handleSend} className="flex gap-3">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message to your AI secretary..."
              className="flex-1 bg-background/50 border-border/50 focus:border-blue-500/50 rounded-xl h-12 text-sm"
              disabled={sending}
            />
            <Button
              type="submit"
              disabled={!input.trim() || sending}
              className="bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 text-white rounded-xl h-12 w-12 p-0 shadow-lg shadow-blue-500/20 transition-all duration-300"
            >
              <Send className="w-5 h-5" />
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
