# IM Transport Integration Design

## Status

Draft for immediate implementation.

Scope:

- Introduce a transport abstraction that supports Feishu and WeChat first.
- Keep the current conversation-centric business model.
- Do not preserve old database compatibility.
- Do not preserve old chat API compatibility where it conflicts with the new model.
- Avoid transport-specific hacks that would block future IM integrations.

Non-goals for this phase:

- Preserving the legacy `communication` / `chat` split as public API.
- Solving every authorization cleanup described in `permissions-redesign.md`.
- Supporting Feishu topic-thread routing in v1.
- Supporting WeChat groups in v1.

## Problem Statement

The current system already has a strong `conversation` runtime model:

- `conversation` is the collaboration context.
- `conversation_members` are the runtime participants.
- `conversation_items` plus `conversation_item_targets` express visible messages and addressed recipients.
- `sessions` and `session_wakeups` model actor execution lanes inside a conversation.

That model is strong enough to absorb IM integration, but the current surface still has two structural limitations:

1. Human participants are modeled only as internal `user`.
2. message targeting is split into `targetActorIds` and `targetUserIds`, which does not scale to external participants and transport delivery.

The new transport layer must fit around `conversation`, not replace it.

## Design Principles

1. `conversation` remains the internal source of truth.
2. External IM chats bind to `conversation`; they do not become a separate chat subsystem.
3. A `conversation` can bind to at most one transport endpoint.
4. A transport endpoint can bind to at most one `conversation`.
5. `participant` is the unit of addressing inside a conversation.
6. `address` is the unit of transport delivery outside a conversation.
7. Actor wake-up continues to be target-driven.
8. Transport delivery is a projection of conversation items, not a side-channel bypass.
9. Only `shared + visible` conversation items may be projected to external IM.
10. Feishu webhook and Feishu long connection are connector runtime modes, not different business concepts.

## Core Concepts

### 1. Conversation

Internal collaboration boundary.

Responsibilities:

- participant membership
- visible transcript
- actor execution context
- memory scope
- transport binding

External group chats and direct chats map into this abstraction.

### 2. Participant

A participant is a runtime entity inside one conversation.

Participant kinds:

- `actor`
- `user`
- `external`
- `system`

Notes:

- `actor` is an executable internal participant.
- `user` is an internal workspace user.
- `external` is a human participant not represented only by the internal `users` table.
- `system` is non-human runtime/system output.

### 3. Address

An address is a transport-reachable identity for a participant.

Examples:

- Feishu user `open_id`
- WeChat direct user id

A participant may have multiple addresses.

Examples:

- one workspace user may have `feishu` and `weixin` addresses
- one external participant may later be linked to an internal workspace user

The conversation addresses a participant first. Delivery resolves the participant to an address under the current binding.

### 4. Transport Account

A configured IM connection instance.

Examples:

- one Feishu app bot with credentials and runtime mode
- one WeChat bot account with login/session material

Responsibilities:

- credentials
- runtime mode
- connector health
- inbound subscription lifecycle
- outbound API access

### 5. Transport Endpoint

A concrete external conversation endpoint.

Examples:

- one Feishu group chat
- one Feishu p2p chat
- one WeChat direct chat

This is what binds to `conversation`.

### 6. Conversation Binding

The 1:1 relation between a `conversation` and a `transport_endpoint`.

Binding-level configuration owns:

- whether external sync is enabled
- default inbound actor target
- default outbound recipient behavior
- transport-specific policy metadata

## Concept Mapping to Current System

Current implementation already has the right shape:

- `conversation_members` is the seed of `conversation_participants`
- `conversation_item_targets` already targets member ids instead of transport ids
- `sessions` are actor lanes scoped to conversation
- `session_wakeups` already separate addressed actor activation from raw message persistence

Implementation direction:

- upgrade `conversation_members` to `conversation_participants`
- stop using `targetActorIds` / `targetUserIds`
- move all message addressing to `targetParticipantIds`

## Hard Rules for V1

1. One conversation cannot bind to both Feishu and WeChat.
2. One bound conversation always sends through its bound endpoint only.
3. External inbound messages always resolve to a participant plus address.
4. Actor wake-up is driven only by targeted actor participants or binding defaults.
5. External mention delivery is driven only by targeted participants with compatible addresses.
6. WeChat v1 supports direct endpoints only.
7. Feishu v1 supports direct and group endpoints.
8. Feishu group members are discovered lazily when they speak.
9. Web mentions must include actors and external human participants, not actors only.
10. `sendTo` records a conversation item first, then delivery happens asynchronously.

## Target Model

### Why actor/user split is no longer sufficient

The current API accepts:

- `targetActorIds`
- `targetUserIds`

This is insufficient because:

