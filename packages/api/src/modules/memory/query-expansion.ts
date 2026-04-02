const STOP_WORDS_EN = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'can', 'may', 'might',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'about', 'into', 'through',
  'and', 'or', 'but', 'if', 'then', 'because', 'as', 'while', 'when', 'where', 'what', 'which', 'who', 'how', 'why',
  'yesterday', 'today', 'tomorrow', 'earlier', 'later', 'recently', 'before', 'after', 'ago', 'just', 'now',
  'thing', 'things', 'stuff', 'something', 'anything', 'everything', 'nothing',
  'please', 'help', 'find', 'show', 'get', 'tell', 'give',
]);

const STOP_WORDS_ZH = new Set([
  '我', '我们', '你', '你们', '他', '她', '它', '他们', '她们', '它们',
  '这个', '那个', '这些', '那些', '这里', '那里', '这个人', '那个东西',
  '是', '有', '在', '了', '着', '过', '和', '跟', '与', '及', '并', '而', '但', '或者', '还是',
  '把', '被', '给', '向', '对', '从', '到', '于', '关于', '有关',
  '今天', '昨天', '明天', '刚刚', '现在', '最近', '之前', '以后', '后来', '当时',
  '一下', '一下子', '一下儿', '一下下', '一下吧',
  '什么', '哪个', '哪些', '怎么', '为什么', '多少', '几',
  '请', '帮', '帮忙', '告诉', '看看', '问下',
  '那个', '那个事', '那个东西', '这件事', '这事', '事情', '东西',
  '吗', '呢', '啊', '呀', '吧', '哦', '啦',
  '我的', '你的', '他的', '她的', '它的', '我们的', '你们的', '他们的',
  '啥', '什么的',
]);

const HAN_SEGMENT_RE = /[\u4e00-\u9fff]+/;
const TOKEN_SEGMENT_RE = /[a-z0-9_]+|[\u4e00-\u9fff]+/giu;

function isHanToken(token: string) {
  return HAN_SEGMENT_RE.test(token);
}

function normalizeSegment(segment: string) {
  return segment.trim().toLowerCase();
}

function tokenizeSegment(segment: string) {
  const normalized = normalizeSegment(segment);
  if (!normalized) return [];

  if (!isHanToken(normalized)) {
    return [normalized];
  }

  const chars = Array.from(normalized);
  const tokens = [...chars];
  for (let index = 0; index < chars.length - 1; index += 1) {
    tokens.push(chars[index] + chars[index + 1]);
  }
  return tokens;
}

function isStopWord(token: string) {
  return STOP_WORDS_EN.has(token) || STOP_WORDS_ZH.has(token);
}

function isValidKeyword(token: string) {
  if (!token) return false;
  if (/^\d+$/u.test(token)) return false;
  if (isHanToken(token)) {
    return Array.from(token).length >= 2;
  }
  return token.length >= 2;
}

export function tokenizeMemorySearchText(text: string) {
  const segments = text.match(TOKEN_SEGMENT_RE) ?? [];
  const tokens: string[] = [];

  for (const segment of segments) {
    tokens.push(...tokenizeSegment(segment));
  }

  return Array.from(new Set(tokens.map(normalizeSegment).filter(Boolean)));
}

export function extractMemoryKeywords(queryText: string) {
  const segments = queryText.match(TOKEN_SEGMENT_RE) ?? [];
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    for (const token of tokenizeSegment(segment)) {
      if (isStopWord(token) || !isValidKeyword(token) || seen.has(token)) {
        continue;
      }
      seen.add(token);
      keywords.push(token);
    }
  }

  return keywords;
}

export function normalizeHanKeywordQuery(queryText: string, limit = 8) {
  const keywords = extractMemoryKeywords(queryText);
  const normalized: string[] = [];

  for (const token of keywords) {
    if (isHanToken(token) && Array.from(token).length < 2) {
      continue;
    }
    if (!isHanToken(token) && token.length < 2) {
      continue;
    }
    normalized.push(token);
    if (normalized.length >= limit) {
      break;
    }
  }

  return normalized.join(' ');
}

export function expandMemoryLexicalQueries(queryText: string, options?: {
  keywordLimit?: number;
}) {
  const normalized = queryText.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];

  const keywordLimit = options?.keywordLimit ?? 8;
  const keywords = extractMemoryKeywords(normalized).slice(0, keywordLimit).join(' ');
  const hanNormalized = normalizeHanKeywordQuery(normalized, keywordLimit);

  return Array.from(new Set([normalized, keywords, hanNormalized].map((value) => value.trim()).filter(Boolean)));
}
