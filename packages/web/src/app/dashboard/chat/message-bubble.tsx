'use client';

import { useState, useMemo } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bot, User, GitBranch, Wrench, Search, Globe, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ServerToolCall } from '@/stores/chat-store';

interface MessageBubbleProps {
  role: string;
  content: string;
  actorName?: string;
  actorEmoji?: string;
  actorRole?: string;
  timestamp?: string;
  isUser: boolean;
  status?: 'sending' | 'sent';
  toolsUsed?: string[];
  serverToolCalls?: ServerToolCall[];
  citationSources?: Record<string, { url: string; title: string }>;
}

function formatToolsUsed(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const entries = Array.from(counts.entries());
  const names = entries.map(([name, count]) => count > 1 ? `${name} x${count}` : name);
  const total = tools.length;
  if (names.length <= 3) {
    return `Used ${names.join(', ')} (${total} tool call${total > 1 ? 's' : ''})`;
  }
  return `Used ${names.slice(0, 2).join(', ')} + ${names.length - 2} more (${total} tool call${total > 1 ? 's' : ''})`;
}

/**
 * Process <cite index="X-Y">text</cite> tags from Anthropic responses.
 * Returns processed content (cite tags replaced with text + superscript markers)
 * and a list of unique sources referenced.
 */
function processCitations(
  content: string,
  citationSources?: Record<string, { url: string; title: string }>,
): { processedContent: string; sources: { num: number; url: string; title: string }[] } {
  if (!citationSources || Object.keys(citationSources).length === 0) {
    return { processedContent: content, sources: [] };
  }

  const usedSources: { num: number; url: string; title: string }[] = [];
  const urlToNum = new Map<string, number>();

  const processedContent = content.replace(
    /<cite\s+index="([^"]+)">([\s\S]*?)<\/cite>/g,
    (_match, indices: string, text: string) => {
      const indexList = indices.split(',').map((s: string) => s.trim());
      const refNums: number[] = [];

      for (const idx of indexList) {
        // Look up source by exact key or cit- prefixed key
        const source = citationSources[idx] || citationSources[`cit-${idx}`];
        if (!source) continue;

        if (!urlToNum.has(source.url)) {
          const num = usedSources.length + 1;
          urlToNum.set(source.url, num);
          usedSources.push({ num, url: source.url, title: source.title });
        }
        refNums.push(urlToNum.get(source.url)!);
      }

      if (refNums.length === 0) return text;

      // Deduplicate and format as superscript notation
      const unique = Array.from(new Set(refNums));
      const sup = unique.map((n) => `^[${n}]`).join('');
      return `${text}${sup}`;
    },
  );

  // Also check if there are citation sources not referenced by <cite> tags
  // (structured citations from Anthropic text blocks or OpenAI url_citations)
  for (const [key, source] of Object.entries(citationSources)) {
    if ((key.startsWith('cit-') || key.startsWith('oai-')) && !urlToNum.has(source.url)) {
      const num = usedSources.length + 1;
      urlToNum.set(source.url, num);
      usedSources.push({ num, url: source.url, title: source.title });
    }
  }

  return { processedContent, sources: usedSources };
}

