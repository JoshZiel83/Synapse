'use client';

import { useState, useMemo } from 'react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bot, User, GitBranch, Wrench, Search, Globe, ChevronDown, ChevronRight, ExternalLink, FileIcon, Download, AlertTriangle, AtSign } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CanonicalContentBlock } from '@synapse/shared';
import { extractText } from '@synapse/shared';
import type { ServerToolCall } from '@/stores/chat-store';
import { resolveFileUrl } from '@/lib/utils';

interface MessageBubbleProps {
  role: string;
  contentBlocks: CanonicalContentBlock[];
  actorName?: string;
  actorEmoji?: string;
  actorRole?: string;
  timestamp?: string;
  isUser: boolean;
  status?: 'sending' | 'sent';
  toolsUsed?: string[];
  serverToolCalls?: ServerToolCall[];
  citationSources?: Record<string, { url: string; title: string }>;
  coordination?: boolean;
  targetActorNames?: string[];
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
    <div className="mt-3 pt-2 border-t border-gray-200 dark:border-white/5">
      <div className="text-[10px] text-muted-foreground/50 mb-1.5 font-medium">Sources</div>
      <div className="space-y-0.5">
        {sources.map((s) => (
          <a
            key={s.num}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors group/src"
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type FileRefBlock = Extract<CanonicalContentBlock, { type: 'file_ref' }>;
const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.m4a', '.flac', '.aac', '.wma'];

function FileBlockPreview({ blocks }: { blocks: FileRefBlock[] }) {
  const [expandedImage, setExpandedImage] = useState<string | null>(null);

  if (blocks.length === 0) return null;

  return (
    <>
      <div className="space-y-2 mb-2">
        {blocks.map((block) => {
          const cat = block.category;
          const resolvedUrl = resolveFileUrl(block.url) || block.url;

          if (cat === 'image') {
            return (
              <div key={block.fileId}>
                <img
                  src={resolvedUrl}
                  alt={block.originalName}
                  className="max-w-full max-h-64 rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => setExpandedImage(resolvedUrl)}
                />
              </div>
            );
          }

          if (cat === 'audio') {
            return (
              <div key={block.fileId} className="rounded-lg bg-gray-50 dark:bg-white/[0.03] ring-1 ring-gray-200 dark:ring-white/[0.06] p-2.5">
                <div className="text-[11px] text-muted-foreground mb-1.5 truncate">{block.originalName}</div>
                <audio controls className="w-full h-8" preload="metadata">
                  <source src={resolvedUrl} type={block.mimeType} />
                </audio>
              </div>
            );
          }

          if (cat === 'video') {
            return (
              <div key={block.fileId}>
                <video
                  controls
                  className="max-w-full max-h-64 rounded-lg"
                  preload="metadata"
                >
                  <source src={resolvedUrl} type={block.mimeType} />
                </video>
              </div>
            );
          }

          // Document
          return (
            <a
              key={block.fileId}
              href={resolvedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2.5 rounded-lg bg-gray-50 dark:bg-white/[0.03] ring-1 ring-gray-200 dark:ring-white/[0.06] p-2.5 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition-colors group/file"
            >
              <div className="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center shrink-0">
                <FileIcon className="w-4 h-4 text-indigo-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-foreground/80 truncate">{block.originalName}</div>
                <div className="text-[10px] text-muted-foreground/50">{formatBytes(block.sizeBytes)}</div>
              </div>
              <Download className="w-3.5 h-3.5 text-muted-foreground/40 group-hover/file:text-indigo-500 transition-colors shrink-0" />
            </a>
          );
        })}
      </div>

      {/* Image lightbox */}
      {expandedImage && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setExpandedImage(null)}
        >
          <img
            src={expandedImage}
            alt="Expanded"
            className="max-w-full max-h-full object-contain rounded-lg"
          />
        </div>
      )}
    </>
  );
}

function ExpandableImage({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        className="max-w-full max-h-64 rounded-lg cursor-pointer hover:opacity-90 transition-opacity my-2"
        onClick={() => setExpanded(true)}
        {...props}
      />
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 cursor-pointer"
          onClick={() => setExpanded(false)}
        >
          <img src={src} alt={alt || ''} className="max-w-full max-h-full object-contain rounded-lg" />
        </div>
      )}
    </>
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
    <div className="mt-2 border-t border-gray-200 dark:border-white/5 pt-2">
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
            <div key={`search-${i}`} className="rounded-lg bg-gray-50 dark:bg-white/[0.03] ring-1 ring-gray-200 dark:ring-white/[0.06] p-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-indigo-600 dark:text-indigo-400/80">
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
                      className="flex items-start gap-1.5 text-[10px] text-muted-foreground/60 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors group/link"
                    >
                      <ExternalLink className="w-2.5 h-2.5 mt-0.5 shrink-0 opacity-0 group-hover/link:opacity-100 transition-opacity" />
                      <span className="truncate">
                        <span className="text-foreground/60 group-hover/link:text-indigo-500">{r.title || r.url}</span>
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
            <div key={`fetch-${i}`} className="rounded-lg bg-gray-50 dark:bg-white/[0.03] ring-1 ring-gray-200 dark:ring-white/[0.06] p-2.5">
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
  contentBlocks,
  actorName,
  actorEmoji,
  timestamp,
  isUser,
  status,
  toolsUsed,
  serverToolCalls,
  citationSources,
  coordination,
  targetActorNames,
}: MessageBubbleProps) {
  const isChildResult = role === 'child_result';
  const isSystem = role === 'system';
  const isError = role === 'error';
  const textContent = useMemo(() => extractText(contentBlocks), [contentBlocks]);
  const fileBlocks = useMemo(
    () => contentBlocks.filter((block): block is FileRefBlock => block.type === 'file_ref'),
    [contentBlocks],
  );

  // Process citations and sanitize raw HTML tags
  const { processedContent, sources } = useMemo(
    () => {
      // Replace <br>, <br/>, <br /> with newlines so ReactMarkdown renders them
      const sanitized = textContent.replace(/<br\s*\/?>/gi, '\n');
      return processCitations(sanitized, citationSources);
    },
    [citationSources, textContent],
  );

  if (isError) {
    return (
      <div className="flex gap-3">
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-2xl bg-destructive text-destructive-foreground shadow-sm">
          <AlertTriangle className="w-4 h-4 text-white" />
        </div>
        <div className="max-w-[75%] min-w-0 flex flex-col">
          <div className="rounded-3xl rounded-tl-sm border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm leading-relaxed text-destructive shadow-sm">
            <p className="whitespace-pre-wrap">{textContent}</p>
          </div>
          {timestamp && (
            <span className="text-[10px] text-muted-foreground/50 mt-1">
              {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="max-w-[80%] rounded-full border border-border bg-background px-4 py-1.5 text-center text-xs text-muted-foreground shadow-sm">
          {textContent.length > 200 ? textContent.substring(0, 200) + '...' : textContent}
        </div>
      </div>
    );
  }

  const hasServerToolCalls = serverToolCalls && serverToolCalls.length > 0;
  const hasToolsUsed = toolsUsed && toolsUsed.length > 0;
  const hasCitations = sources.length > 0;
  const hasFileBlocks = fileBlocks.length > 0;

  // Coordination messages (send_to between actors) — render in a compact style
  if (coordination && !isUser) {
    return (
      <div className="ml-10 flex gap-2 opacity-70">
        <div className="flex items-start gap-2 max-w-[70%]">
          <AtSign className="mt-1 h-3 w-3 shrink-0 text-primary/60" />
          <div>
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[11px] font-medium text-muted-foreground/80">{actorName}</span>
              {targetActorNames && targetActorNames.length > 0 && (
                <span className="text-[10px] text-primary/60">→ {targetActorNames.join(', ')}</span>
              )}
            </div>
            {hasFileBlocks && <FileBlockPreview blocks={fileBlocks} />}
            <div className="text-xs text-muted-foreground/70 leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {processedContent}
              </ReactMarkdown>
            </div>
            {timestamp && (
              <span className="text-[9px] text-muted-foreground/30 mt-0.5 block">
                {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <Avatar className="h-8 w-8 shrink-0 mt-1">
        <AvatarFallback
          className={
            isUser
              ? 'bg-primary text-primary-foreground text-xs'
              : isChildResult
              ? 'bg-amber-500 text-white text-xs'
              : 'bg-card text-foreground text-xs border border-border'
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
            rounded-3xl border px-4 py-3 text-sm leading-relaxed shadow-sm
            ${isUser
              ? 'rounded-tr-sm border-primary/10 bg-primary text-primary-foreground'
              : isChildResult
              ? 'rounded-tl-sm border-amber-500/20 bg-amber-500/10 text-foreground'
              : 'rounded-tl-sm border-border bg-background text-foreground'
            }
          `}
        >
          {hasFileBlocks && <FileBlockPreview blocks={fileBlocks} />}

          {!isUser ? (
            textContent ? (
            <div className="prose prose-sm max-w-none prose-p:my-1.5 prose-headings:text-foreground prose-code:rounded prose-code:bg-primary/10 prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:text-primary prose-code:before:content-none prose-code:after:content-none prose-pre:rounded-2xl prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-strong:text-foreground dark:prose-invert">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  img: ({ src, alt, ...props }) => <ExpandableImage src={src} alt={alt} {...props} />,
                  a: ({ href, children, ...props }) => {
                    const isAudio = href && AUDIO_EXTENSIONS.some((ext) => href.toLowerCase().endsWith(ext));
                    if (isAudio) {
                      return (
                        <span className="block my-2">
                          <audio controls className="w-full h-8" preload="metadata">
                            <source src={href} />
                          </audio>
                          <span className="text-[10px] text-muted-foreground/50 block mt-0.5">{String(children) || href}</span>
                        </span>
                      );
                    }
                    return (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" {...props}>
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {processedContent}
              </ReactMarkdown>
            </div>
            ) : null
          ) : (
            textContent ? <p className="whitespace-pre-wrap">{textContent}</p> : null
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