- external participants are neither internal actor nor internal user
- transport projection needs a single addressed-participant model
- actor wake-up and external mention delivery should start from the same targeting primitive

### New rule

All user-facing and internal message creation paths move to:

- `targetParticipantIds`

Resolution by participant kind:

- target actor participant: wake actor lane
- target user participant: internal addressing and possible external delivery if an address exists under the binding
- target external participant: external mention / direct delivery only
- target system participant: invalid

## Data Model

### Conversation participants

Rename or replace `conversation_members` with `conversation_participants`.

Required fields:

- `id`
- `conversation_id`
- `participant_type` in `actor | user | external | system`
- `actor_id`
- `user_id`
- `display_name`
- `state`
- `role_key`
- `metadata`
- `joined_at`
- `left_at`

V1 note:

- keep enough shape to preserve current business behavior
- add `external` now rather than inventing transport-specific member tables

### Transport accounts

New table: `transport_accounts`

Fields:

- `id`
- `workspace_id`
- `transport_kind` in `feishu | weixin`
- `account_key`
- `display_name`
- `connection_mode`
- `status`
- `credentials`
- `config`
- `metadata`
- `created_at`
- `updated_at`

Examples:

- Feishu account `main`, mode `websocket`
- Feishu account `main`, mode `webhook`
- WeChat account `primary`, mode `long_poll`

### Transport endpoints

New table: `transport_endpoints`

Fields:

- `id`
- `transport_account_id`
- `endpoint_type` in `direct | group`
- `external_id`
- `parent_external_id`
- `display_name`
- `capabilities`
- `metadata`
- `created_at`
- `updated_at`

Rules:

- unique on `(transport_account_id, endpoint_type, external_id, parent_external_id)`
- Feishu group endpoint is the group chat id
- Feishu direct endpoint is the p2p chat id
- WeChat direct endpoint is the peer id

### Conversation transport bindings

New table: `conversation_transport_bindings`

Fields:

- `conversation_id`
- `transport_endpoint_id`
- `is_enabled`
- `default_inbound_actor_id`
- `default_outbound_participant_id`
- `default_outbound_mode`
- `metadata`
- `created_at`
- `updated_at`

Rules:

- unique `conversation_id`
- unique `transport_endpoint_id`

V1 defaults:

- `default_inbound_actor_id` is required for transport-bound conversations
- `default_outbound_mode` defaults to `plain`

`default_outbound_mode` values:

- `plain`
- `mention_default_participant`
- `mention_last_external_sender`

### Transport addresses

New table: `transport_addresses`

Fields:

- `id`
- `workspace_id`
- `transport_kind`
- `transport_account_id`
- `address_type` in `user`
- `external_id`
- `display_name`
- `linked_user_id`
- `metadata`
- `created_at`
- `updated_at`

Rules:

- unique `(transport_account_id, address_type, external_id)`

Important distinction:

- Feishu `chat_id` belongs in endpoint
- Feishu `open_id` belongs in address

### Participant addresses

New table: `conversation_participant_addresses`

Fields:

- `participant_id`
- `transport_address_id`
- `is_default`
- `capabilities`
- `metadata`
- `created_at`

Capabilities examples:

- `author_inbound`
- `mention_in_group`
- `direct_send`

### Transport message links

New table: `transport_message_links`

Fields:

- `id`
- `conversation_item_id`
- `transport_endpoint_id`
- `direction` in `inbound | outbound`
- `external_message_id`
- `external_reply_to_id`
- `external_thread_id`
- `delivery_status`
- `raw_metadata`
- `created_at`
- `updated_at`

Purpose:

- reply/edit/reaction correlation
- dedupe
- transport traceability

## Participant Resolution Rules

### Inbound external message

1. resolve the transport account
2. resolve or create the transport endpoint
3. resolve the bound conversation, or create one if allowed
4. resolve or create the sender address
5. resolve the conversation participant
6. create a shared visible conversation item authored by that participant
7. target the default inbound actor if routing rules say the message should wake an actor

### Participant lookup order for inbound sender

1. existing participant in this conversation already linked to this address
2. linked internal user already present as a participant in this conversation
3. create a new external participant and attach the address

### Linking external users to workspace users

`transport_addresses.linked_user_id` is the bridge.

This allows:

- an external speaker to later map to a workspace user
- a workspace user to be externally addressable in a bound conversation
- future multi-transport addressing for the same human

## Delivery Rules

### Outbound projection

Only project conversation items when all are true:

- `scope = shared`
- `surface = visible`
- the conversation has an enabled binding

### Address resolution for outbound

1. inspect `targetParticipantIds`
2. resolve participant addresses compatible with the conversation binding
3. if no explicit participant target resolves, apply binding default outbound mode
4. render transport-specific payload
5. send through connector
6. persist `transport_message_links`

