-- IM transport refactor migration: reaction id persistence + reply/thread refs.
--
-- After commit 10, every active reaction the bot adds is persisted on the
-- transport_message_links row, so the IM module can clean up orphan reactions
-- after a process restart instead of losing the reaction_id from memory.
--
-- This file is idempotent (IF NOT EXISTS / IF NOT EXISTS columns guarded).

ALTER TABLE transport_message_links
  ADD COLUMN IF NOT EXISTS external_reply_to_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS external_thread_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS external_emoji_reactions JSONB NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_transport_message_links_reply_to
  ON transport_message_links(transport_endpoint_id, external_reply_to_id)
  WHERE external_reply_to_id IS NOT NULL;
