/**
 * Pinyin-aware alphabetical bucketing for A–Z section indexes (e.g. the mobile
 * contacts list). Pure + dependency-free (uses Intl.Collator via localeCompare),
 * so it can be unit-tested in isolation.
 *
 * Extracted from mobile `alphabet-indexed-entity-list.tsx` so the (domain-specific)
 * pinyin boundary logic has a single tested home. The boundary table maps the
 * first sortable hanzi of each pinyin-initial group; a CJK char buckets to the
 * latest boundary it sorts at-or-after. ASCII letters bucket directly; everything
 * else goes to "#".
 *
 * On its own subpath; NOT re-exported from the root barrel.
 */

/** A–Z then "#", the canonical rail order. */
export const ALPHABET_RAIL: readonly string[] = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "#",
]

/**
 * First sortable hanzi of each pinyin-initial group (zh-Hans pinyin collation).
 * Letters with no distinct Chinese initial (I, U, V) are intentionally absent.
 */
export const PINYIN_INITIAL_BOUNDARIES: ReadonlyArray<{
  letter: string
  boundary: string
}> = [
  { letter: "A", boundary: "阿" },
  { letter: "B", boundary: "八" },
  { letter: "C", boundary: "嚓" },
  { letter: "D", boundary: "哒" },
  { letter: "E", boundary: "妸" },
  { letter: "F", boundary: "发" },
  { letter: "G", boundary: "旮" },
  { letter: "H", boundary: "哈" },
  { letter: "J", boundary: "击" },
  { letter: "K", boundary: "喀" },
  { letter: "L", boundary: "垃" },
  { letter: "M", boundary: "妈" },
  { letter: "N", boundary: "拿" },
  { letter: "O", boundary: "哦" },
  { letter: "P", boundary: "啪" },
  { letter: "Q", boundary: "期" },
  { letter: "R", boundary: "然" },
  { letter: "S", boundary: "撒" },
  { letter: "T", boundary: "塌" },
  { letter: "W", boundary: "挖" },
  { letter: "X", boundary: "昔" },
  { letter: "Y", boundary: "压" },
  { letter: "Z", boundary: "匝" },
] as const

/**
 * Locale-aware compare using zh-Hans pinyin collation, falling back to the
 * default locale if the runtime's ICU lacks the pinyin collator. Note: results
 * depend on the runtime's Intl/ICU data, so tests should pin only representative
 * characters and assert the fallback path, not a full ordering guarantee.
 */
export function comparePinyin(left: string, right: string): number {
  try {
    return left.localeCompare(right, "zh-Hans-u-co-pinyin", {
      sensitivity: "base",
    })
  } catch {
    return left.localeCompare(right, undefined, { sensitivity: "base" })
  }
}

/**
 * Bucket a display string to its A–Z rail letter (or "#"). ASCII letter -> itself
 * (uppercased); CJK -> pinyin-initial bucket; anything else -> "#".
 */
export function getAlphabetInitial(value: string): string {
  const first = value.trim().charAt(0)
  if (!first) return "#"

  const upper = first.toUpperCase()
  if (/^[A-Z]$/.test(upper)) return upper

  if (/^[一-鿿]$/.test(first)) {
    for (
      let index = PINYIN_INITIAL_BOUNDARIES.length - 1;
      index >= 0;
      index -= 1
    ) {
      const current = PINYIN_INITIAL_BOUNDARIES[index]
      if (current && comparePinyin(first, current.boundary) >= 0) {
        return current.letter
      }
    }
    return "A"
  }

  return "#"
}