### Actor `sendTo`

`sendTo` must not talk to Feishu or WeChat directly.

Instead:

1. create a normal conversation item with `targetParticipantIds`
2. let the outbound transport projector deliver it

Benefits:

- transcript stays complete
- audit remains consistent
- retries are transport-layer concerns
- delivery side effects can be replayed

## Connector Abstraction

New backend abstraction:

`TransportConnector`

Responsibilities:

- account startup/shutdown
- inbound event normalization
- outbound send
- transport capability description

Required connector methods:

- `startAccount`
- `stopAccount`
- `normalizeInboundEnvelope`
- `resolveEndpointRef`
- `resolveSenderAddressRef`
- `sendMessage`
- `supports`

### Feishu connector

Features in v1:

- runtime mode `websocket`
- runtime mode `webhook`
- direct endpoints
- group endpoints
- group mentions

Non-goals in v1:

- full topic-thread session routing
- transport-side slash-command parity with OpenClaw

### WeChat connector

Features in v1:

- runtime mode `long_poll`
- direct endpoints only

Non-goals in v1:

- groups
- mentions

## Backend Service Boundaries

### New module family

Add a new module family under `packages/api/src/modules/im/`.

Suggested files:

- `service.ts`
- `controller.ts`
- `index.ts`
- `types.ts`
- `bindings-service.ts`
- `participants-service.ts`
- `delivery-service.ts`
- `ingest-service.ts`
- `connectors/feishu.ts`
- `connectors/weixin.ts`

### Responsibilities

`bindings-service`

- bind/unbind conversation to endpoint
- read binding config
- auto-create bindings for inbound endpoint discovery

`participants-service`

- resolve external sender to participant
- attach addresses
- link address to workspace user

`ingest-service`

- normalize inbound transport events to conversation items
- compute default actor targets

`delivery-service`

- project conversation items to outbound transport messages
- resolve mention targets
- record delivery results

## Frontend Changes

### Chat store and message shape

Replace actor/user split target fields with participant-oriented fields.

Current:

- `targetActorIds`
- `targetUserIds`

New:

- `targetParticipantIds`
- `targetParticipants`

### Mention input

The chat composer must stop being actor-only.

Mention candidates should include:

- actor participants
- internal user participants
- external participants with discovered names

Behavior:

- mentioning an actor means actor wake-up target
- mentioning a human participant means outbound delivery target if the current binding supports it

### Binding management UI

Add a binding management surface in dashboard settings or conversation details.

Minimum binding fields:

- transport kind
- transport account
- endpoint type
- endpoint id
- default inbound actor
- default outbound mode
- enabled

### Conversation member display

Conversation detail UI should show participant kind.

Kinds:

- actor
- user
- external

This is important so operators can tell whether a participant is:

- an internal workspace user
- an external transport-only speaker
- an actor

## Message Flows

### Feishu group inbound

1. Feishu connector receives webhook or websocket event.
2. Normalize to inbound envelope.
3. Resolve transport endpoint by `chat_id`.
4. Resolve or create bound conversation.
5. Resolve sender by Feishu `open_id`.
6. Resolve or create conversation participant.
7. Create shared visible conversation item.
8. If the binding says the inbound message should wake an actor, target the default inbound actor.
9. Enqueue actor wakeup.

### Web composer mentioning a Feishu speaker

1. User selects an external participant in the composer.
2. Frontend submits `targetParticipantIds`.
3. Backend stores a normal conversation item.
4. Delivery service resolves the participant's Feishu address.
5. Feishu connector renders the `<at>` payload.
6. Message is posted into the bound Feishu endpoint.

### Actor sendTo external participant

1. Actor emits `sendTo(participantId)`.
2. Runtime creates a normal conversation item targeted to that participant.
3. Delivery service resolves address using current binding.
4. Connector sends it through Feishu or WeChat.

## Migration Strategy

This project explicitly does not preserve old database compatibility for this feature.

Implementation strategy:

1. replace schema in one pass
2. rebuild local database
3. update backend types and controllers to new shapes
4. update frontend store and pages to new API shapes

Do not add:

- migration shims for old transportless target format
- compatibility routes for deprecated chat payloads
- duplicate tables to support old and new models in parallel

## Implementation Order

1. Land this design doc.
2. Update database schema and shared types.
3. Replace message target API with participant targets.
4. Add IM backend modules and connector interfaces.
5. Add binding CRUD and participant/address resolution.
6. Add outbound projector and inbound ingest pipeline.
7. Wire Feishu connector.
8. Wire WeChat connector.
9. Update frontend chat mention flow and binding management UI.
10. Rebuild database and validate end-to-end.

## Decisions Locked by This Document

