# SpiceDB Authorization Redesign

## 1. Conclusion

The current system mixes four different concepts together:

- container ownership (`workspace`, `conversation`)
- membership (`workspace_members`, `conversation_members`)
- resource placement (`binding_scope`, `route_scope`, `owner_scope`)
- runtime authorization (`*_grants`, `trust_level`, ad-hoc SQL filters)

That is why the permission model feels chaotic: it is not one model. It is several partially overlapping models implemented in different modules.

This redesign replaces that with one rule:

- PostgreSQL stores business state.
- SpiceDB stores authorization state.
- Every access decision goes through SpiceDB.
- SQL is no longer allowed to decide who can access a resource.

This is a breaking redesign. It intentionally does not preserve current tables, current grant tables, or current scope semantics.

## 2. Findings In The Current Codebase

### 2.1 Authorization is scattered

Current authorization logic is spread across:

- `workspace_members.trust_level`
- `conversation_members`
- `capability_grants`
- `memory_grants`
- `model_route_grants`
- `model_binding_grants`
- controller-specific `if trustLevel !== 'owner' && trustLevel !== 'admin'`
- service-specific scope matching like `actorId + conversationId + userId + userCount`

There is no single authorization entry point.

### 2.2 The same concept is implemented multiple times

The system already contains three parallel grant systems:

- capability auth: `capability_bindings` + `capability_grants`
- memory auth: `memory_entries` + `memory_grants`
- model auth: `model_routes` / `model_bindings` + `*_grants`

All three repeat the same scope vocabulary:

- `platform`
- `workspace`
- `conversation`
- `actor_global`
- `actor_in_conversation`
- `user`

But each module re-implements matching logic itself.

### 2.3 Scope is being used as both placement and authorization

Examples:

- `capability_bindings.binding_scope`
- `model_bindings.binding_scope`
- `memory_entries.owner_scope`

Those fields currently mean several things at once:

- where the resource "belongs"
- where it should be discovered
- who can see it
- who can use it

Those must be separated.

### 2.4 The current model is ambient-context driven

Several modules decide access from request context like:

- current `workspaceId`
- optional `conversationId`
- optional `actorId`
- optional `userId`
- `userCount === 1`

This is fragile. A subject should be explicit:

- either `user:<id>`
- or `actor:<id>`

Authorization should not depend on heuristics like "single-user conversation".

### 2.5 Fine-grained permissions do not exist as first-class concepts

Today the system mainly models "is authorized to use".

What is missing:

- conversation admin
- conversation moderator
- manage members
- manage plugin config
- grant/revoke access
- edit/delete resource
- invoke relay
- recall memory vs edit memory
- use model profile vs manage model profile

### 2.6 Some routes are only authenticated, not authorized

Several controllers use `authMiddleware` without a consistent resource permission check. That means some endpoints rely on path-level filtering or business logic instead of an authorization model.

This is a major reason the system is hard to reason about.

## 3. Design Goals

### 3.1 Required goals

- one authorization engine for all resources
- one permission vocabulary per resource type
- explicit principal checks
- support grants to multiple subject types at the same time
- support grants to multiple concrete subjects at the same time
- support inheritance from platform, workspace, and conversation
- support future conversation-level admin/moderator permissions
- remove SQL-based grant matching logic from business services

### 3.2 Non-goals

- compatibility with current tables
- preserving current scope enums
- preserving current `grant` tables
- keeping current model route / model binding split if a cleaner design exists

## 4. New Authorization Model

## 4.1 Core vocabulary

- `principal`: an acting subject, currently `user` or `actor`
- `container`: an object that groups other resources, mainly `platform`, `workspace`, `conversation`
- `resource`: something protected by permissions, such as a plugin instance or memory
- `attachment`: business-level placement or default discovery, not authorization
- `grant`: a SpiceDB relationship, not a SQL row in a grant table

## 4.2 High-level rule

Each protected object exposes permissions directly in SpiceDB.

Examples:

- `workspace.manage_members`
- `conversation.manage_members`
- `plugin_instance.use`
- `plugin_instance.edit`
- `memory.read`
- `memory.recall`
- `mcp_relay.invoke`
- `model_profile.use`

No module is allowed to implement its own scope matching logic anymore.

## 4.3 Principals

Only two runtime principals exist:

- `user`
- `actor`

Everything else is a resource or a container.

That means:

- a user request is checked as `user:<id>`
- an actor turn is checked as `actor:<id>`
- if a code path wants "user or actor", it performs two explicit checks, not one implicit ambient check

This removes the current `userCount`-style hacks.

## 4.4 Containers and inheritance

Three containers define inherited access:

- `platform`
- `workspace`
- `conversation`

Inheritance works like this:

- `platform` can expose rights to all workspace principals
- `workspace` can expose rights to its human members and actors
- `conversation` can expose rights to its participants

Resource grants then compose from those containers.

Example:

- a plugin instance can grant `use` to:
  - one user
  - one actor
  - one conversation
  - one workspace
  - the platform singleton