function CitationFooter({ sources }: { sources: { num: number; url: string; title: string }[] }) {
  if (sources.length === 0) return null;

  return (
    <div className="mt-3 pt-2 border-t border-white/5">
      <div className="text-[10px] text-muted-foreground/50 mb-1.5 font-medium">Sources</div>
      <div className="space-y-0.5">
        {sources.map((s) => (
          <a
            key={s.num}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60 hover:text-blue-400 transition-colors group/src"
          >
            <span className="text-muted-foreground/40 shrink-0 w-3 text-right">{s.num}.</span>
            <ExternalLink className="w-2.5 h-2.5 mt-0.5 shrink-0 opacity-0 group-hover/src:opacity-100 transition-opacity" />
            <span className="truncate">{s.title || s.url}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function ServerToolCallDisplay({ calls }: { calls: ServerToolCall[] }) {
  const [expanded, setExpanded] = useState(false);

  if (calls.length === 0) return null;

  const searchCalls = calls.filter((c) => c.type === 'web_search');
  const fetchCalls = calls.filter((c) => c.type === 'web_fetch');
  const totalResults = searchCalls.reduce((sum, c) => sum + (c.results?.length || 0), 0);

  // Compact summary line
  const parts: string[] = [];
  if (searchCalls.length > 0) {
    parts.push(`${searchCalls.length} search${searchCalls.length > 1 ? 'es' : ''}`);
  }
  if (fetchCalls.length > 0) {
    parts.push(`${fetchCalls.length} fetch${fetchCalls.length > 1 ? 'es' : ''}`);
  }

  return (
    <div className="mt-2 border-t border-white/5 pt-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors w-full text-left"
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="font-medium">
          {parts.join(', ')}
          {totalResults > 0 && ` · ${totalResults} result${totalResults > 1 ? 's' : ''}`}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-2">
          {searchCalls.map((call, i) => (
            <div key={`search-${i}`} className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-blue-400/80">
                <Search className="w-3 h-3" />
                <span className="font-medium">Web Search</span>
              </div>
              {call.query && (
                <p className="text-[11px] text-foreground/80 mt-1 font-mono bg-white/[0.03] rounded px-2 py-1">
                  {call.query}
                </p>
              )}
              {call.results && call.results.length > 0 && (
                <div className="mt-1.5 space-y-1">
                  {call.results.slice(0, 5).map((r, j) => (
                    <a
                      key={j}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60 hover:text-blue-400 transition-colors group/link"
                    >
                      <ExternalLink className="w-2.5 h-2.5 mt-0.5 shrink-0 opacity-0 group-hover/link:opacity-100 transition-opacity" />
                      <span className="truncate">
                        <span className="text-foreground/60 group-hover/link:text-blue-400">{r.title || r.url}</span>
                        {r.pageAge && <span className="ml-1 text-muted-foreground/40">· {r.pageAge}</span>}
                      </span>
                    </a>
                  ))}
                  {call.results.length > 5 && (
                    <span className="text-[10px] text-muted-foreground/40 ml-4">
                      +{call.results.length - 5} more results
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}

          {fetchCalls.map((call, i) => (
            <div key={`fetch-${i}`} className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-emerald-400/80">
                <Globe className="w-3 h-3" />
                <span className="font-medium">Web Fetch</span>
              </div>
              {call.url && (
                <a
                  href={call.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-muted-foreground/60 hover:text-emerald-400 mt-1 block truncate transition-colors"
                >
                  {call.url}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MessageBubble({
  role,
  content,
  actorName,
  actorEmoji,
  timestamp,
  isUser,
  status,
  toolsUsed,
  serverToolCalls,
  citationSources,
}: MessageBubbleProps) {
  const isChildResult = role === 'child_result';
  const isSystem = role === 'system';

  // Process citations and sanitize raw HTML tags
  const { processedContent, sources } = useMemo(
    () => {
      // Replace <br>, <br/>, <br /> with newlines so ReactMarkdown renders them
      const sanitized = content.replace(/<br\s*\/?>/gi, '\n');
      return processCitations(sanitized, citationSources);
    },
    [content, citationSources],
  );

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="text-xs text-muted-foreground/60 bg-white/5 rounded-full px-4 py-1.5 max-w-[80%] text-center">
          {content.length > 200 ? content.substring(0, 200) + '...' : content}
        </div>
      </div>
    );
  }

  const hasServerToolCalls = serverToolCalls && serverToolCalls.length > 0;
  const hasToolsUsed = toolsUsed && toolsUsed.length > 0;
  const hasCitations = sources.length > 0;

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <Avatar className="h-8 w-8 shrink-0 mt-1">
        <AvatarFallback
          className={
            isUser
              ? 'bg-gradient-to-br from-blue-500 to-blue-600 text-white text-xs'
              : isChildResult
              ? 'bg-gradient-to-br from-amber-500 to-orange-600 text-white text-xs'
              : 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white text-xs'
          }
        >
          {isUser ? (
            <User className="w-4 h-4" />
          ) : isChildResult ? (
            <GitBranch className="w-4 h-4" />
          ) : actorEmoji ? (
            <span className="text-sm">{actorEmoji}</span>
          ) : (
            <Bot className="w-4 h-4" />
          )}
        </AvatarFallback>
      </Avatar>

      <div className={`max-w-[75%] min-w-0 ${isUser ? 'items-end' : 'items-start'} flex flex-col`}>
        {!isUser && actorName && (
          <span className="text-xs text-muted-foreground/70 mb-1 ml-1">{actorName}</span>
        )}
        <div
          className={`
            rounded-2xl px-4 py-3 text-sm leading-relaxed
            ${isUser
              ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white rounded-tr-sm'
              : isChildResult
              ? 'glass-card border border-amber-500/20 text-foreground rounded-tl-sm'
              : 'glass-card text-foreground rounded-tl-sm'
            }
          `}
        >
          {!isUser ? (
            <div className="prose prose-invert prose-sm max-w-none prose-p:my-1.5 prose-headings:text-foreground prose-code:text-blue-300 prose-code:bg-blue-500/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono prose-code:before:content-none prose-code:after:content-none prose-pre:bg-black/30 prose-pre:border prose-pre:border-blue-500/10 prose-pre:rounded-lg">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{processedContent}</ReactMarkdown>
            </div>
          ) : (
            <p className="whitespace-pre-wrap">{content}</p>
          )}

          {/* Citation sources footer */}
          {hasCitations && <CitationFooter sources={sources} />}

          {/* Server tool calls (web_search / web_fetch) — inside the bubble */}
          {hasServerToolCalls && (
            <ServerToolCallDisplay calls={serverToolCalls} />
          )}
        </div>
        <div className={`flex items-center gap-2 mt-1 ${isUser ? 'flex-row-reverse' : ''}`}>
          {timestamp && (
            <span className="text-[10px] text-muted-foreground/50">
              {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {status === 'sending' && (
            <span className="text-[10px] text-muted-foreground/40">Sending...</span>
          )}
          {hasToolsUsed && !hasServerToolCalls && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/50">
              <Wrench className="w-2.5 h-2.5" />
              {formatToolsUsed(toolsUsed)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