1. External IM participants are modeled as conversation participants plus transport addresses.
2. Transport endpoint binding is 1:1 with conversation.
3. Address resolution is transport-scoped and binding-scoped.
4. Participant-based targeting replaces actor/user split targeting.
5. Actor wake-up remains a conversation concern, not a transport concern.
6. Transport send is downstream of conversation item creation.

## Implemented Schema Snapshot

This section describes the schema as it is actually implemented now.

### Tables

`transport_accounts`

- One configured IM bot/account inside a workspace.
- Examples: one Feishu app bot, one WeChat bot login.
- Owns credentials, connection mode, runtime status, and connector config.

`transport_endpoints`

- One concrete external session endpoint under one account.
- Examples: one Feishu group `chat_id`, one Feishu direct `chat_id`, one WeChat peer id.
- This is the external session object that binds to a conversation.

`conversation_transport_bindings`

- The 1:1 binding between one internal `conversation` and one external `transport_endpoint`.
- Important fields:
  - `outbound_enabled`: whether outbound projection is allowed
  - `default_target_member_id`: the default inbound actor member for this bound conversation
- Enforced by unique constraints on both `conversation_id` and `transport_endpoint_id`.
- Auto-created IM conversations do not automatically insert the technical creator user into `conversation_members`.
  Visibility and membership are intentionally different concepts here.

`transport_addresses`

- One transport-scoped identity under one account.
- Examples: one Feishu user `open_id`, one WeChat user id.
- `user_id` is the workspace-level ownership link.
- This is where link / unlink / relink is stored.

`conversation_participant_addresses`

- Join table between `conversation_members` and `transport_addresses`.
- Means: "this participant in this conversation is currently associated with this address".
- `is_primary` marks the main address for that participant inside the conversation.

`transport_message_links`

- Join table between one internal `conversation_item` and one external transport delivery / inbound message record.
- Tracks direction, external message id, delivery status, endpoint, and transport metadata.

### How Messages Are Related

We do not create a separate IM message table. IM is attached to the existing conversation transcript.

Internal message ownership and targeting still live in:

- `conversation_items.author_member_id`
- `conversation_item_targets.target_member_id`

That means:

- author is always a conversation participant
- target is always a conversation participant
- transport address is resolved later from that participant

`transport_message_links` is the projection / correlation layer, not the source-of-truth message table.

### Inbound Message Flow

For an inbound Feishu or WeChat message:

1. resolve the `transport_account`
2. resolve or create the `transport_endpoint`
3. resolve or create the sender `transport_address`
4. inspect `transport_addresses.user_id`
5. if linked:
   - attach the address to the conversation's `user` member
   - future inbound from this address authors as that `user`
   - this is also the point where the linked user effectively becomes a participant in that conversation
6. if unlinked:
   - attach the address to an `external` member
7. create `conversation_items`
8. create `transport_message_links(direction = inbound)`

The message itself stores transport context in `conversation_items.metadata.transport`, while the durable inbound correlation lives in `transport_message_links`.

### Outbound Message Flow

For an outbound message:

1. create a normal internal `conversation_item`
2. store participant targets in `conversation_item_targets`
3. if the conversation has a binding and `outbound_enabled = true`
4. resolve whether any explicit target participant is reachable in the current bound session
5. if yes, create `transport_message_links(direction = outbound, delivery_status = pending)`
6. async worker sends the message and updates the link row

### How User Linking Works

User linking is not conversation-local. It is stored on:

- `transport_addresses.user_id`

Meaning:

- the same external address under the same bot maps to one workspace user
- changing that mapping affects future resolution across all sessions for that address
- linking an address does not by itself make that user a participant in every bound conversation

When link/unlink/relink happens, the system also synchronizes the current conversation-side attachment:

- linked: the address is moved to the relevant `user` member
- unlinked: the address is moved back to an `external` member
- previous orphaned external members are archived as `left`, not deleted, so historical messages stay intact

### Delivery Status Persistence

Outbound and inbound status are saved in `transport_message_links.delivery_status`.

Current values:

- `pending`: queued but not finalized
- `sent`: delivered successfully
- `failed`: send attempted and failed
- `skipped`: logically not deliverable, for example no reachable target

Additional delivery metadata is stored in:

- `transport_message_links.external_message_id`
- `transport_message_links.delivered_at`
- `transport_message_links.metadata`

Examples inside `metadata`:

- `skippedReason`
- `lastError`
- endpoint / binding correlation details

### Important Historical Behavior

Changing address ownership does not rewrite historical messages.

- old `conversation_items.author_member_id` values stay unchanged
- old `conversation_item_targets` stay unchanged
- old `transport_message_links` stay unchanged

So link / unlink / relink changes future author and delivery resolution, not past transcript history.