All of those grants can exist at the same time.

## 5. Domain Redesign

## 5.1 Workspace

`workspace` becomes the root tenant boundary.

Recommended permissions:

- `view`
- `manage`
- `manage_members`
- `manage_actors`
- `manage_conversations`
- `create_conversation`
- `manage_capabilities`
- `manage_memories`
- `manage_relays`
- `manage_models`

Recommended relations:

- `owner`
- `admin`
- `member`
- `guest`
- `actor`

Important:

- `trust_level` stops being an authorization mechanism
- roles may still be stored in SQL for UX, but authorization must use SpiceDB only

## 5.2 Conversation

`conversation` is a protected resource under a workspace, not just a chat log.

Recommended relations:

- `participant`
- `moderator`
- `admin`
- `blocked`

Recommended permissions:

- `view`
- `send`
- `moderate`
- `manage`
- `manage_members`
- `attach_resources`

Rules:

- workspace admins inherit conversation management
- conversation admins do not automatically become workspace admins
- participants can read/send
- moderators can handle operational moderation
- admins can manage membership and attached resources

This directly solves "workspace member has group admin permission or not".

If the product later needs fully customizable roles instead of fixed `participant / moderator / admin`, introduce `conversation_role` and `conversation_role_grant` objects on top of this model, rather than overloading the base conversation relations.

## 5.3 Actor

`actor` is both:

- a principal that can act
- a protected resource that can be managed

Recommended permissions:

- `view`
- `invoke`
- `edit`
- `delete`

This lets the system distinguish:

- "can talk to this actor"
- "can edit this actor's profile"

## 5.4 Skill and Plugin

Do not continue using current `binding_scope` as the primary model.

Split the concept into:

- definition/package: marketplace or uploaded artifact
- instance: configured runtime object inside a workspace
- attachment: optional placement to actor/conversation/workspace for discovery
- authorization: SpiceDB relations only

Recommended protected resources:

- `skill_instance`
- `plugin_instance`

Recommended permissions:

- `view`
- `use`
- `edit`
- `grant`
- `delete`

Grants can target:

- direct principal: user or actor
- conversation
- workspace
- platform

This replaces both `binding_scope` and `capability_grants`.

## 5.5 Memory

`memory` should stop encoding authorization as `owner_scope + memory_grants` matching logic.

The clean model is:

- `memory_space` controls visibility
- `memory_item` stores content only
- moving an item to another path changes who can read it
- no per-memory exception grant exists

Recommended permissions:

- `memory_space.read`
- `memory_space.write`
- `memory_space.manage`
- `memory_item.delete`

Recommended spaces:

- `workspace_shared`
- `conversation_shared`
- `actor_private`
- `participant_private`
- `user_private`

Important distinction:

- path placement is the user-facing visibility model
- SpiceDB relations are the only authorization model

No SQL grant table or per-memory grant row should survive this redesign.

## 5.6 MCP Relay

`mcp_relay` becomes a first-class protected resource.

Recommended permissions:

- `view`
- `invoke`
- `edit`
- `grant`
- `rotate_token`
- `delete`

Grant targets:

- direct principal
- conversation
- workspace

If relay servers later need separate rights, they can inherit from `mcp_relay`.

## 5.7 Model Config

Because compatibility is not required, the cleanest redesign is to replace current `model_routes + model_bindings + grants` with:

- `model_profile`: provider config + runtime policy
- `model_assignment`: attach a profile to workspace / actor / conversation / user with priority

Authorization applies to `model_profile`, not to route rows.

Recommended permissions:

- `view`
- `use`
- `edit`
- `attach`
- `grant`
- `delete`

This removes the current route/binding duplication and makes model authorization look exactly like plugin/skill authorization.

## 5.8 Custom roles are a phase-two feature

Do not start the rewrite with custom-role objects everywhere.

For this system, phase one should use fixed permissions and fixed relations:

- workspace: `owner / admin / member / guest`
- conversation: `participant / moderator / admin`
- resources: `owner / editor / use_*`

Only introduce `*_role` + `*_role_grant` objects when a real product requirement appears for user-defined permission bundles.

That keeps the first SpiceDB rollout understandable and lowers migration risk.

## 6. SpiceDB Object Mapping

Suggested SpiceDB objects:

- `platform:synapse`
- `workspace:<workspace_id>`
- `conversation:<conversation_id>`
- `user:<user_id>`
- `actor:<actor_id>`
- `skill_instance:<instance_id>`
- `plugin_instance:<instance_id>`
- `memory:<memory_id>`
- `mcp_relay:<relay_id>`
- `model_profile:<profile_id>`

Recommended runtime check examples:

- can user manage workspace members?
  - `CheckPermission(workspace:<id>, manage_members, user:<id>)`
- can user manage this conversation?
  - `CheckPermission(conversation:<id>, manage_members, user:<id>)`
- can actor invoke this plugin instance?
  - `CheckPermission(plugin_instance:<id>, use, actor:<id>)`
