// Shared transcript normalization. Kept identical to the pre-refactor
// audio-fallback behaviour (trim → collapse whitespace → cap length) so the
// migrated sherpa path produces the same shape of text the model used to see.

const MAX_TRANSCRIPT_LENGTH = 4000

export function normalizeTranscript(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, MAX_TRANSCRIPT_LENGTH)
}