- can user recall this memory?
  - `CheckPermission(memory:<id>, recall, user:<id>)`
- can actor use this model profile?
  - `CheckPermission(model_profile:<id>, use, actor:<id>)`

## 7. Read Path Redesign

Use one of three patterns only.

### 7.1 Point checks

For create/update/delete or one resource access:

- `CheckPermission`

Examples:

- remove actor from conversation
- rotate relay token
- edit model profile

### 7.2 List pages

For pages like "my conversations" or "visible plugin instances":

- `LookupResources`
- then load rows from PostgreSQL by returned IDs

Examples:

- conversations visible to user
- plugin instances usable by actor
- model profiles visible in current workspace

### 7.3 Search and vector recall

For resources that must be searched in PostgreSQL first, such as memory:

1. search PostgreSQL index for candidate IDs
2. `CheckBulkPermissions` on candidate IDs
3. drop unauthorized candidates

Do not rebuild the current SQL scope-matching logic.

If memory volume later demands it, add an authz projection table for prefiltering, but keep SpiceDB as the source of truth.

## 8. Write Path Redesign

## 8.1 Outbox pattern

The application still needs PostgreSQL and SpiceDB to change together.

Recommended flow:

1. write domain data in PostgreSQL
2. write auth tuple operations into `authz_outbox` in the same SQL transaction
3. async worker applies tuple updates to SpiceDB using idempotent `TOUCH` / `DELETE`
4. store returned `zed_token` checkpoint per workspace or resource family

This is safer than embedding authorization logic in SQL and cleaner than trying to keep grant tables as a second auth system.

## 8.2 Immediate consistency for interactive mutations

For operations that must be immediately visible after returning:

- the request handler may flush its own outbox items before sending the response
- subsequent checks should use `at_least_as_fresh` with the latest stored `zed_token`

## 8.3 Audit

Authorization audit should not rely on grant tables anymore.

Recommended source:

- SpiceDB `Watch` stream -> persisted into `authz_audit_log`

That gives a single audit source for:

- who granted access
- who revoked access
- when inheritance changed

## 9. What Stays In PostgreSQL

PostgreSQL still stores:

- entity metadata
- chat messages
- vector indexes
- plugin/skill/model configs
- workspace membership metadata
- conversation membership metadata
- attachments
- audit projections
- auth outbox

What should be removed from PostgreSQL as authorization sources:

- capability grant tables
- memory grant tables
- model grant tables
- SQL scope matching functions
- route/controller permission branches based on `trust_level`

## 10. Required Service Layer Changes

Create a dedicated `authz` module with a very small public surface:

- `check(subject, resource, permission)`
- `checkMany(subject, checks[])`
- `lookupResources(subject, resourceType, permission, scope?)`
- `writeTuples(operations[])`
- `readRelationships(resource, relation?)`

All business modules call this module only.

Examples:

- `groupController` stops checking only auth token and starts checking `conversation` permissions
- `sessionController` requires `actor.invoke`
- `workspace` management routes require explicit workspace permissions
- capability install/update routes require `workspace.manage_capabilities` or resource `edit`
- memory write routes require `memory.edit` or `workspace.manage_memories`

## 11. Suggested New Data Model Boundaries

### 11.1 Keep membership as business data

You still need SQL membership rows for:

- join/leave timestamps
- invite metadata
- unread counters
- chat rendering

But those rows are not trusted for authorization checks.

### 11.2 Separate attachment from access

Do not encode both in one field anymore.

Examples:

- a plugin instance can be attached to one actor for discovery
- the same plugin instance can be granted to one conversation and one workspace

Attachment answers "where does it show up by default?"

Authorization answers "who may use it?"

These must remain separate.

### 11.3 Prefer one reusable ACL template per resource class

All grantable runtime resources should follow the same shape:

- owner
- editor/operator
- direct principal grants
- conversation grants
- workspace grants
- optional platform grants

This gives a predictable mental model across skills, plugins, relays, memories, and model profiles.

## 12. Rollout Recommendation

Because old compatibility is not required, the cleanest rollout is:

1. create a new `authz` module and SpiceDB schema in parallel
2. create new runtime resource tables (`*_instance`, `model_profile`, `model_assignment`)
3. migrate API handlers to explicit permission checks
4. delete old SQL grant systems completely
5. remove `workspaceMiddleware` as an authorization mechanism and replace it with permission middleware

## 13. Final Recommendation

Do not try to "adapt" the existing grant tables to SpiceDB.

That would preserve the exact confusion you want to eliminate.

The correct redesign is:

- use SpiceDB for all authorization decisions
- keep PostgreSQL for business data only
- split attachment from access
- make `user` and `actor` the only runtime principals
- make `workspace`, `conversation`, and `platform` the only inheritance containers
- unify all resource ACLs around a shared permission pattern
- replace current model-route/model-binding auth with a simpler `model_profile + assignment` design

The accompanying draft schema is in:

- `docs/spicedb-schema.zed`
