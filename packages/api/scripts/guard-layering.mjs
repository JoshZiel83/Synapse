#!/usr/bin/env node
// guard-layering: enforce the DB / DTO / wire layering rules inside
// packages/api/src/modules/** (docs/architecture-boundary-refactor-master-plan.md
// §9). Text-based, allowlist-ratcheted: the baseline file records the set of
// files that still violate each rule during the in-flight migration, and the
// guard fails if a NEW violation appears outside the baseline. As modules are
// converted to repo/service/presenter, entries are removed from the baseline —
// it can only shrink (a violation removed from a file but still listed is also
// reported, so the baseline never goes stale silently).
//
// Rules:
//   r1_generated_db_outside_repo : only repo*.ts / repo.types.ts may import
//       generated/db or db-types.
//   r2_tablerow_outside_repo     : only repo*.ts / repo.types.ts may use
//       TableRow< / TableInsert< / TableUpdate< (the kysely alias). service /
//       controller / helper files must take repo.types records instead.
//   r3_serializeinstant_in_layer : time-serialization (serializeInstant /
//       serializeOptionalInstant) is allowed ONLY in presenter*.ts (Date→ISO is
//       the presenter's job) — NOT in controllers, services, connectors, infra
//       helpers, runtime files, etc. repo*.ts is excluded here because the repo
//       still emits ISO strings; converting repo to emit Date is tracked under
//       P1-7. Broadened in round-6 P1-9 from the old service*/controller* match,
//       which missed controller/dingtalk.ts, parse-service.ts, runtime.ts, …
//   r4_maprow_outside_repo       : map*Row / normalize*Row defs only in repo*.ts.
//   r5_bare_route_in_mixed       : mixed (Tier C) modules must register routes
//       via appRoute()/wireRoute() (or split *.app.ts/*.wire.ts), never bare
//       app.get/post/put/delete/patch(...). §5.3 mechanism.
//   r7_dual_naming               : no `row.foo_bar || row.fooBar` and no
//       outward `...row` spread.
//   r8_db_client_outside_repo    : only repo*.ts may import the DB client
//       (`db` / withDbTransaction from infrastructure/database/kysely) or the
//       `sql` builder from "kysely". Non-repo module files must go through the
//       repo. Baseline-ratcheted while modules migrate (P1-6).
//   r9_sql_construction_in_clean_service : selected services whose SQL
//       construction was fully moved to repo.ts must not reintroduce Kysely
//       builders, raw SQL helpers, or handwritten SQL.
//   r10_clean_service_view_boundary_residuals : selected services whose known
//       response/view boundary residuals were removed must not reintroduce those
//       exact shared view aliases or misleading response-payload names.
//   r11_runtime_auth_policy_json_repo_exit : runtime-authorizations grant
//       policy JSON hydration belongs in repo.ts, not service.ts.
//   r12_tasks_payload_json_repo_exit : task prompt/resolution payload JSON
//       hydration belongs in tasks/repo.ts, not tasks/service.ts.
//   r13_skills_json_repo_exit : selected skills DB JSONB fields are decoded in
//       skills/repo.ts, not skills/service.ts.
//   r14_automation_json_repo_exit : selected automation event-source metadata
//       and trigger matcher JSON are decoded in automation/repo.ts, not
//       automation/service.ts.
//   r15_im_account_json_repo_exit : IM transport account JSONB fields are
//       decoded in im/service/repo.ts, not im/service/accounts.ts.
//   r16_im_delivery_link_json_repo_exit : selected IM delivery-link metadata
//       fields are decoded in im/service/repo.ts, not im/service/delivery-links.ts.
//   r17_im_weixin_binding_json_repo_exit : selected IM Weixin account metadata
//       is consumed after normalizeAccountRow(), not parsed in weixin-binding.ts.
//   r18_im_binding_json_repo_exit : IM conversation binding metadata is consumed
//       after normalizeBindingRow(), not parsed in im/service/bindings.ts.
//   r19_model_groups_app_route_marker : model-groups is a plain app surface
//       module that has been migrated to appRoute() markers; keep it from
//       reintroducing bare app.<verb>(...) registrations.
//   r20_audit_app_route_marker : audit is a plain app surface module that has
//       been migrated to appRoute(); keep it from reintroducing bare
//       app.<verb>(...) registrations.
//   r21_auth_custom_app_route_marker : custom auth app endpoints have been
//       migrated to appRoute(); Better Auth's native app.all wildcard remains
//       an explicit passthrough exception.
//   r22_no_bare_app_route_outside_allowed : no module may register bare
//       app.get/post/put/delete/patch routes after the route-marker cleanup,
//       except explicit installer file endpoints.
//   r23_chat_selected_json_repo_exit : selected chat row metadata/draft JSONB
//       fields are decoded in chat/repo.ts, not chat/service.ts.
//   r24_workspace_app_input_schema_shared_contract : selected workspace app
//       request body schemas are shared contracts, not controller-local schemas.
//   r25_files_upload_origin_schema_shared_contract : the files upload origin
//       multipart field is a shared app contract, not a controller-local schema.
//   r26_organization_actor_package_install_input_shared_contract : the actor
//       package install app request body is a shared contract, not a
//       controller-local schema.
//   r27_automation_app_input_schema_shared_contract : automation app request
//       bodies and queries are shared contracts, not controller-local schemas.
//   r28_model_groups_app_input_schema_shared_contract : model-groups app
//       request bodies are shared contracts, not controller-local schemas.
//   r29_im_generic_app_input_schema_shared_contract : generic IM app request
//       bodies and queries are shared contracts, not controller-local schemas.
//   r30_im_transport_app_input_schema_shared_contract : selected IM
//       per-transport app request bodies are shared contracts, not
//       controller-local schemas.
//   r31_im_dingtalk_app_input_schema_shared_contract : DingTalk IM app request
//       bodies are shared contracts, not controller-local schemas.
//   r32_workspace_apps_app_query_schema_shared_contract : workspace-apps app
//       query DTOs are shared contracts, not controller-local schemas.
//   r33_skills_marketplace_query_schema_shared_contract : skills marketplace
//       app query DTOs are shared contracts, not controller-local casts.
//   r34_organization_actor_package_query_schema_shared_contract : actor-package
//       app query DTOs are shared contracts, not controller-local casts.
//   r35_mcp_plugins_app_query_schema_shared_contract : mcp plugin app query
//       DTOs are shared contracts, not controller-local casts/schemas.
//   r36_devices_access_bindings_query_schema_shared_contract : active-device
//       access-binding app query DTO is shared, not controller-local zod.
//   r37_runtime_auth_manual_policy_schema_shared_contract : manual runtime
//       authorization grant policy DTO is validated by shared app schema, not
//       re-parsed in the API controller.
//   r38_devices_start_pairing_schema_shared_contract : start-pairing app
//       request body fields are shared contracts, not controller-local zod.
//   r39_mcp_plugin_installation_config_json_repo_exit : plugin installation
//       configData JSON is decoded by mcp-plugins/repo.ts before service,
//       presenter, auth, or config-resolver consumers see it.
//   r40_mcp_plugin_auth_spec_json_repo_exit : plugin auth spec defaultConfig
//       and authBindings JSON are decoded by mcp-plugins/repo.ts before auth
//       service consumers see them.
//   r41_mcp_visible_tool_manifest_json_repo_exit : visible plugin
//       toolManifest JSON is decoded by mcp-plugins/repo.ts before the tool
//       resolver consumes it.
//   r42_audit_app_schema_shared_contract : audit list app query/response DTOs
//       are shared contracts, not controller-local schemas/casts.
//   r43_platform_app_schema_shared_contract : platform navigation/access app
//       body/response DTOs are shared contracts, not controller-local schemas.
//   r44_memory_app_schema_shared_contract : memory app body/query/response DTOs
//       are shared contracts, not controller-local schemas/casts.
//   r45_skills_installed_query_schema_shared_contract : installed-skill list
//       app query DTO is a shared contract, not a controller-local schema/cast.
//   r46_auth_custom_app_schema_shared_contract : custom auth app endpoints use
//       shared request/response schemas, not self-sent z.unknown() markers.
//   r47_model_groups_app_schema_shared_contract : model-groups app endpoints
//       use shared request/response schemas, not self-sent z.unknown() markers.
//   r48_automation_app_response_schema_shared_contract : automation app
//       response DTOs return through appRoute(), not controller self-sent
//       sendData() wrappers.
//   r49_files_app_response_schema_shared_contract : files app response DTOs
//       return through appRoute(), not controller self-sent sendData() wrappers.
//   r50_runtime_auth_manual_response_schema_shared_contract : manual runtime
//       authorization app response DTO returns through appRoute(), not a
//       controller self-sent sendData() wrapper.
//   r51_im_app_response_schema_shared_contract : IM app response DTOs return
//       through appRoute(), not controller self-sent sendData() wrappers.
//   r52_workspace_apps_input_schema_depth : workspace-apps app input schemas
//       validate actor docs and custom skill content structurally, not with
//       z.any() placeholders.
//   r53_model_groups_json_repo_exit : selected model-groups business JSON
//       fields are decoded by repo.ts before resolver/service consume them.
//   r54_mcp_connection_public_payload_json_repo_exit : selected mcp-plugins
//       connection publicPayload JSON is decoded by repo.ts before service
//       scope validation consumes it.
//   r55_chat_transport_schema_depth : chat conversation item transport fields
//       are structured app DTOs, not z.unknown() placeholders.
//   r56_organization_actor_package_version_schema_depth : actor-package
//       latestRevision app fields are structured shared DTOs, not z.unknown()
//       placeholders.
//   r57_organization_actor_version_schema_depth : actor version delta/source are
//       structured shared DTOs, not z.unknown() placeholders.
//   r58_remote_agents_runtime_status_schema_depth : remote-agent runtime,
//       runtime-catalog, machine trust, and machine lifecycle app fields are
//       shared enum DTOs, not open strings.
//   r59_relationship_request_status_schema_depth : relationship request view
//       statuses are shared relationship-request enum DTOs, not open strings.
//   r60_remote_agent_binding_status_schema_depth : remote-agent binding app
//       statuses are shared remote-agent binding enum DTOs, not open strings.
//   r61_automation_response_status_schema_depth : selected automation app
//       response statuses are shared enum DTOs, not open strings.
//   r62_chat_event_policy_schema_depth : chat event timeline/context policies
//       are shared enum DTOs, not z.unknown() placeholders or local unions.
//   r63_chat_participant_session_status_schema_depth : chat participant
//       sessionStatus is a finite session/runtime enum DTO, not an open string.
//   r64_chat_item_subtype_schema_depth : chat feed item/reply subtypes are
//       shared enum DTOs, not open strings or local unions.
//   r65_automation_rule_category_schema_depth : automation rule category app
//       schemas use the shared enum tuple, not open strings or local duplicate
//       tuples.
//   r66_automation_integration_enum_schema_depth : automation event-source
//       integration provider/ingress/target app fields use shared enum tuples,
//       not open strings.
//   r67_automation_creator_kind_schema_depth : automation event-source creator
//       kind app field and exported TS type use the shared enum tuple, not open
//       strings or local unions.
//   r68_model_groups_provider_kind_schema_depth : model-group item/version
//       providerKind app fields use the shared provider tuple, not open strings.
//   r69_workspace_trust_level_schema_depth : workspace trustLevel app fields
//       and exported TrustLevel type use the shared trust-level tuple.
//   r70_relationship_member_trust_level_schema_depth : relationship member
//       summary trustLevel uses the shared trust-level tuple, not open strings.
//   r71_organization_actor_package_transport_schema_depth : actor-package
//       latestRevision transport uses plugin spec transports, not open strings
//       or the broader application transport union.
//   r72_relationship_conversation_transport_schema_depth : relationship
//       conversation summary transportKind uses shared transport kinds.
//   r73_actor_summary_role_schema_depth : workspace/relationship actor summary
//       role fields use the shared actor role tuple, not open strings.
//   r74_skills_enum_schema_depth : skills source/sync/effort app fields use
//       shared enum tuples, not inline schemas or duplicated client unions.
//   r75_automation_rule_enum_type_depth : automation trigger/source/schedule,
//       completion, target-policy, rule-status, and event-source status types
//       derive from shared enum tuples instead of hand-written string unions.
//   r76_conversation_status_schema_depth : chat/relationship conversation app
//       status uses the shared conversation status tuple, not inline
//       active/completed unions across schemas, presenters, or web store state.
//   r77_mcp_plugin_auth_flow_enum_depth : mcp plugin install action,
//       auth challenge kind, and auth challenge open mode use shared enum
//       tuples across app schemas, API adapters, and web install UI.
//   r78_platform_access_source_schema_depth : platform access binding source
//       uses the shared config/manual tuple across app schema, API platform
//       records/writes, and web access UI.
//   r79_organization_actor_package_enum_schema_depth : organization
//       marketplace/package/version/link/history app enum fields use shared
//       enum tuples and API constants, not inline schemas or raw branches.
//   r80_mcp_plugin_config_auth_enum_schema_depth : mcp plugin config,
//       install-flow, auth-binding/session, installation-status, and
//       marketplace requirement app enum fields use shared enum tuples and API
//       constants, not inline schemas or raw branches.
//   r81_im_qr_device_flow_status_schema_depth : IM Weixin QR and DingTalk
//       device-flow app session statuses use shared enum tuples/constants, not
//       inline schemas, hand-written unions, or raw API/web branches.
//   r82_model_group_api_style_server_tools_schema_depth : model binding API
//       style and provider-side server tools use shared enum tuples/constants
//       across app schemas, API provider branches, and web settings forms.
//   r83_devices_pairing_access_target_schema_depth : device pairing ticket and
//       active-capability access target app fields use shared enum tuples and
//       constants, not inline schema tuples or raw literals.
//   r84_automation_access_target_type_schema_depth : automation access-grant
//       app target type uses a shared enum tuple/constant across schema, shared
//       type surface, and API mapper branches.
//   r85_asr_audio_config_schema_depth : realtime ASR app audio config uses a
//       shared runtime schema and shared format/codec tuples, not an API-local
//       inline enum schema or hand-written exported type unions.
//   r86_chat_transport_direction_schema_depth : chat transport direction app
//       fields use a shared tuple/constant across schemas, types, and API
//       service/repo boundaries, not inline inbound/outbound unions.
//   r87_chat_automation_notice_source_kind_schema_depth : chat automation
//       notice sourceKind uses the shared automation source-kind tuple, not a
//       duplicated inline enum tuple in chat schemas.
//   r88_chat_participant_removal_state_schema_depth : chat participant removal
//       response state uses a dedicated shared tuple, not the full participant
//       state tuple or a duplicated left/removed union.
//   r89_actor_runtime_health_schema_depth : actor runtime health uses a shared
//       tuple/constant across app schema, exported type, API producers, and
//       web/mobile/shared consumers, not duplicated ok/error strings.
//   r90_chat_membership_update_reason_schema_depth : chat membership update
//       event reason/selfState uses shared tuples/constants across app schema,
//       exported type, and API producer, not duplicated literals.
//   r91_chat_event_payload_json_repo_exit : chat feed/sync event payload JSONB
//       is decoded at repo exit, not re-parsed in service.ts.
//   r92_client_workspace_auth_contract_shared : mobile/web auth/workspace app
//       response types derive from shared AuthMeView and WorkspaceListItemView,
//       not local field-interface duplicates.
//   r93_workspace_actor_config_json_repo_exit : workspace create secretary
//       actor config JSONB is decoded in repo.ts; presenter consumes the object.
//   r94_tool_call_task_json_repo_exit : tool-call-task payload/metadata JSONB
//       is decoded in repo.ts; presenter consumes decoded records.
//   r95_runtime_auth_source_request_args_json_repo_exit : runtime-authorization
//       sourceRequestArgs JSONB is decoded in repo.ts; presenter consumes it.
//   r96_skills_json_records_repo_exit : selected skills snapshot/mirror/item/
//       version JSONB fields are normalized in repo.ts before service or
//       presenter consumers read them.
//   r97_memory_metadata_json_repo_exit : memory item metadata JSONB is decoded
//       in memory/repo.ts before presenter/service consumers read it.
//   r98_organization_json_records_repo_exit : organization actor/version/package
//       JSONB fields are decoded in repo.ts before presenter consumers read them.
//   r99_tasks_summary_json_repo_exit : task summary RawTaskRow JSONB fields
//       are decoded in repo.ts before presenter consumers read them.
//   r100_context_archive_point_json_repo_exit : context archive point metadata
//       JSONB is decoded in repo.ts before presenter consumers read it.
//   r101_model_groups_presenter_json_repo_exit : model-groups app presenter
//       JSON fields are decoded in repo.ts before presenter consumers read them.
//   r102_automation_presenter_json_repo_exit : automation app presenter JSON
//       fields are decoded in repo.ts before presenter consumers read them.
//   r103_session_presenter_json_repo_exit : session app presenter JSON fields
//       are decoded in repo.ts before presenter consumers read them.
//   r104_files_presenter_json_repo_exit : files app presenter JSON fields are
//       decoded in repo.ts / repo-parse.ts before presenter consumers read them.
//   r105_mcp_plugins_presenter_json_repo_exit : mcp-plugins presenter JSON
//       fields are decoded in repo.ts before presenter consumers read them.
//   r106_mcp_plugins_service_no_json_string_parse : mcp-plugins service
//       consumes decoded config/scope objects and does not parse JSON strings.
//   r107_tasks_service_no_json_string_parse : tasks service consumes decoded
//       task command/session-plan/runtime-auth JSON fields from repo helpers.
//   r108_audit_details_schema_depth : audit app response details is a decoded
//       JSON object, not an opaque z.unknown field.
//   r109_organization_service_no_json_string_parse : organization service
//       consumes decoded docs/metadata and delegates doc-array shaping to a
//       pure codec; it must not parse JSON strings.
//   r110_skills_service_no_json_string_parse : skills service consumes decoded
//       snapshot/file content block arrays and delegates block shaping to a
//       pure codec; it must not parse JSON strings.
//   r111_ai_prompt_builder_no_actor_doc_json_string_parse : AI prompt
//       presentation consumes decoded actor docs/specialties arrays and must
//       not parse JSON strings.
//   r112_ai_repo_inviteable_actor_docs_no_json_string_parse : AI repo
//       inviteable-actor docs projection consumes decoded JSONB arrays and must
//       not parse JSON strings.
//   r113_ai_execution_tool_result_metadata_repo_exit : AI execution tool result
//       metadata is decoded at repo exit before context-builder rehydrates
//       CanonicalToolResult.
//   r114_session_wakeup_metadata_repo_exit : session wakeup metadata is decoded
//       at repo exit before runtime presentation consumes it.
//   r115_session_runtime_tool_activity_json_repo_exit : selected runtime
//       tool-activity JSON fields are decoded at repo exit before runtime
//       presentation consumes them.
//   r116_tasks_runtime_auth_arrays_repo_exit : task runtime-authorization
//       grant option/preset arrays are decoded at repo exit before service
//       approval logic consumes them.
//   r117_im_service_no_json_helper_exports : IM service barrel/helpers do not
//       expose JSON parser helpers; DB JSONB decode stays in repo/worker
//       adapters.
//   r118_web_integration_installation_contract_shared : web integration
//       event-source helpers use shared PluginInstallationDetailView instead
//       of redeclaring a local installation response subset.
//   r119_mobile_friend_id_contract_shared : mobile friend-id settings use the
//       shared relationship-profile app contract instead of the removed
//       `/me/friend-id` local response shape.
//   r120_client_actor_list_contract_shared : web/mobile actor list clients use
//       the appRoute `{ data: Actor[] }` contract directly instead of a legacy
//       `{ actors }` compatibility wrapper.
//   r121_web_weixin_binding_candidates_contract_shared : web Weixin binding
//       candidates client uses the shared `{ members }` response contract
//       instead of re-wrapping it as historical `{ data: [...] }`.
//   r122_web_manual_runtime_grant_contract_shared : web manual runtime
//       authorization grant client returns the shared grant record view instead
//       of re-wrapping appRoute data as historical `{ grant }`.
//   r123_web_actor_model_groups_contract_shared : web actor model-group
//       assignment clients return shared array response values directly instead
//       of re-wrapping appRoute data as historical `{ groups }`.
//   r124_web_model_group_lists_contract_shared : web model-group list clients
//       return shared ModelGroupListView arrays directly instead of re-wrapping
//       appRoute data as historical `{ groups }`.
//   r125_web_model_group_details_contract_shared : web model-group detail
//       clients return shared ModelGroupDetailView values directly instead of
//       re-wrapping appRoute data as historical `{ group }`.
//   r126_web_model_group_item_versions_contract_shared : web model-group item
//       version clients return shared version arrays directly instead of
//       re-wrapping appRoute data as historical `{ versions }`.
//   r127_web_model_group_mutations_contract_shared : web model-group mutation,
//       grant, and item clients return shared app response values directly
//       instead of re-wrapping appRoute data as historical `{ group }`,
//       `{ grants }`, `{ grant }`, or `{ item }`.
//   r128_web_device_list_contract_shared : web device list client returns the
//       shared DeviceListView array directly instead of re-wrapping appRoute
//       data as historical `{ devices }`.
//   r129_web_platform_access_contract_shared : web platform navigation/access
//       clients return shared app response values directly instead of exposing
//       appRoute's `{ data }` envelope.
//   r130_web_workspace_invites_contract_shared : web workspace invite clients
//       return shared invite app values directly instead of exposing appRoute's
//       `{ data }` envelope.
//   r131_web_workspace_navigation_contract_shared : web workspace navigation
//       clients return the shared app value directly instead of exposing
//       appRoute's `{ data }` envelope.
//   r132_web_workspace_members_access_contract_shared : web workspace
//       members/access clients return shared app values directly instead of
//       exposing appRoute's `{ data }` envelope.
//   r133_client_workspace_list_contract_shared : web/mobile workspace list
//       clients return shared WorkspaceListItemView arrays directly instead of
//       exposing appRoute's `{ data }` envelope.
//   r134_web_plugin_installation_detail_contract_shared : web plugin
//       installation detail clients return shared PluginInstallationDetailView
//       directly instead of re-wrapping it as `{ installation }`.
//   r135_web_workspace_app_success_contract_shared : web workspace-app delete
//       clients return shared WorkspaceAppSuccessView values directly instead
//       of exposing the raw fetch envelope or a local `{ deleted }` shape.
//   r136_web_automation_success_contract_shared : web automation success
//       clients return shared AutomationSuccess values directly instead of
//       exposing raw fetch envelopes for delete/archive app routes.
//   r137_web_mcp_audit_contract_shared : web MCP audit facades return shared
//       PluginAuditLogList arrays directly instead of exposing appRoute's
//       `{ data }` envelope.
//   r138_web_workspace_app_grants_contract_shared : web workspace-app grant
//       facades return shared WorkspaceAppGrantListView values directly instead
//       of exposing appRoute's `{ data }` envelope or local grant arrays.
//   r139_web_skills_facade_contract_shared : web skills facades use shared
//       SkillMarketplace*View / InstalledSkill*View response contracts instead
//       of local `{ skill(s): ... }` wrapper aliases.
//   r140_web_memory_facade_contract_shared : web memory facades use shared
//       Memory*View response contracts directly instead of casts or implicit
//       any-shaped return values.
//   r141_web_remote_agents_facade_contract_shared : web remote-agent facades
//       use shared RemoteAgent*Response schema types instead of local
//       `{ remoteAgent(s) }`, `{ machines }`, or `{ grants }` aliases.
//   r142_web_im_facade_contract_shared : web IM facades use shared
//       Transport*/Weixin*/Dingtalk* response schema types instead of local
//       `{ account }`, `{ session }`, `{ binding }`, `{ externalUser }`, or
//       list wrapper aliases.
//   r143_mcp_plugin_response_containers_shared_contract : MCP marketplace,
//       publisher, category, and installation list/detail response containers
//       are shared contracts, not controller-local z.array()/extend containers
//       or web-local array/intersection return types.
//   r144_organization_response_containers_shared_contract : organization
//       actor/tree/package/version list response containers are shared
//       contracts, not controller-local z.array() containers or web-local
//       package/version/tree return shapes.
//   r145_workspace_response_containers_shared_contract : workspace list,
//       member, access, and invite list response containers are shared
//       contracts, not controller-local .array() containers or web/mobile
//       element-array facade return types.
//   r146_web_automation_list_facade_contract_shared : web automation list
//       facades use shared list schema types instead of element-array return
//       types.
//   r147_web_audit_facade_contract_shared : web audit facade unwraps the
//       appRoute envelope through a shared typed response instead of a cast or
//       raw envelope return.
//   r148_client_file_upload_facade_contract_shared : web/mobile file upload
//       facades parse the shared upload response schema instead of casting the
//       appRoute envelope to `{ data: FileRecordView }`.
//
// Usage: node scripts/guard-layering.mjs          (exit 1 on new violation)
//        node scripts/guard-layering.mjs --write  (regenerate baseline)

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const MODULES = resolve(here, "../src/modules")
const REPO_ROOT = resolve(here, "../../..")
const BASELINE = resolve(here, "guard-layering-baseline.json")
const WORKSPACE_APPS_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/workspace-apps.ts"
)
const WORKSPACE_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/workspace.ts"
)
const AUTOMATION_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/automation.ts"
)
const CHAT_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/chat.ts"
)
const IM_SHARED_SCHEMA = resolve(REPO_ROOT, "packages/shared/src/schemas/im.ts")
const SHARED_TYPES_INDEX = resolve(
  REPO_ROOT,
  "packages/shared/src/types/index.ts"
)
const SHARED_UTILS_INDEX = resolve(
  REPO_ROOT,
  "packages/shared/src/utils/index.ts"
)
const ORGANIZATION_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/organization.ts"
)
const REMOTE_AGENTS_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/remote-agents.ts"
)
const RELATIONSHIP_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/relationship.ts"
)
const MODEL_GROUPS_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/model-groups.ts"
)
const SKILLS_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/skills.ts"
)
const PLATFORM_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/platform.ts"
)
const AUDIT_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/audit.ts"
)
const MCP_PLUGINS_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/mcp-plugins.ts"
)
const DEVICES_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/devices.ts"
)
const WEB_SKILLS_CLIENT = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/skills/skills-client.tsx"
)
const WEB_CHAT_STORE = resolve(
  REPO_ROOT,
  "packages/web-next/stores/chat-store.ts"
)
const WEB_CHAT_RUNTIME_UI = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/chat/runtime-ui.ts"
)
const WEB_PLUGIN_INSTALL_DIALOG = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/plugins/install-dialog.tsx"
)
const WEB_PLUGIN_INSTALLATION_WORKBENCH = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/plugins/plugin-installation-workbench.tsx"
)
const WEB_PLUGIN_INSTALLATION_DETAIL_PAGE = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/plugins/installations/[installationId]/page.tsx"
)
const WEB_PLUGIN_INSTALL_PAGE = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/plugins/[pluginId]/install/page.tsx"
)
const WEB_ACCESS_MANAGEMENT = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/settings/access-management.tsx"
)
const WEB_IM_DASHBOARD = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/im/page.tsx"
)
const WEB_SIDEBAR_WEIXIN_BINDING = resolve(
  REPO_ROOT,
  "packages/web-next/components/sidebar-weixin-binding.tsx"
)
const WEB_APP_SIDEBAR = resolve(
  REPO_ROOT,
  "packages/web-next/components/app-sidebar.tsx"
)
const WEB_MODEL_GROUP_BROWSER = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/settings/model-group-browser.tsx"
)
const WEB_MODEL_ITEM_DIALOG = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/settings/model-item-dialog.tsx"
)
const WEB_MODEL_SETTINGS_WORKBENCH = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/settings/model-settings-workbench.tsx"
)
const WEB_REMOTE_AGENT_DETAIL = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/remote-agents/agents/[remoteAgentId]/page.tsx"
)
const WEB_API_CLIENT = resolve(REPO_ROOT, "packages/web-next/lib/api.ts")
const WEB_POST_LOGIN = resolve(REPO_ROOT, "packages/web-next/lib/post-login.ts")
const WEB_INVITE_MANAGEMENT = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/settings/invite-management.tsx"
)
const WEB_INTEGRATION_EVENT_SOURCES = resolve(
  REPO_ROOT,
  "packages/web-next/lib/integration-event-sources.ts"
)
const WEB_WORKSPACE_PROVIDER = resolve(
  REPO_ROOT,
  "packages/web-next/app/dashboard/workspace-provider.tsx"
)
const ASR_SHARED_SCHEMA = resolve(
  REPO_ROOT,
  "packages/shared/src/schemas/asr.ts"
)
const MOBILE_ACTOR_ACTIVITY_BUBBLE = resolve(
  REPO_ROOT,
  "packages/mobile-app/src/components/actor-activity-bubble.tsx"
)
const MOBILE_API_TYPES = resolve(
  REPO_ROOT,
  "packages/mobile-app/src/types/api.ts"
)
const MOBILE_API_CLIENT = resolve(
  REPO_ROOT,
  "packages/mobile-app/src/lib/api.ts"
)
const MOBILE_SESSION_PROVIDER = resolve(
  REPO_ROOT,
  "packages/mobile-app/src/providers/session-provider.tsx"
)
const MOBILE_WORKSPACE_PROVIDER = resolve(
  REPO_ROOT,
  "packages/mobile-app/src/providers/workspace-provider.tsx"
)
const WRITE = process.argv.includes("--write")

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.endsWith(".d.ts")
    )
      out.push(p)
  }
  return out
}

const isRepo = (p) => /(^|\/)repo[^/]*\.ts$|(^|\/)repo\.types\.ts$/.test(p)
const isPresenter = (p) => /(^|\/)presenter[^/]*\.ts$/.test(p)
// r3 (time-serialization boundary) applies to every module file EXCEPT
// presenters (the legitimate home for Date→ISO) and repo*.ts (repo currently
// emits ISO strings; converting it to emit Date is tracked under P1-7, so repo
// is excluded here to avoid double-counting that migration). This catches the
// round-6 P1-9 leak: serializeInstant in controller/dingtalk.ts, parse-service.ts,
// service/repo.ts, runtime.ts, etc. — files the old `service*/controller*`
// filename match missed. Baseline-ratcheted: existing offenders are
// grandfathered; new ones fail.
const isTimeSerializationLayer = (p) => !isPresenter(p) && !isRepo(p)

// §7 Tier C mixed modules (app + wire in one module). Their route
// registrations must go through the §5.3 appRoute()/wireRoute() markers (or a
// split *.app.ts / *.wire.ts controller), never bare app.<verb>(...).
const MIXED_MODULES = new Set([
  "automation",
  "im",
  "mcp-plugins",
  "remote-agents",
  "runtime-authorizations",
  "files",
  "devices",
  "relationship",
])
const moduleOf = (p) => {
  const m = p.split("/modules/")[1]
  return m ? m.split("/")[0] : ""
}
const isMixedModuleFile = (p) => MIXED_MODULES.has(moduleOf(p))

// r8 allowlist: files that import the DB CLIENT but are the DESIGNATED db-edge /
// injectable-default DB layer for their module — same role infrastructure/**
// plays, but living under modules/ for cohesion. They are intentional
// boundaries, not leaks. (round-6 P1-6) NOTE: files that import only `sql` + an
// Executor/KyselyDb TYPE (executor-injectable, never touch the singleton) are
// NOT flagged by r8 at all and need no entry here — e.g. access/evaluator.ts
// or repo* files that use executor-injected queries.
//   - access/guards.ts: binds defaultDb into requireRequestAction +
//     authorizeActionDefault/etc. so controllers don't import the client.
const R8_ALLOWLIST = new Set(["access/guards.ts"])
const r8Key = (p) => {
  const m = p.split("/modules/")[1]
  return m || ""
}

// R1 continuation ratchet: these services were manually cleaned so that their
// SQL/join/projection construction lives in repo.ts. Keep the scope narrow until
// the remaining services have been classified; this prevents regression without
// making unreviewed modules fail all at once.
const SQL_CLEAN_SERVICE_FILES = new Set([
  "chat/service.ts",
  "mcp-plugins/service.ts",
  "skills/service.ts",
])
const isSqlCleanServiceFile = (p) => SQL_CLEAN_SERVICE_FILES.has(r8Key(p))

const CLEAN_SERVICE_VIEW_BOUNDARY_PATTERNS = new Map([
  ["chat/service.ts", /\bChatConversationView\b/],
  [
    "tasks/service.ts",
    /\b(?:StoredTaskResolveResponse|parseStoredTaskResolveResponse)\b/,
  ],
  [
    "relationship/service.ts",
    /\b(?:ContactHubEntryView|Relationship[A-Za-z0-9]*SummaryView)\b/,
  ],
  [
    "remote-agents/service.ts",
    /\b(?:RemoteAgent[A-Za-z0-9]*View|Runtime[A-Za-z0-9]*View)\b/,
  ],
])
const isCleanServiceViewBoundaryFile = (p) =>
  CLEAN_SERVICE_VIEW_BOUNDARY_PATTERNS.has(r8Key(p))

const isRuntimeAuthServiceFile = (p) =>
  r8Key(p) === "runtime-authorizations/service.ts"
const isRuntimeAuthorizationsPresenterFile = (p) =>
  r8Key(p) === "runtime-authorizations/presenter.ts"
const isTasksServiceFile = (p) => r8Key(p) === "tasks/service.ts"
const isTasksPresenterFile = (p) => r8Key(p) === "tasks/presenter.ts"
const isContextPresenterFile = (p) => r8Key(p) === "context/presenter.ts"
const isSkillsServiceFile = (p) => r8Key(p) === "skills/service.ts"
const isSkillsControllerFile = (p) => r8Key(p) === "skills/controller.ts"
const isSkillsPresenterFile = (p) => r8Key(p) === "skills/presenter.ts"
const isMcpPluginsControllerFile = (p) =>
  r8Key(p) === "mcp-plugins/controller.ts"
const isMcpPluginsSharedSchemaFile = (p) => p === MCP_PLUGINS_SHARED_SCHEMA
const isMcpPluginsRepoFile = (p) => r8Key(p) === "mcp-plugins/repo.ts"
const MCP_PLUGIN_INSTALLATION_CONFIG_CONSUMER_FILES = new Set([
  "mcp-plugins/service.ts",
  "mcp-plugins/presenter.ts",
  "mcp-plugins/plugin-auth-connections.ts",
  "mcp-plugins/config-resolver.ts",
])
const isMcpPluginInstallationConfigConsumerFile = (p) =>
  MCP_PLUGIN_INSTALLATION_CONFIG_CONSUMER_FILES.has(r8Key(p))
const isMcpPluginAuthConnectionsFile = (p) =>
  r8Key(p) === "mcp-plugins/plugin-auth-connections.ts"
const isMcpPluginsPresenterFile = (p) => r8Key(p) === "mcp-plugins/presenter.ts"
const isMcpPluginsFeishuAuthFile = (p) =>
  r8Key(p) === "mcp-plugins/feishu/auth.ts"
const isMcpPluginsMijiaAuthFile = (p) =>
  r8Key(p) === "mcp-plugins/mijia/auth.ts"
const isMcpPluginsMijiaTypesFile = (p) =>
  r8Key(p) === "mcp-plugins/mijia/types.ts"
const isMcpPluginsServiceFile = (p) => r8Key(p) === "mcp-plugins/service.ts"
const isMcpPluginToolResolverFile = (p) =>
  r8Key(p) === "mcp-plugins/tool-resolver.ts"
const isAutomationServiceFile = (p) => r8Key(p) === "automation/service.ts"
const isImAccountsServiceFile = (p) => r8Key(p) === "im/service/accounts.ts"
const isImDeliveryLinksServiceFile = (p) =>
  r8Key(p) === "im/service/delivery-links.ts"
const isImWeixinBindingServiceFile = (p) =>
  r8Key(p) === "im/service/weixin-binding.ts"
const isImBindingsServiceFile = (p) => r8Key(p) === "im/service/bindings.ts"
const isImServiceJsonHelperSurfaceFile = (p) =>
  r8Key(p) === "im/service.ts" || r8Key(p) === "im/service/_helpers.ts"
const isModelGroupsControllerFile = (p) =>
  r8Key(p) === "model-groups/controller.ts"
const isModelGroupsSchemasFile = (p) => r8Key(p) === "model-groups/schemas.ts"
const isModelGroupsServiceFile = (p) => r8Key(p) === "model-groups/service.ts"
const isModelGroupsPresenterFile = (p) =>
  r8Key(p) === "model-groups/presenter.ts"
const isModelGroupsResolverFile = (p) => r8Key(p) === "model-groups/resolver.ts"
const isModelGroupsSharedSchemaFile = (p) => p === MODEL_GROUPS_SHARED_SCHEMA
const isDevicesSharedSchemaFile = (p) => p === DEVICES_SHARED_SCHEMA
const isAsrSharedSchemaFile = (p) => p === ASR_SHARED_SCHEMA
const isAsrServiceFile = (p) => r8Key(p) === "asr/service.ts"
const isAiIndexFile = (p) => r8Key(p) === "ai/index.ts"
const isAiProviderRegistryFile = (p) => r8Key(p) === "ai/providers/registry.ts"
const isAiProviderBuildToolsFile = (p) =>
  r8Key(p) === "ai/providers/build-tools.ts"
const isAiProviderFromGenerateTextFile = (p) =>
  r8Key(p) === "ai/providers/from-generate-text.ts"
const isAiProviderGetLanguageModelFile = (p) =>
  r8Key(p) === "ai/providers/get-language-model.ts"
const isPlatformControllerFile = (p) => r8Key(p) === "platform/controller.ts"
const isPlatformSharedSchemaFile = (p) => p === PLATFORM_SHARED_SCHEMA
const isPlatformRepoFile = (p) => r8Key(p) === "platform/repo.ts"
const isPlatformAdminServiceFile = (p) =>
  r8Key(p) === "platform/admin-service.ts"
const isPlatformPresenterFile = (p) => r8Key(p) === "platform/presenter.ts"
const isMemoryControllerFile = (p) => r8Key(p) === "memory/controller.ts"
const isMemoryPresenterFile = (p) => r8Key(p) === "memory/presenter.ts"
const isAuditIndexFile = (p) => r8Key(p) === "audit/index.ts"
const isAuditSharedSchemaFile = (p) => p === AUDIT_SHARED_SCHEMA
const isAuthIndexFile = (p) => r8Key(p) === "auth/index.ts"
const isBareAppRouteAllowedFile = (p) => r8Key(p) === "installer/controller.ts"
const isChatServiceFile = (p) => r8Key(p) === "chat/service.ts"
const isChatRepoFile = (p) => r8Key(p) === "chat/repo.ts"
const isWorkspaceControllerFile = (p) => r8Key(p) === "workspace/controller.ts"
const isWorkspacePresenterFile = (p) => r8Key(p) === "workspace/presenter.ts"
const isToolCallTasksPresenterFile = (p) =>
  r8Key(p) === "tool-call-tasks/presenter.ts"
const isWorkspaceSharedSchemaFile = (p) => p === WORKSPACE_SHARED_SCHEMA
const isWorkspaceAppsControllerFile = (p) =>
  r8Key(p) === "workspace-apps/controller.ts"
const isWorkspaceAppsSharedSchemaFile = (p) =>
  p === WORKSPACE_APPS_SHARED_SCHEMA
const isAutomationSharedSchemaFile = (p) => p === AUTOMATION_SHARED_SCHEMA
const isChatSharedSchemaFile = (p) => p === CHAT_SHARED_SCHEMA
const isImSharedSchemaFile = (p) => p === IM_SHARED_SCHEMA
const isSharedTypesIndexFile = (p) => p === SHARED_TYPES_INDEX
const isSharedUtilsIndexFile = (p) => p === SHARED_UTILS_INDEX
const isOrganizationSharedSchemaFile = (p) => p === ORGANIZATION_SHARED_SCHEMA
const isRemoteAgentsSharedSchemaFile = (p) => p === REMOTE_AGENTS_SHARED_SCHEMA
const isRelationshipSharedSchemaFile = (p) => p === RELATIONSHIP_SHARED_SCHEMA
const isSkillsSharedSchemaFile = (p) => p === SKILLS_SHARED_SCHEMA
const isWebSkillsClientFile = (p) => p === WEB_SKILLS_CLIENT
const isWebChatStoreFile = (p) => p === WEB_CHAT_STORE
const isWebChatRuntimeUiFile = (p) => p === WEB_CHAT_RUNTIME_UI
const isWebPluginInstallDialogFile = (p) => p === WEB_PLUGIN_INSTALL_DIALOG
const isWebAccessManagementFile = (p) => p === WEB_ACCESS_MANAGEMENT
const isWebImDashboardFile = (p) => p === WEB_IM_DASHBOARD
const isWebSidebarWeixinBindingFile = (p) => p === WEB_SIDEBAR_WEIXIN_BINDING
const isWebModelGroupBrowserFile = (p) => p === WEB_MODEL_GROUP_BROWSER
const isWebModelItemDialogFile = (p) => p === WEB_MODEL_ITEM_DIALOG
const isWebModelSettingsWorkbenchFile = (p) =>
  p === WEB_MODEL_SETTINGS_WORKBENCH
const isWebIntegrationEventSourcesFile = (p) =>
  p === WEB_INTEGRATION_EVENT_SOURCES
const isMobileFriendIdContractFile = (p) =>
  p === MOBILE_API_TYPES || p === MOBILE_API_CLIENT
const isClientActorListContractFile = (p) =>
  p === MOBILE_API_TYPES || p === MOBILE_API_CLIENT || p === WEB_API_CLIENT
const isWebWeixinBindingCandidatesContractFile = (p) => p === WEB_API_CLIENT
const isWebManualRuntimeGrantContractFile = (p) => p === WEB_API_CLIENT
const isWebActorModelGroupsContractFile = (p) => p === WEB_API_CLIENT
const isWebModelGroupListsContractFile = (p) => p === WEB_API_CLIENT
const isWebModelGroupDetailsContractFile = (p) => p === WEB_API_CLIENT
const isWebModelGroupItemVersionsContractFile = (p) => p === WEB_API_CLIENT
const isWebModelGroupMutationsContractFile = (p) => p === WEB_API_CLIENT
const isWebDeviceListContractFile = (p) => p === WEB_API_CLIENT
const isWebPlatformAccessContractFile = (p) => p === WEB_API_CLIENT
const isWebWorkspaceInvitesContractFile = (p) =>
  p === WEB_API_CLIENT || p === WEB_INVITE_MANAGEMENT
const isWebWorkspaceNavigationContractFile = (p) =>
  p === WEB_API_CLIENT || p === WEB_APP_SIDEBAR
const isWebWorkspaceMembersAccessContractFile = (p) =>
  p === WEB_API_CLIENT ||
  p === WEB_ACCESS_MANAGEMENT ||
  p === WEB_MODEL_SETTINGS_WORKBENCH ||
  p === WEB_REMOTE_AGENT_DETAIL ||
  p === WEB_SKILLS_CLIENT ||
  p === WEB_IM_DASHBOARD
const isClientWorkspaceListContractFile = (p) =>
  p === WEB_API_CLIENT ||
  p === WEB_WORKSPACE_PROVIDER ||
  p === WEB_POST_LOGIN ||
  p === WEB_MODEL_SETTINGS_WORKBENCH ||
  p === MOBILE_API_TYPES ||
  p === MOBILE_API_CLIENT ||
  p === MOBILE_WORKSPACE_PROVIDER
const isWebPluginInstallationDetailContractFile = (p) =>
  p === WEB_API_CLIENT ||
  p === WEB_PLUGIN_INSTALLATION_WORKBENCH ||
  p === WEB_PLUGIN_INSTALLATION_DETAIL_PAGE ||
  p === WEB_PLUGIN_INSTALL_PAGE
const isWebWorkspaceAppSuccessContractFile = (p) => p === WEB_API_CLIENT
const isWebAutomationSuccessContractFile = (p) => p === WEB_API_CLIENT
const isWebMcpAuditContractFile = (p) => p === WEB_API_CLIENT
const isWebWorkspaceAppGrantsContractFile = (p) => p === WEB_API_CLIENT
const isWebSkillsFacadeContractFile = (p) => p === WEB_API_CLIENT
const isWebMemoryFacadeContractFile = (p) => p === WEB_API_CLIENT
const isWebRemoteAgentsFacadeContractFile = (p) => p === WEB_API_CLIENT
const isWebImFacadeContractFile = (p) => p === WEB_API_CLIENT
const isWebAutomationListFacadeContractFile = (p) => p === WEB_API_CLIENT
const isWebAuditFacadeContractFile = (p) => p === WEB_API_CLIENT
const isClientFileUploadFacadeContractFile = (p) =>
  p === WEB_API_CLIENT || p === MOBILE_API_CLIENT
const isMcpPluginResponseContainerContractFile = (p) =>
  p === WEB_API_CLIENT || isMcpPluginsControllerFile(p)
const isOrganizationResponseContainerContractFile = (p) =>
  p === WEB_API_CLIENT || isOrganizationControllerFile(p)
const isWorkspaceResponseContainerContractFile = (p) =>
  p === WEB_API_CLIENT ||
  p === MOBILE_API_CLIENT ||
  isWorkspaceControllerFile(p)
const isClientWorkspaceAuthContractFile = (p) =>
  p === MOBILE_API_TYPES ||
  p === MOBILE_API_CLIENT ||
  p === MOBILE_SESSION_PROVIDER ||
  p === WEB_API_CLIENT ||
  p === WEB_WORKSPACE_PROVIDER
const isChatPresenterFile = (p) => r8Key(p) === "chat/presenter.ts"
const isChatSummaryViewFile = (p) => r8Key(p) === "chat/summary-view.ts"
const isRemoteAgentsPresenterFile = (p) =>
  r8Key(p) === "remote-agents/presenter.ts"
const isFilesControllerFile = (p) => r8Key(p) === "files/controller.ts"
const isFilesPresenterFile = (p) => r8Key(p) === "files/presenter.ts"
const isDevicesControllerFile = (p) => r8Key(p) === "devices/controller.ts"
const isDevicesAccessBindingsFile = (p) =>
  r8Key(p) === "devices/access-bindings.ts"
const isRuntimeAuthorizationsManualGrantsControllerFile = (p) =>
  r8Key(p) === "runtime-authorizations/manual-grants.controller.ts"
const isOrganizationControllerFile = (p) =>
  r8Key(p) === "organization/controller.ts"
const isOrganizationPresenterFile = (p) =>
  r8Key(p) === "organization/presenter.ts"
const isOrganizationServiceFile = (p) => r8Key(p) === "organization/service.ts"
const isOrganizationBuiltinActorPackagesFile = (p) =>
  r8Key(p) === "organization/builtin-actor-packages.ts"
const isAutomationControllerFile = (p) =>
  r8Key(p) === "automation/controller.ts"
const isAutomationPresenterFile = (p) => r8Key(p) === "automation/presenter.ts"
const isImControllerFile = (p) => r8Key(p) === "im/controller.ts"
const isImControllerSharedFile = (p) => r8Key(p) === "im/controller/_shared.ts"
const isImDingtalkControllerFile = (p) =>
  r8Key(p) === "im/controller/dingtalk.ts"
const isImWeixinQrLoginFile = (p) =>
  r8Key(p) === "im/connectors/weixin/qr-login.ts"
const isImDingtalkDeviceRegistrationFile = (p) =>
  r8Key(p) === "im/connectors/dingtalk/device-registration.ts"
const isImDingtalkRegistrationSessionStoreFile = (p) =>
  r8Key(p) === "im/connectors/dingtalk/registration-session-store.ts"
const isImStatusResolverFile = (p) =>
  r8Key(p) === "im/integration/status-resolver.ts"
const isExecutionServiceFile = (p) => r8Key(p) === "execution/service.ts"
const isAiRepoFile = (p) => r8Key(p) === "ai/repo.ts"
const isAiPromptBuilderFile = (p) => r8Key(p) === "ai/prompt-builder.ts"
const isAiContextBuilderFile = (p) => r8Key(p) === "ai/context-builder.ts"
const isSessionRuntimeFile = (p) => r8Key(p) === "session/runtime.ts"
const isSessionPresenterFile = (p) => r8Key(p) === "session/presenter.ts"
const isMobileActorActivityBubbleFile = (p) =>
  p === MOBILE_ACTOR_ACTIVITY_BUBBLE
const isImAppResponseControllerFile = (p) => {
  const key = r8Key(p)
  return key === "im/controller.ts" || key.startsWith("im/controller/")
}
const isRelationshipPresenterFile = (p) =>
  r8Key(p) === "relationship/presenter.ts"

const RULES = [
  {
    id: "r1_generated_db_outside_repo",
    appliesTo: (p) => !isRepo(p),
    test: (src, p) =>
      /from\s+["'][^"']*\/(generated\/db|db-types)(\.js)?["']/.test(src),
  },
  {
    id: "r2_tablerow_outside_repo",
    appliesTo: (p) => !isRepo(p),
    test: (src) => /\bTable(Row|Insert|Update)\s*</.test(src),
  },
  {
    id: "r3_serializeinstant_in_layer",
    appliesTo: isTimeSerializationLayer,
    test: (src) => /\bserialize(Optional)?Instant\s*\(/.test(src),
  },
  {
    // r4: row→domain mappers belong in repo*.ts. Matches map*/normalize* names
    // where "Row" appears anywhere (not only as a suffix), so it also catches
    // mapAccessRowToGrant / mapSkillAccessRowToGrant (round-6 P2-2 broadened it
    // from the old "ends in Row" form).
    id: "r4_maprow_outside_repo",
    appliesTo: (p) => !isRepo(p),
    test: (src, p) =>
      /\b(?:function|const)\s+(?:map|normalize)[A-Za-z0-9]*Row[A-Za-z0-9]*\b/.test(
        src
      ),
  },
  {
    id: "r5_bare_route_in_mixed",
    appliesTo: isMixedModuleFile,
    // matches app.get(...) AND app.get<{...}>(...) — the optional generic-arg
    // form used by typed Fastify handlers.
    test: (src) => /\bapp\.(get|post|put|delete|patch)\s*[<(]/.test(src),
  },
  {
    id: "r7_dual_naming",
    appliesTo: () => true,
    test: (src) =>
      /\brow\.[a-z]+_[a-z_]+\s*\|\|\s*row\.[a-z]+[A-Z]/.test(src) ||
      /\breturn\s*\{\s*\.\.\.row\b/.test(src) ||
      /\bsend\(\s*\{\s*\.\.\.row\b/.test(src),
  },
  {
    // r8: only repo*.ts may import the DB CLIENT (`db` / withDbTransaction from
    // infrastructure/database/kysely) — that is the module singleton, and a
    // non-repo file importing it is reaching the DB outside the repo boundary
    // (§9). NOTE: this flags the db-client import, NOT the bare `sql` tag from
    // "kysely": a file that only imports `sql` + an `Executor`/`KyselyDb` type
    // and runs every query on an INJECTED executor is the legitimate
    // executor-injectable DB layer (it cannot reach the singleton) — flagging
    // `sql` there was a false positive. `sql`…`.execute(db)` is still caught,
    // because such a file must import `db`. Baseline-ratcheted while modules
    // migrate their queries into repo.ts; a NEW db-client import fails. Genuine
    // infrastructure adapters live under infrastructure/** (not walked here);
    // designated module-level db-edge-binders / injectable-default DB layers are
    // in R8_ALLOWLIST (e.g. access/guards.ts).
    id: "r8_db_client_outside_repo",
    appliesTo: (p) => !isRepo(p) && !R8_ALLOWLIST.has(r8Key(p)),
    test: (src) =>
      /\bimport\s*\{[^}]*\b(?:db|withDbTransaction)\b[^}]*\}\s*from\s*["'][^"']*\/infrastructure\/database\/kysely(\.js)?["']/.test(
        src
      ),
  },
  {
    // r9: after chat/mcp-plugins/skills service SQL construction was moved
    // behind repo helpers, keep those services orchestration-only. The SQL
    // keyword checks intentionally target uppercase SQL used in raw template
    // literals in this codebase; comments are stripped before matching.
    id: "r9_sql_construction_in_clean_service",
    appliesTo: isSqlCleanServiceFile,
    test: (src) =>
      /from\s+["']kysely["']/.test(src) ||
      /\b(?:selectFrom|insertInto|updateTable|deleteFrom)\s*\(/.test(src) ||
      /\bsql`/.test(src) ||
      /\bCompiledQuery\b/.test(src) ||
      /\brunBuilder\s*\(/.test(src) ||
      /\brunOn(?:Db)?\s*(?:<|\()/.test(src) ||
      /\b(?:SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/.test(src),
  },
  {
    // r10: keep the already-reviewed R2 service/view boundary cleanups from
    // regressing. This is intentionally a narrow ratchet over exact residuals
    // fixed in this round, not a broad ban on every `*View` string in services.
    id: "r10_clean_service_view_boundary_residuals",
    appliesTo: isCleanServiceViewBoundaryFile,
    test: (src, p) =>
      CLEAN_SERVICE_VIEW_BOUNDARY_PATTERNS.get(r8Key(p)).test(src),
  },
  {
    // r11: runtime_authorization_grants.policy is business JSON. The cleaned
    // path hydrates and validates it through runtime-authorizations/repo.ts
    // before service logic sees a RuntimeAuthorizationGrantCandidate.
    id: "r11_runtime_auth_policy_json_repo_exit",
    appliesTo: isRuntimeAuthServiceFile,
    test: (src) =>
      /\bparseJsonObject\s*\(\s*row\.policy\s*\)/.test(src) ||
      /\bvalidateGrantPolicyForCapability\b/.test(src) ||
      /\bRuntimeAuthorizationGrantCandidateRow\b/.test(src),
  },
  {
    // r12: task prompt/resolution payloads are DB JSONB projections from
    // RawTaskRow. The cleaned path decodes them through tasks/repo.ts helpers
    // before service orchestration consumes them.
    id: "r12_tasks_payload_json_repo_exit",
    appliesTo: isTasksServiceFile,
    test: (src) =>
      /\bparseJsonObject\b/.test(src) ||
      /\b(?:prompt_payload|resolution_payload)\b/.test(src),
  },
  {
    // r13: keep selected skills DB JSONB fields decoded through repo helpers
    // before service orchestration consumes them. Do not ban JSON.parse here:
    // service still has non-row block parsing helpers that are out of scope for
    // this repo-exit slice.
    id: "r13_skills_json_repo_exit",
    appliesTo: isSkillsServiceFile,
    test: (src) =>
      /\bparseJsonObject\b/.test(src) ||
      /\bdecode(?:InstalledSkillVersionMetadata|SkillMirrorLocator|SkillPackageItemMetadata|SkillSnapshotHooks)\b/.test(
        src
      ),
  },
  {
    // r14: keep the reviewed automation DB JSONB reads decoded through repo
    // helpers. This is intentionally narrower than a global automation
    // JSON.parse ban; service still owns non-row payload assembly and opaque
    // metadata writes outside this repo-exit slice.
    id: "r14_automation_json_repo_exit",
    appliesTo: isAutomationServiceFile,
    test: (src) => /\bparseJsonObject\b/.test(src),
  },
  {
    // r15: keep transport account JSON decoding in im/service/repo.ts and
    // normalized account summary metadata as plain records in service logic.
    id: "r15_im_account_json_repo_exit",
    appliesTo: isImAccountsServiceFile,
    test: (src) => /\bparseJsonObject\b/.test(src),
  },
  {
    // r16: transport_message_links.metadata and joined conversation item
    // metadata are DB JSONB fields. The reviewed delivery-link slice decodes
    // them through im/service/repo.ts helpers before orchestration consumes
    // them.
    id: "r16_im_delivery_link_json_repo_exit",
    appliesTo: isImDeliveryLinksServiceFile,
    test: (src) => /\bparseJsonObject\b/.test(src),
  },
  {
    // r17: the current-user Weixin binding flow loads a transport account row
    // and immediately normalizes it through normalizeAccountRow(), whose
    // metadata decode lives in im/service/repo.ts. Keep this service from
    // re-parsing the raw account row metadata.
    id: "r17_im_weixin_binding_json_repo_exit",
    appliesTo: isImWeixinBindingServiceFile,
    test: (src) => /\bparseJsonObject\b/.test(src),
  },
  {
    // r18: conversation binding lookups already return normalized summary
    // metadata via normalizeBindingRow(). Keep this service from re-parsing it.
    id: "r18_im_binding_json_repo_exit",
    appliesTo: isImBindingsServiceFile,
    test: (src) => /\bparseJsonObject\b/.test(src),
  },
  {
    // r117: IM service.ts is a public domain barrel, and _helpers.ts only
    // provides string helper / normalizer compatibility exports. JSON parser
    // helpers should be imported from shared in infra/worker adapters or kept
    // private inside im/service/repo.ts for DB-row normalization.
    id: "r117_im_service_no_json_helper_exports",
    appliesTo: isImServiceJsonHelperSurfaceFile,
    test: (src) => /\bparseJson(?:Object|Array)\b/.test(src),
  },
  {
    // r118: integration event-source UI filters installed plugin records.
    // The API client returns shared PluginInstallationDetailView[]; don't
    // redeclare a local IntegrationInstallationView subset that can drift.
    id: "r118_web_integration_installation_contract_shared",
    appliesTo: isWebIntegrationEventSourcesFile,
    test: (src) =>
      /\btype\s+IntegrationInstallationView\s*=/.test(src) ||
      /\binterface\s+IntegrationInstallationView\b/.test(src),
  },
  {
    // r119: mobile's friend-id UI is the relationship profile app surface.
    // Keep it on shared RelationshipProfileView/UpdateMemberRelationshipProfileInput
    // and the current /me/relationship-profile route; the old /me/friend-id
    // endpoint/local response shape no longer exists.
    id: "r119_mobile_friend_id_contract_shared",
    appliesTo: isMobileFriendIdContractFile,
    test: (src) =>
      /\b(?:type|interface)\s+FriendIdProfileView\b/.test(src) ||
      /\bgetMyFriendIdProfile\b/.test(src) ||
      /\bupdateMyFriendIdProfile\b/.test(src) ||
      /\/me\/friend-id\b/.test(src),
  },
  {
    // r120: /workspaces/:workspaceId/actors is an appRoute endpoint whose
    // handler returns Actor[] and whose wire shape is { data: Actor[] }. Keep
    // web/mobile API facades from reviving the older { actors } compatibility
    // wrapper or local ActorListResponse duplicate.
    id: "r120_client_actor_list_contract_shared",
    appliesTo: isClientActorListContractFile,
    test: (src) =>
      /\b(?:type|interface)\s+ActorListResponse\b/.test(src) ||
      /\bnormalizeActorListResponse\b/.test(src) ||
      /\bobjectData\.actors\b/.test(src) ||
      /\bactors:\s*asArray\b/.test(src) ||
      /\?\.actors\b/.test(src),
  },
  {
    // r121: the current-user Weixin binding candidates route returns the
    // shared app value { members: WorkspaceMemberView[] } inside appRoute's
    // { data } envelope. Keep the web API facade from re-wrapping it back into
    // its old public { data: WorkspaceMemberView[] } compatibility shape.
    id: "r121_web_weixin_binding_candidates_contract_shared",
    appliesTo: isWebWeixinBindingCandidatesContractFile,
    test: (src) =>
      /\bgetCurrentUserWeixinBindingCandidates[\s\S]*return\s*\{\s*data\s*:\s*res\.data\.members\s*\}/.test(
        src
      ) ||
      /\bgetCurrentUserWeixinBindingCandidates[\s\S]*Promise\s*<\s*\{\s*data\s*:\s*Array\s*</.test(
        src
      ),
  },
  {
    // r122: the manual runtime-authorization grant app route returns
    // RuntimeAuthorizationGrantRecordView inside appRoute's { data } envelope.
    // Keep the web API facade on the shared record view rather than reviving
    // its old { grant: Record<string, unknown> } wrapper.
    id: "r122_web_manual_runtime_grant_contract_shared",
    appliesTo: isWebManualRuntimeGrantContractFile,
    test: (src) =>
      /\bcreateManualRuntimeAuthorizationGrant[\s\S]*return\s*\{\s*grant\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\bcreateManualRuntimeAuthorizationGrant[\s\S]*Promise\s*<\s*\{\s*grant\s*:\s*Record\s*<\s*string\s*,\s*unknown\s*>\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r123: actor model-group assignment routes return shared arrays inside
    // appRoute's { data } envelope. Keep the web API facade on those arrays
    // rather than reviving its old { groups: ... } wrapper.
    id: "r123_web_actor_model_groups_contract_shared",
    appliesTo: isWebActorModelGroupsContractFile,
    test: (src) =>
      /\b(?:getActorModelGroups|getVisibleActorModelGroups|setActorModelGroups)[\s\S]*return\s*\{\s*groups\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\b(?:getActorModelGroups|getVisibleActorModelGroups|setActorModelGroups)[\s\S]*Promise\s*<\s*\{\s*groups\s*:\s*(?:ActorModelGroupAssignmentListView|ModelGroupListView)\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r124: model-group list routes return ModelGroupListView arrays inside
    // appRoute's { data } envelope. Keep the web API facade on those arrays
    // rather than reviving its old { groups: ... } wrapper.
    id: "r124_web_model_group_lists_contract_shared",
    appliesTo: isWebModelGroupListsContractFile,
    test: (src) =>
      /\b(?:getModelGroups|getPlatformModelGroups|getWorkspaceMemberModelGroups)[\s\S]*return\s*\{\s*groups\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\b(?:getModelGroups|getPlatformModelGroups|getWorkspaceMemberModelGroups)[\s\S]*Promise\s*<\s*\{\s*groups\s*:\s*ModelGroupListView\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r125: model-group detail routes return ModelGroupDetailView values inside
    // appRoute's { data } envelope. Keep the web API facade on those values
    // rather than reviving its old { group: ... } wrapper. This intentionally
    // does not cover create/update mutations, which still need separate
    // consumer review.
    id: "r125_web_model_group_details_contract_shared",
    appliesTo: isWebModelGroupDetailsContractFile,
    test: (src) =>
      /\b(?:getModelGroup|getPlatformModelGroup|getWorkspaceMemberModelGroup)\b[\s\S]{0,260}return\s*\{\s*group\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\b(?:getModelGroup|getPlatformModelGroup|getWorkspaceMemberModelGroup)\b[\s\S]{0,220}Promise\s*<\s*\{\s*group\s*:\s*ModelGroupDetailView\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r126: model-group item-version routes return
    // ModelGroupItemVersionListView arrays inside appRoute's { data } envelope.
    // Keep the web API facade on those arrays rather than reviving its old
    // { versions: ... } wrapper.
    id: "r126_web_model_group_item_versions_contract_shared",
    appliesTo: isWebModelGroupItemVersionsContractFile,
    test: (src) =>
      /\b(?:getItemVersions|getPlatformItemVersions|getWorkspaceMemberItemVersions)\b[\s\S]{0,260}return\s*\{\s*versions\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\b(?:getItemVersions|getPlatformItemVersions|getWorkspaceMemberItemVersions)\b[\s\S]{0,240}Promise\s*<\s*\{\s*versions\s*:\s*ModelGroupItemVersionListView\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r127: model-group mutation/grant/item routes return shared app values
    // inside appRoute's { data } envelope. Keep the web API facade on those
    // values rather than reviving its old wrapper objects.
    id: "r127_web_model_group_mutations_contract_shared",
    appliesTo: isWebModelGroupMutationsContractFile,
    test: (src) =>
      /\b(?:createModelGroup|createPlatformModelGroup|createWorkspaceMemberModelGroup|updateModelGroup|updatePlatformModelGroup|updateWorkspaceMemberModelGroup)\b[\s\S]{0,300}return\s*\{\s*group\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\b(?:createModelGroup|createPlatformModelGroup|createWorkspaceMemberModelGroup)\b[\s\S]{0,260}Promise\s*<\s*\{\s*group\s*:\s*ModelGroupView\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:updateModelGroup|updatePlatformModelGroup|updateWorkspaceMemberModelGroup)\b[\s\S]{0,280}Promise\s*<\s*\{\s*group\s*:\s*ModelGroupDetailView\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:getModelGroupGrants|getPlatformModelGroupGrants|getWorkspaceMemberModelGroupGrants)\b[\s\S]{0,280}return\s*\{\s*grants\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\b(?:getModelGroupGrants|getPlatformModelGroupGrants|getWorkspaceMemberModelGroupGrants)\b[\s\S]{0,260}Promise\s*<\s*\{\s*grants\s*:\s*ModelGroupGrantListView\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:issueModelGroupGrant|issuePlatformModelGroupGrant|issueWorkspaceMemberModelGroupGrant)\b[\s\S]{0,300}return\s*\{\s*grant\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\b(?:issueModelGroupGrant|issuePlatformModelGroupGrant|issueWorkspaceMemberModelGroupGrant)\b[\s\S]{0,260}Promise\s*<\s*\{\s*grant\s*:\s*ModelGroupGrantView\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:addModelItem|addPlatformModelItem|addWorkspaceMemberModelItem|updateModelItem|updatePlatformModelItem|updateWorkspaceMemberModelItem)\b[\s\S]{0,300}return\s*\{\s*item\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\b(?:addModelItem|addPlatformModelItem|addWorkspaceMemberModelItem|updateModelItem|updatePlatformModelItem|updateWorkspaceMemberModelItem)\b[\s\S]{0,260}Promise\s*<\s*\{\s*item\s*:\s*ModelGroupItemView\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r128: device list route returns DeviceListView arrays inside appRoute's
    // { data } envelope. Keep the web API facade on that array rather than
    // reviving its old { devices: ... } wrapper.
    id: "r128_web_device_list_contract_shared",
    appliesTo: isWebDeviceListContractFile,
    test: (src) =>
      /\blistDevices\b[\s\S]{0,220}return\s*\{\s*devices\s*:\s*res\.data\s*\}/.test(
        src
      ) ||
      /\blistDevices\b[\s\S]{0,180}Promise\s*<\s*\{\s*devices\s*:\s*DeviceView\[\]\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r129: platform navigation/access routes already return shared app values
    // inside appRoute's { data } envelope. Keep the web API facade on those
    // values instead of exposing the raw envelope to page components.
    id: "r129_web_platform_access_contract_shared",
    appliesTo: isWebPlatformAccessContractFile,
    test: (src) =>
      /\bgetPlatformNavigation\b[\s\S]{0,180}Promise\s*<\s*\{\s*data\s*:\s*PlatformNavigationView\s*\}\s*>/.test(
        src
      ) ||
      /\bgetPlatformAccess\b[\s\S]{0,180}Promise\s*<\s*\{\s*data\s*:\s*PlatformAccessBindingListView\s*\}\s*>/.test(
        src
      ) ||
      /\bgrantPlatformAccess\b[\s\S]{0,220}Promise\s*<\s*\{\s*data\s*:\s*PlatformAccessBindingView\s*\}\s*>/.test(
        src
      ) ||
      /\bgetPlatformNavigation\b[\s\S]{0,180}return\s+this\.fetch\(\s*["']\/platform\/navigation["']/.test(
        src
      ) ||
      /\bgetPlatformAccess\b[\s\S]{0,180}return\s+this\.fetch\(\s*["']\/platform\/access["']/.test(
        src
      ) ||
      /\bgrantPlatformAccess\b[\s\S]{0,260}return\s+this\.fetch\(\s*["']\/platform\/access["']/.test(
        src
      ),
  },
  {
    // r130: workspace invite management routes return WorkspaceInviteView values
    // inside appRoute's { data } envelope. Keep the web API facade and consumer
    // on those values instead of exposing the raw envelope.
    id: "r130_web_workspace_invites_contract_shared",
    appliesTo: isWebWorkspaceInvitesContractFile,
    test: (src) =>
      /\bcreateInvite\b[\s\S]{0,200}Promise\s*<\s*\{\s*data\s*:\s*WorkspaceInviteView\s*\}\s*>/.test(
        src
      ) ||
      /\blistInvites\b[\s\S]{0,180}Promise\s*<\s*\{\s*data\s*:\s*WorkspaceInviteView\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\brevokeInvite\b[\s\S]{0,220}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/invites\/\$\{inviteId\}`/.test(
        src
      ) ||
      /\b(?:createInvite|listInvites)\b[\s\S]{0,260}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/invites/.test(
        src
      ) ||
      /\bsetInvites\(\s*(?:res|response)\?\.data\s*\?\?\s*\[\s*\]\s*\)/.test(
        src
      ),
  },
  {
    // r131: workspace navigation returns a shared WorkspaceNavigationView inside
    // appRoute's { data } envelope. Keep the web API facade and sidebar on that
    // value instead of exposing the raw envelope.
    id: "r131_web_workspace_navigation_contract_shared",
    appliesTo: isWebWorkspaceNavigationContractFile,
    test: (src) =>
      /\bgetWorkspaceNavigation\b[\s\S]{0,180}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/navigation`/.test(
        src
      ) ||
      /\bgetWorkspaceNavigation\b[\s\S]{0,180}Promise\s*<\s*\{\s*data\s*:\s*WorkspaceNavigationView\s*\}\s*>/.test(
        src
      ) ||
      /\bcatch\(\s*\(\)\s*=>\s*\(\s*\{\s*data\s*:\s*emptyWorkspaceNavigation\s*\}\s*\)\s*\)/.test(
        src
      ) ||
      /\bPromise\.resolve\(\s*\{\s*data\s*:\s*emptyWorkspaceNavigation\s*\}\s*\)/.test(
        src
      ) ||
      /\bworkspaceResponse\?\.data\b/.test(src),
  },
  {
    // r132: workspace members/access routes return shared app values inside
    // appRoute's { data } envelope. Keep the web API facade and known consumers
    // on those values instead of exposing the raw envelope.
    id: "r132_web_workspace_members_access_contract_shared",
    appliesTo: isWebWorkspaceMembersAccessContractFile,
    test: (src) =>
      /\bgetWorkspaceMembers\b[\s\S]{0,180}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/members`/.test(
        src
      ) ||
      /\bgetWorkspaceAccess\b[\s\S]{0,180}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/access`/.test(
        src
      ) ||
      /\brevokeWorkspaceAccess\b[\s\S]{0,320}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/access\/\$\{accessKey\}\/members\/\$\{workspaceMemberId\}\/revoke`/.test(
        src
      ) ||
      /\bgetWorkspaceMembers\b[\s\S]{0,180}Promise\s*<\s*\{\s*data\s*:\s*WorkspaceMemberView\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\bgetWorkspaceAccess\b[\s\S]{0,180}Promise\s*<\s*\{\s*data\s*:\s*WorkspaceAccessBindingView\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:memberResponse|accessResponse|membersResponse)\?\.data\b/.test(
        src
      ) ||
      /\bmembersResult\.value\.data\b/.test(src) ||
      /\bworkspaceMembers(?:Response|Res)[\s\S]{0,160}\.data\b/.test(src),
  },
  {
    // r133: workspace list route returns WorkspaceListItemView arrays inside
    // appRoute's { data } envelope. Keep web/mobile API facades and known
    // consumers on the array value instead of exposing the raw envelope.
    id: "r133_client_workspace_list_contract_shared",
    appliesTo: isClientWorkspaceListContractFile,
    test: (src) =>
      /\bWorkspaceListResponse\s*=\s*\{\s*data\s*:/.test(src) ||
      /\bgetWorkspaces\b[\s\S]{0,180}Promise\s*<\s*WorkspaceListResponse\s*>/.test(
        src
      ) ||
      /\bgetWorkspaces\b[\s\S]{0,180}return\s+this\.fetch\(\s*["']\/workspaces["']/.test(
        src
      ) ||
      /\bnormalizeWorkspaceListResponse\b/.test(src) ||
      /\b(?:const\s+)?(?:workspaces|list)\b[^=\n]*=\s*(?:result|res|response)\.data\s*\?\?\s*\[\s*\]/.test(
        src
      ) ||
      /\bworkspacesResult\.value\.data\b/.test(src),
  },
  {
    // r134: plugin installation detail route returns PluginInstallationDetailView
    // inside appRoute's { data } envelope. Keep the web API facade and known
    // consumers on that value instead of reviving { installation }.
    id: "r134_web_plugin_installation_detail_contract_shared",
    appliesTo: isWebPluginInstallationDetailContractFile,
    test: (src) =>
      /\bgetInstallation\b[\s\S]{0,180}Promise\s*<\s*\{\s*installation\s*:\s*PluginInstallationDetailView\s*\}\s*>/.test(
        src
      ) ||
      /\breturn\s+\{\s*installation\s*:\s*res\.data\s*\}/.test(src) ||
      /\b(?:data|freshInstallation|installationData)(?:\.|\?\.)installation\b/.test(
        src
      ) ||
      /\bconst\s+\{\s*installation\s*\}\s*=\s*await\s+this\.getInstallation\b/.test(
        src
      ),
  },
  {
    // r135: workspace-app delete routes return WorkspaceAppSuccessView inside
    // appRoute's { data } envelope. Keep web facades on the shared success
    // value instead of exposing raw fetch responses or a local { deleted }.
    id: "r135_web_workspace_app_success_contract_shared",
    appliesTo: isWebWorkspaceAppSuccessContractFile,
    test: (src) =>
      /\b(?:deleteActor|deleteRemoteAgent|uninstallInstalledSkill|uninstallPlugin)\b[\s\S]{0,180}Promise\s*<\s*\{/.test(
        src
      ) ||
      /\b(?:deleteActor|deleteRemoteAgent|uninstallInstalledSkill|uninstallPlugin)\b[\s\S]{0,320}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/workspace-apps\/\$\{/.test(
        src
      ) ||
      /\b(?:deleteActor|deleteRemoteAgent|uninstallInstalledSkill|uninstallPlugin)\b[\s\S]{0,260}return\s+res\b(?!\.data)/.test(
        src
      ),
  },
  {
    // r136: automation delete/archive routes return AutomationSuccess inside
    // appRoute's { data } envelope. Keep web facades on the shared success
    // value instead of exposing raw fetch responses.
    id: "r136_web_automation_success_contract_shared",
    appliesTo: isWebAutomationSuccessContractFile,
    test: (src) =>
      /\b(?:archiveAutomationEventSource|deleteAutomation)\b[\s\S]{0,180}Promise\s*<\s*\{/.test(
        src
      ) ||
      /\b(?:archiveAutomationEventSource|deleteAutomation)\b[\s\S]{0,320}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/automation/.test(
        src
      ) ||
      /\b(?:archiveAutomationEventSource|deleteAutomation)\b[\s\S]{0,260}return\s+res\b(?!\.data)/.test(
        src
      ),
  },
  {
    // r137: MCP audit routes return PluginAuditLogList arrays inside
    // appRoute's { data } envelope. Keep web facades on the shared list value
    // instead of exposing raw fetch envelopes.
    id: "r137_web_mcp_audit_contract_shared",
    appliesTo: isWebMcpAuditContractFile,
    test: (src) =>
      /\b(?:getMcpToolCallLogs|getMcpEventLogs)\b[\s\S]{0,180}Promise\s*<\s*\{\s*data\s*:\s*PluginAuditLogList\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:getMcpToolCallLogs|getMcpEventLogs)\b[\s\S]{0,260}return\s+this\.fetch\(\s*withQuery\(\s*`\/workspaces\/\$\{wsId\}\/mcp\/audit\/(?:tool-calls|events)`/.test(
        src
      ) ||
      /\b(?:getMcpToolCallLogs|getMcpEventLogs)\b[\s\S]{0,260}return\s+(?:res|response)\b(?!\.data)/.test(
        src
      ),
  },
  {
    // r138: workspace-app grant GET/PUT routes return
    // WorkspaceAppGrantListView inside appRoute's { data } envelope. Keep web
    // facades on the shared grant-list value instead of exposing raw fetch
    // envelopes or local { grants: WorkspaceAppGrant[] } return types.
    id: "r138_web_workspace_app_grants_contract_shared",
    appliesTo: isWebWorkspaceAppGrantsContractFile,
    test: (src) =>
      /\b(?:getWorkspaceAppGrants|replaceWorkspaceAppGrants)\b[\s\S]{0,180}Promise\s*<\s*\{\s*grants\s*:\s*WorkspaceAppGrant\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:getWorkspaceAppGrants|replaceWorkspaceAppGrants)\b[\s\S]{0,320}return\s+this\.fetch\(\s*`\/workspaces\/\$\{wsId\}\/workspace-apps\/\$\{appId\}\/grants`/.test(
        src
      ) ||
      /\b(?:getWorkspaceAppGrants|replaceWorkspaceAppGrants)\b[\s\S]{0,280}return\s+(?:res|response)\b(?!\.data)/.test(
        src
      ),
  },
  {
    // r139: skills marketplace and installed-skill app routes already return
    // shared view schemas. Keep the web API facade typed against those shared
    // response contracts instead of local { skill(s): ... } aliases.
    id: "r139_web_skills_facade_contract_shared",
    appliesTo: isWebSkillsFacadeContractFile,
    test: (src) =>
      /\bgetSkillMarketplace\b[\s\S]{0,180}Promise\s*<\s*\{\s*skills\s*:\s*SkillMarketplaceEntry\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:getSkillMarketplaceItem|publishMarketplaceSkill|importMarketplaceSkill|refreshMarketplaceSkill)\b[\s\S]{0,180}Promise\s*<\s*\{\s*skill\s*:\s*SkillMarketplaceEntry\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:createWorkspaceSkill|getInstalledSkill|installSkill|updateInstalledSkill|upgradeInstalledSkill)\b[\s\S]{0,180}Promise\s*<\s*\{\s*skill\s*:\s*InstalledSkill\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r140: memory app routes already return shared view schemas. Keep web
    // facades explicitly typed against those contracts and avoid cast-backed
    // or implicit-any response values.
    id: "r140_web_memory_facade_contract_shared",
    appliesTo: isWebMemoryFacadeContractFile,
    test: (src) =>
      /\bgetMemories\b[\s\S]{0,220}res\.data\s+as\s+MemoryListView\b/.test(
        src
      ) ||
      /\b(?:getMemory|createMemory|updateMemory|moveMemory)\s*\([^)]*\)\s*\{/.test(
        src
      ),
  },
  {
    // r141: remote-agent app routes already return shared response schemas.
    // Keep web facades typed against those shared contracts instead of local
    // wrapper aliases.
    id: "r141_web_remote_agents_facade_contract_shared",
    appliesTo: isWebRemoteAgentsFacadeContractFile,
    test: (src) =>
      /\bgetRemoteAgents\b[\s\S]{0,180}Promise\s*<\s*\{\s*remoteAgents\s*:\s*RemoteAgentView\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:getRemoteAgent|createRemoteAgent|updateRemoteAgent|bindRemoteAgent)\b[\s\S]{0,180}Promise\s*<\s*\{\s*remoteAgent\s*:\s*RemoteAgentView\s*\}\s*>/.test(
        src
      ) ||
      /\bgetRemoteAgentMachines\b[\s\S]{0,180}Promise\s*<\s*\{\s*machines\s*:\s*RemoteAgentMachineView\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:getRemoteAgentGroupTaskGrants|updateRemoteAgentGroupTaskGrants)\b[\s\S]{0,180}Promise\s*<\s*\{\s*grants\s*:\s*RemoteAgentGroupTaskGrantView\[\]\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r142: IM app routes already return shared response schemas. Keep web
    // facades typed against those shared contracts instead of local wrapper
    // aliases or older duplicated response types.
    id: "r142_web_im_facade_contract_shared",
    appliesTo: isWebImFacadeContractFile,
    test: (src) =>
      /\bgetTransportConnectors\b[\s\S]{0,180}Promise\s*<\s*\{\s*connectors\s*:\s*TransportConnectorCapability\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\bgetTransportAccounts\b[\s\S]{0,180}Promise\s*<\s*\{\s*accounts\s*:\s*TransportAccountSummary\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\bgetTransportSessions\b[\s\S]{0,180}Promise\s*<\s*\{\s*sessions\s*:\s*TransportSessionSummary\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\bgetTransportExternalUsers\b[\s\S]{0,220}Promise\s*<\s*\{\s*externalUsers\s*:\s*TransportExternalUserSummary\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:createFeishuTransportAccount|updateFeishuTransportAccount|createWecomTransportAccount|updateWecomTransportAccount|createQqTransportAccount|updateQqTransportAccount|createDingtalkAccountManual|createTransportAccount|updateTransportAccount)\b[\s\S]{0,220}Promise\s*<\s*\{\s*account\s*:\s*TransportAccountSummary\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:startWeixinQrTransportSession|getWeixinQrTransportSession|startCurrentUserWeixinBindingQr|getCurrentUserWeixinBindingQr)\b[\s\S]{0,220}Promise\s*<\s*\{\s*session\s*:\s*WeixinQrLoginSessionSummary\s*\}\s*>/.test(
        src
      ) ||
      /\bstartDingtalkDeviceFlow\b[\s\S]{0,180}Promise\s*<\s*DingtalkDeviceFlowStartResponse\s*>/.test(
        src
      ) ||
      /\bpollDingtalkDeviceFlow\b[\s\S]{0,180}Promise\s*<\s*DingtalkDeviceFlowPollResponse\s*>/.test(
        src
      ) ||
      /\bgetCurrentUserWeixinBinding\b[\s\S]{0,180}Promise\s*<\s*\{\s*binding\s*:\s*CurrentUserWeixinBindingSummary\s*\|\s*null\s*\}\s*>/.test(
        src
      ) ||
      /\b(?:linkCurrentUserWeixinBinding|setCurrentUserWeixinBindingAutoLink)\b[\s\S]{0,220}Promise\s*<\s*\{\s*binding\s*:\s*CurrentUserWeixinBindingSummary\s*\}\s*>/.test(
        src
      ) ||
      /\bupdateTransportSessionSettings\b[\s\S]{0,220}Promise\s*<\s*\{\s*session\s*:\s*TransportSessionSummary\s*\|\s*null\s*\}\s*>/.test(
        src
      ) ||
      /\bsetTransportExternalUserWorkspaceMember\b[\s\S]{0,220}Promise\s*<\s*\{\s*externalUser\s*:\s*TransportExternalUserSummary\s*\}\s*>/.test(
        src
      ),
  },
  {
    // r143: MCP plugin app routes already have shared item schemas; keep the
    // response containers in shared too, so API and web cannot drift on arrays
    // or publisher detail shapes.
    id: "r143_mcp_plugin_response_containers_shared_contract",
    appliesTo: isMcpPluginResponseContainerContractFile,
    test: (src) =>
      /z\.array\(\s*(?:MarketplacePluginViewSchema|PluginCategoryViewSchema|MarketplacePublisherViewSchema|PluginInstallationDetailViewSchema)\s*\)/.test(
        src
      ) ||
      /MarketplacePublisherViewSchema\.extend\(\s*\{[\s\S]{0,160}plugins\s*:\s*z\.array\(\s*MarketplacePluginViewSchema\s*\)/.test(
        src
      ) ||
      /\bgetMarketplace\b[\s\S]{0,180}Promise\s*<\s*MarketplacePluginView\[\]\s*>/.test(
        src
      ) ||
      /\bgetPluginCategories\b[\s\S]{0,180}Promise\s*<\s*PluginCategoryView\[\]\s*>/.test(
        src
      ) ||
      /\bgetMcpOrganizations\b[\s\S]{0,180}Promise\s*<\s*MarketplacePublisherView\[\]\s*>/.test(
        src
      ) ||
      /\bgetMcpOrganization\b[\s\S]{0,220}Promise\s*<\s*MarketplacePublisherView\s*&\s*\{\s*plugins\s*:\s*MarketplacePluginView\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\bgetInstallations\b[\s\S]{0,180}Promise\s*<\s*PluginInstallationDetailView\[\]\s*>/.test(
        src
      ),
  },
  {
    // r144: organization app routes already have shared item schemas; keep
    // list response containers in shared too, so API and web cannot drift on
    // actors/tree/packages/version arrays.
    id: "r144_organization_response_containers_shared_contract",
    appliesTo: isOrganizationResponseContainerContractFile,
    test: (src) =>
      /z\.array\(\s*(?:ActorViewSchema|ActorTreeNodeViewSchema|ActorPackageRecordViewSchema|ActorVersionViewSchema)\s*\)/.test(
        src
      ) ||
      /\bgetActorVersions\b[\s\S]{0,180}(?:\)\s*\{|Promise\s*<\s*ActorVersion\[\]\s*>)/.test(
        src
      ) ||
      /\bgetActorPackages\b[\s\S]{0,180}Promise\s*<\s*ActorPackageRecord\[\]\s*>/.test(
        src
      ) ||
      /\bgetOrgTree\b[\s\S]{0,180}(?:\)\s*\{|Promise\s*<\s*ActorTreeNodeView\[\]\s*>)/.test(
        src
      ),
  },
  {
    // r145: workspace app routes already have shared item schemas; keep list
    // response containers in shared too, so API, web, and mobile cannot drift
    // on workspace/member/access/invite arrays.
    id: "r145_workspace_response_containers_shared_contract",
    appliesTo: isWorkspaceResponseContainerContractFile,
    test: (src) =>
      /(?:WorkspaceListItemViewSchema|WorkspaceMemberViewSchema|WorkspaceAccessBindingViewSchema|WorkspaceInviteViewSchema)\.array\(\)/.test(
        src
      ) ||
      /\bgetWorkspaces\b[\s\S]{0,180}Promise\s*<\s*WorkspaceListItemView\[\]\s*>/.test(
        src
      ) ||
      /request\s*<\s*\{\s*data\s*:\s*WorkspaceListItemView\[\]\s*\}\s*>/.test(
        src
      ) ||
      /\bgetWorkspaceMembers\b[\s\S]{0,180}Promise\s*<\s*WorkspaceMemberView\[\]\s*>/.test(
        src
      ) ||
      /\bgetWorkspaceAccess\b[\s\S]{0,180}Promise\s*<\s*WorkspaceAccessBindingView\[\]\s*>/.test(
        src
      ) ||
      /\blistInvites\b[\s\S]{0,180}Promise\s*<\s*WorkspaceInviteView\[\]\s*>/.test(
        src
      ),
  },
  {
    // r146: automation app routes already return shared list schemas. Keep
    // web facades typed against those contracts instead of element arrays.
    id: "r146_web_automation_list_facade_contract_shared",
    appliesTo: isWebAutomationListFacadeContractFile,
    test: (src) =>
      /\bgetAutomationEventSources\b[\s\S]{0,180}Promise\s*<\s*AutomationEventSource\[\]\s*>/.test(
        src
      ) ||
      /\bgetAutomationEventSourceOccurrences\b[\s\S]{0,180}Promise\s*<\s*AutomationOccurrence\[\]\s*>/.test(
        src
      ) ||
      /\bgetAutomations\b[\s\S]{0,180}Promise\s*<\s*AutomationRule\[\]\s*>/.test(
        src
      ) ||
      /\bgetAutomationExecutions\b[\s\S]{0,180}Promise\s*<\s*AutomationExecution\[\]\s*>/.test(
        src
      ),
  },
  {
    // r147: audit app route already returns shared AuditLogListViewSchema.
    // Keep the web facade typed against the appRoute envelope instead of
    // recovering the contract with a local cast or returning the raw envelope.
    id: "r147_web_audit_facade_contract_shared",
    appliesTo: isWebAuditFacadeContractFile,
    test: (src) =>
      /\bgetAuditLogs\b[\s\S]{0,220}as\s+\{\s*data\s*:\s*AuditLogListView\s*\}/.test(
        src
      ) ||
      /\bgetAuditLogs\b[\s\S]{0,180}Promise\s*<\s*\{\s*data\s*:\s*AuditLogListView\s*\}\s*>/.test(
        src
      ) ||
      /\bgetAuditLogs\b[\s\S]{0,260}return\s+this\.fetch\(\s*withQuery\(\s*`\/workspaces\/\$\{wsId\}\/audit-logs`/.test(
        src
      ) ||
      /\bgetAuditLogs\b[\s\S]{0,260}return\s+(?:res|response)\b(?!\.data)/.test(
        src
      ),
  },
  {
    // r148: file upload app route returns StoredFileRecordViewSchema inside
    // appRoute's { data } envelope. Keep web/mobile XHR facades parsing that
    // shared schema instead of casting the envelope to FileRecordView.
    id: "r148_client_file_upload_facade_contract_shared",
    appliesTo: isClientFileUploadFacadeContractFile,
    test: (src) =>
      /\b(?:request\.response|data)\s+as\s+\{\s*data\s*:\s*FileRecordView\s*\}/.test(
        src
      ) ||
      /\b(?:resolve|succeed)\(\s*\(\s*(?:request\.response|data)\s+as\s+\{\s*data\s*:\s*FileRecordView\s*\}\s*\)\.data\s*\)/.test(
        src
      ),
  },
  {
    // r19: model-groups is an app-only module that now uses appRoute() as the
    // explicit surface marker. Keep this cleaned controller from reintroducing
    // bare Fastify app.<verb>() registrations while ordinary app-route guards
    // expand incrementally.
    id: "r19_model_groups_app_route_marker",
    appliesTo: isModelGroupsControllerFile,
    test: (src) => /\bapp\.(get|post|put|delete|patch)\s*[<(]/.test(src),
  },
  {
    // r20: audit log reads are app-facing and now return a shared schema-backed
    // `{ data }` envelope through appRoute(). Keep the cleaned route marker from
    // regressing to bare Fastify registration.
    id: "r20_audit_app_route_marker",
    appliesTo: isAuditIndexFile,
    test: (src) => /\bapp\.(get|post|put|delete|patch)\s*[<(]/.test(src),
  },
  {
    // r21: custom /auth/me app endpoints now use appRoute(). Do not match
    // app.all(): the Better Auth wildcard is a native passthrough surface.
    id: "r21_auth_custom_app_route_marker",
    appliesTo: isAuthIndexFile,
    test: (src) => /\bapp\.(get|post|put|delete|patch)\s*[<(]/.test(src),
  },
  {
    // r46: the custom auth app endpoints have concrete shared contracts:
    // AuthMeViewSchema for GET/PUT /auth/me, shared request DTOs for update /
    // unlink, and z.undefined() for 204 writes. They should not fall back to a
    // self-sent z.unknown() response marker.
    id: "r46_auth_custom_app_schema_shared_contract",
    appliesTo: isAuthIndexFile,
    test: (src) =>
      /\bconst\s+selfSentResponseSchema\b/.test(src) ||
      /\bschema\s*:\s*z\.unknown\s*\(\s*\)/.test(src) ||
      /\breturn\s+sendData\s*\(\s*reply\s*,\s*AuthMeViewSchema\b/.test(src),
  },
  {
    // r47: model-groups routes now register concrete shared app schemas
    // directly on appRoute() and return presenter DTOs for the helper to
    // envelope. They should not fall back to self-sent sendData() hidden behind
    // a z.unknown() response marker.
    id: "r47_model_groups_app_schema_shared_contract",
    appliesTo: isModelGroupsControllerFile,
    test: (src) =>
      /\bconst\s+selfSentResponseSchema\b/.test(src) ||
      /\bschema\s*:\s*z\.unknown\s*\(\s*\)/.test(src) ||
      /\breturn\s+sendData\s*\(\s*reply\s*,/.test(src),
  },
  {
    // r48: automation routes already register concrete shared app response
    // schemas on appRoute(). Creation/ingest handlers should set status and
    // return DTOs, leaving envelope/schema parsing to appRoute().
    id: "r48_automation_app_response_schema_shared_contract",
    appliesTo: isAutomationControllerFile,
    test: (src) => /\bsendData\s*\(\s*reply\s*,/.test(src),
  },
  {
    // r49: files app routes already register concrete shared response schemas
    // on appRoute(). Upload/enqueue handlers should set status and return DTOs,
    // leaving envelope/schema parsing to appRoute().
    id: "r49_files_app_response_schema_shared_contract",
    appliesTo: isFilesControllerFile,
    test: (src) => /\bsendData\s*\(\s*reply\s*,/.test(src),
  },
  {
    // r50: manual runtime-authorization grant app route already registers the
    // concrete shared response schema on appRoute(). The create handler should
    // set 201 and return the DTO through appRoute().
    id: "r50_runtime_auth_manual_response_schema_shared_contract",
    appliesTo: isRuntimeAuthorizationsManualGrantsControllerFile,
    test: (src) => /\bsendData\s*\(\s*reply\s*,/.test(src),
  },
  {
    // r51: IM app routes already register concrete shared response schemas on
    // appRoute(). Account/QR create handlers should set status and return DTOs,
    // leaving envelope/schema parsing to appRoute().
    id: "r51_im_app_response_schema_shared_contract",
    appliesTo: isImAppResponseControllerFile,
    test: (src) => /\bsendData\s*\(\s*reply\s*,/.test(src),
  },
  {
    // r22: the route-marker cleanup has reached all module files except the
    // explicit /install.{sh,ps1} file endpoints. From here on, app-facing and
    // wire-facing routes should use appRoute()/wireRoute() or a documented
    // passthrough like Better Auth's app.all wildcard.
    id: "r22_no_bare_app_route_outside_allowed",
    appliesTo: (p) => !isBareAppRouteAllowedFile(p),
    test: (src) => /\bapp\.(get|post|put|delete|patch)\s*[<(]/.test(src),
  },
  {
    // r23: chat row metadata/draft_payload fields now leave chat/repo.ts as
    // decoded records. Keep this narrow: service still parses non-row event
    // payloads through asJsonRecord().
    id: "r23_chat_selected_json_repo_exit",
    appliesTo: isChatServiceFile,
    test: (src) =>
      /\basJsonRecord\s*\(\s*row\.(?:metadata|draftPayload)\s*\)/.test(src) ||
      /\basJsonRecord\s*\(\s*participant\.metadata\s*\)/.test(src),
  },
  {
    // r24: the reviewed workspace app request body DTOs now live in
    // @synapse/shared/schemas. Keep the exact controller-local schema names from
    // coming back without imposing a global request DTO rule yet.
    id: "r24_workspace_app_input_schema_shared_contract",
    appliesTo: isWorkspaceControllerFile,
    test: (src) =>
      /\bconst\s+(?:createWorkspace|updateWorkspace|addMember|createInvite|workspaceAccess|chiefActorPreference|workspaceCapabilityConversationTypePolicyUpdate)Schema\b/.test(
        src
      ),
  },
  {
    // r25: upload origin is a multipart app request field shared by API,
    // web-next, and mobile-app. Its schema lives in @synapse/shared/schemas.
    id: "r25_files_upload_origin_schema_shared_contract",
    appliesTo: isFilesControllerFile,
    test: (src) => /\bconst\s+fileUploadOriginSchema\b/.test(src),
  },
  {
    // r26: actor-package install is an app request body shared by API and
    // web-next. Keep the migrated body/initial-grant schemas from returning to
    // organization/controller.ts. Include the dead actor-doc/content-block local
    // schemas removed in the same slice so they do not become misleading
    // controller-local contract roots again.
    id: "r26_organization_actor_package_install_input_shared_contract",
    appliesTo: isOrganizationControllerFile,
    test: (src) =>
      /\bconst\s+(?:installActorPackage|initialGrant|initialGrantTarget|initialGrantSubject|workspaceAppGrantPermission|contentBlock|actorDoc)Schema\b/.test(
        src
      ),
  },
  {
    // r27: automation app request bodies/queries now live in
    // @synapse/shared/schemas. Keep the migrated controller-local schema names
    // from returning; webhookIngressSchema remains local because it is a wire
    // webhook adapter, not an app contract.
    id: "r27_automation_app_input_schema_shared_contract",
    appliesTo: isAutomationControllerFile,
    test: (src) =>
      /\bconst\s+(?:contentBlocks|trigger|policy|delivery|updateDelivery|createAutomation|updateAutomation|conversationTypeMask|accessTarget|accessGrant|accessGrantUpdate|createWebhookEndpoint|integrationEventSource|eventSource|updateEventSource|ingestEvent)Schema\b/.test(
        src
      ) || /\brequest\.query\s+as\s+\{[\s\S]*?\}/.test(src),
  },
  {
    // r28: model-groups app request body schemas now live in
    // @synapse/shared/schemas. The local schemas.ts file may compose those
    // shared schemas for file-import validation, but it must not become the
    // HTTP contract root again.
    id: "r28_model_groups_app_input_schema_shared_contract",
    appliesTo: (p) =>
      isModelGroupsControllerFile(p) || isModelGroupsSchemasFile(p),
    test: (src, file) =>
      isModelGroupsControllerFile(file)
        ? /from\s+["']\.\/schemas\.js["']/.test(src)
        : /\bexport\s+const\s+(?:routingStrategyEnum|providerKindSchema|vendorSchema|grantScopeEnum|featuresSchema|attemptPolicySchema|createGroupSchema|updateGroupSchema|addItemSchema|updateItemSchema|setActorGroupsSchema|issueGrantSchema)\s*=\s*z\./.test(
            src
          ),
  },
  {
    // r29: generic IM app request bodies/queries now live in
    // @synapse/shared/schemas. The _shared.ts file may alias shared schemas for
    // old local imports, but must not define the generic app contract root.
    id: "r29_im_generic_app_input_schema_shared_contract",
    appliesTo: (p) => isImControllerFile(p) || isImControllerSharedFile(p),
    test: (src, file) =>
      isImControllerFile(file)
        ? /import\s+\{[\s\S]*\b(?:accountSchema|updateAccountSchema|transportSessionSettingsSchema|linkedUserSchema)\b[\s\S]*\}\s+from\s+["']\.\/controller\/_shared\.js["']/.test(
            src
          ) ||
          /\brequest\.query\s+as\s+\{\s*transportAccountId\??:\s*string\s*\}/.test(
            src
          )
        : /\bexport\s+const\s+(?:accountSchema|updateAccountSchema|transportSessionSettingsSchema|linkedUserSchema)\s*=\s*z\./.test(
            src
          ) ||
          /\bexport\s+function\s+validateTransport(?:AccountOwner|AccountInboundActor|ConversationInboundActor)/.test(
            src
          ),
  },
  {
    // r30: selected per-transport IM app request body schemas now live in
    // @synapse/shared/schemas. Keep _shared.ts as compatibility aliases for
    // transport controllers, not the contract root. DingTalk's device-flow and
    // manual account schemas are protected by r31.
    id: "r30_im_transport_app_input_schema_shared_contract",
    appliesTo: isImControllerSharedFile,
    test: (src) =>
      /\bexport\s+const\s+(?:feishuAccountSchema|updateFeishuAccountSchema|wecomAccountSchema|updateWecomAccountSchema|qqAccountSchema|updateQqAccountSchema|weixinQrSessionSchema|bindingAutoLinkSchema)\s*=\s*z\./.test(
        src
      ) ||
      /\bconst\s+(?:wecomBaseWsUrlSchema|WECOM_WS_URL_PATTERN)\b/.test(src) ||
      /from\s+["']\.\.\/connectors\/wecom\/credentials\.js["']/.test(src),
  },
  {
    // r31: DingTalk device-flow start and manual account app request bodies
    // now live in @synapse/shared/schemas. Keep dingtalk.ts as route
    // orchestration, not the contract root.
    id: "r31_im_dingtalk_app_input_schema_shared_contract",
    appliesTo: isImDingtalkControllerFile,
    test: (src) =>
      /\bconst\s+(?:deviceFlowStartSchema|manualAccountSchema)\s*=\s*z\./.test(
        src
      ) ||
      /\bconst\s+accountOwnerInboundShape\b/.test(src) ||
      /\b(?:transportAccountOwnerCreateShape|transportAccountInboundActorCreateShape|validateTransportAccountOwnerCreate|validateTransportAccountInboundActorCreate)\b/.test(
        src
      ),
  },
  {
    // r32: workspace-apps list/discover/grant-request query DTOs now live in
    // @synapse/shared/schemas. Path params remain route-local, but app query
    // contracts should not be recreated in controller.ts.
    id: "r32_workspace_apps_app_query_schema_shared_contract",
    appliesTo: isWorkspaceAppsControllerFile,
    test: (src) =>
      /\bconst\s+workspaceAppKindSchema\b/.test(src) ||
      /z\.object\s*\(\s*\{\s*kind\s*:/.test(src) ||
      /z\.object\s*\(\s*\{\s*conversationId\s*:/.test(src) ||
      /z\.object\s*\(\s*\{\s*direction\s*:/.test(src),
  },
  {
    // r33: skills marketplace list/detail query DTOs now live in
    // @synapse/shared/schemas. Keep the controller from silently reintroducing
    // unvalidated query casts for search/tags/workspaceId.
    id: "r33_skills_marketplace_query_schema_shared_contract",
    appliesTo: isSkillsControllerFile,
    test: (src) =>
      /\brequest\.query\s+as\s+\{[\s\S]*?(?:search|tags|workspaceId)/.test(src),
  },
  {
    // r45: installed-skill list filters are app query DTOs shared by API and
    // web-next. Keep route-local mechanics in the controller, but do not let
    // the installed-skill filter contract move back into skills/controller.ts.
    id: "r45_skills_installed_query_schema_shared_contract",
    appliesTo: isSkillsControllerFile,
    test: (src) =>
      /\brequest\.query\s+as\s+\{[\s\S]*?(?:accessTargetType|actorId|remoteAgentId|workspaceMemberId|conversationId|sourceSkillId)/.test(
        src
      ) || /\bconst\s+installedSkillListQuerySchema\b/.test(src),
  },
  {
    // r34: organization actor-package list query DTOs now live in
    // @synapse/shared/schemas. Keep the controller from silently reintroducing
    // an unvalidated search query cast.
    id: "r34_organization_actor_package_query_schema_shared_contract",
    appliesTo: isOrganizationControllerFile,
    test: (src) =>
      /\brequest\.query\s+as\s+\{[\s\S]*?\bsearch\??\s*:/.test(src),
  },
  {
    // r35: mcp-plugins marketplace/installations/audit app query DTOs now live
    // in @synapse/shared/schemas. The OAuth callback remains a wire callback,
    // so this rule targets only the old app-route casts/local schema roots.
    id: "r35_mcp_plugins_app_query_schema_shared_contract",
    appliesTo: isMcpPluginsControllerFile,
    test: (src) =>
      /\brequest\.query\s+as\s+\{[^}]*?(?:search|tags|categories|transport|pluginId|sessionId|actorId|eventType|limit|before)\??\s*:/.test(
        src
      ) || /z\.object\s*\(\s*\{\s*pluginId\s*:/.test(src),
  },
  {
    // r36: devices active-capability list query DTO now lives in
    // @synapse/shared/schemas. Keep access-bindings.ts as route orchestration,
    // not the app query contract root.
    id: "r36_devices_access_bindings_query_schema_shared_contract",
    appliesTo: isDevicesAccessBindingsFile,
    test: (src) => /\bconst\s+listQuerySchema\s*=\s*z\b/.test(src),
  },
  {
    // r37: manual runtime-authorization grant policy is an app request DTO.
    // The shared input schema now validates GrantPolicy shape (including the
    // required capability branch), so the controller should not import or
    // re-run GrantPolicySchema as a local contract root.
    id: "r37_runtime_auth_manual_policy_schema_shared_contract",
    appliesTo: isRuntimeAuthorizationsManualGrantsControllerFile,
    test: (src) =>
      /\bGrantPolicySchema\b/.test(src) || /\bpolicyParse\b/.test(src),
  },
  {
    // r38: device start-pairing is an app-management request DTO. Shared owns
    // mode/title/description/deviceType/context/etc.; the controller only omits
    // URL-carried workspaceId.
    id: "r38_devices_start_pairing_schema_shared_contract",
    appliesTo: isDevicesControllerFile,
    test: (src) =>
      /StartPairingInputSchema\.omit[\s\S]*?\.extend\s*\(/.test(src) ||
      /\bstartPairingBodySchema\b[\s\S]*?\b(?:description|context)\s*:\s*z\./.test(
        src
      ),
  },
  {
    // r39: plugin installation config_data is business JSON owned by the
    // mcp-plugins repo boundary. Consumers should receive typed configData
    // records, not re-parse row.configData ad hoc.
    id: "r39_mcp_plugin_installation_config_json_repo_exit",
    appliesTo: isMcpPluginInstallationConfigConsumerFile,
    test: (src) =>
      /\b(?:asObject|parseJsonObject)\s*\(\s*(?:row|installation|installationRow)\.configData\s*\)/.test(
        src
      ) || /\bconfigData\s*:\s*unknown\b/.test(src),
  },
  {
    // r40: plugin auth spec default_config/auth_bindings are DB JSON fields.
    // The repo normalizes them before auth service orchestration consumes the
    // row, so plugin-auth-connections.ts should not re-parse row.* spec fields.
    id: "r40_mcp_plugin_auth_spec_json_repo_exit",
    appliesTo: isMcpPluginAuthConnectionsFile,
    test: (src) =>
      /\b(?:asObject|parseJsonObject)\s*\(\s*row\.defaultConfig\s*\)/.test(
        src
      ) ||
      /\bArray\.isArray\s*\(\s*row\.authBindings\s*\)/.test(src) ||
      /\brow\.authBindings\s+as\s+PluginAuthBindingDefinition\[\]/.test(src),
  },
  {
    // r41: visible plugin tool_manifest is a DB JSON field. The repo should
    // normalize it into a typed array before tool resolver orchestration.
    id: "r41_mcp_visible_tool_manifest_json_repo_exit",
    appliesTo: isMcpPluginToolResolverFile,
    test: (src) =>
      /\b(?:asArray|JSON\.parse)\s*(?:<[^>]+>)?\s*\(\s*plugin\.toolManifest\s*\)/.test(
        src
      ) || /\bplugin\.toolManifest\s+as\s+/.test(src),
  },
  {
    // r42: audit log list is an app-facing route. Its list query and response
    // DTO live in @synapse/shared/schemas; audit/index.ts should parse and
    // return those contracts rather than recreating local schemas or casts.
    id: "r42_audit_app_schema_shared_contract",
    appliesTo: isAuditIndexFile,
    test: (src) =>
      /\brequest\.query\s+as\s+\{[\s\S]*?(?:action|resourceType|resourceId|page|pageSize)\??\s*:/.test(
        src
      ) ||
      /z\.(?:object|strictObject)\s*\(\s*\{[\s\S]*?(?:action|resourceType|resourceId|page|pageSize|items|total|userName|actorName|createdAt)\s*:/.test(
        src
      ),
  },
  {
    // r43: platform navigation/access are app-facing DTOs shared by API and
    // web-next. Path params remain route-local, but body/response contracts
    // should not be recreated in platform/controller.ts.
    id: "r43_platform_app_schema_shared_contract",
    appliesTo: isPlatformControllerFile,
    test: (src) =>
      /\bconst\s+(?:platformNavigation|platformAccessBinding|platformAccessGrant|grantPlatformAccess)Schema\s*=\s*z\./.test(
        src
      ) ||
      /\brequest\.body\s+as\s+\{[\s\S]*?(?:userId|accessKey)\??\s*:/.test(src),
  },
  {
    // r44: memory app body/query/response schemas live in
    // @synapse/shared/schemas. Path params remain route-local, but query/body
    // app contracts should not be recreated or raw-cast in memory/controller.ts.
    id: "r44_memory_app_schema_shared_contract",
    appliesTo: isMemoryControllerFile,
    test: (src) =>
      /\brequest\.query\s+as\s+\{[\s\S]*?(?:conversationId|actorId|workspaceMemberId|namespaceKey|category|state|status|tags|limit)\??\s*:/.test(
        src
      ) ||
      /\bconst\s+(?:createMemory|updateMemory|memoryList|memoryPermissionContext|memorySearch|memoryRecall|moveMemory|createMemoryAccessGrant)Schema\s*=\s*z\./.test(
        src
      ),
  },
  {
    // r52: workspace-apps create/update request bodies are shared app
    // contracts. Actor docs and custom installed-skill content are structured
    // app DTOs, not arbitrary z.any() passthrough fields.
    id: "r52_workspace_apps_input_schema_depth",
    appliesTo: isWorkspaceAppsSharedSchemaFile,
    test: (src) =>
      /docs:\s*z\.array\(\s*z\.any\(\s*\)\s*\)\.optional\(\)/.test(src) ||
      /description:\s*z\.any\(\s*\)\.optional\(\)/.test(src) ||
      /attachmentFiles:\s*z\.array\(\s*z\.any\(\s*\)\s*\)\.optional\(\)/.test(
        src
      ),
  },
  {
    // r53: model-groups attemptPolicy/features/providerOptions are business
    // JSON fields. The repo normalizes them before resolver/service logic
    // consumes them, so those layers should not parse row/item JSON again.
    id: "r53_model_groups_json_repo_exit",
    appliesTo: (p) =>
      isModelGroupsServiceFile(p) || isModelGroupsResolverFile(p),
    test: (src) =>
      /\bparseJsonObject\b/.test(src) ||
      /\basObject\s*\(\s*(?:row|item|group)\.(?:attemptPolicy|features|providerOptions)\s*\)/.test(
        src
      ),
  },
  {
    // r54: plugin connection public_payload is DB JSON. The repo normalizes
    // the selected active-connection payload before Feishu scope validation.
    id: "r54_mcp_connection_public_payload_json_repo_exit",
    appliesTo: isMcpPluginsServiceFile,
    test: (src) => /\basObject\s*\(\s*publicPayload\s*\)/.test(src),
  },
  {
    // r55: chat item transport context/deliveries are app-facing fields used
    // by web/mobile clients, so keep them structurally validated in shared.
    id: "r55_chat_transport_schema_depth",
    appliesTo: isChatSharedSchemaFile,
    test: (src) =>
      /transport:\s*z\.unknown\(\)\.optional\(\)/.test(src) ||
      /transportDeliveries:\s*z\.array\(\s*z\.unknown\(\)\s*\)\.optional\(\)/.test(
        src
      ),
  },
  {
    // r56: actor-package latestRevision nested fields are app-facing package
    // metadata with shared TS interfaces. Keep owned fields structured; genuinely
    // open author/protocol payloads remain explicit open records.
    id: "r56_organization_actor_package_version_schema_depth",
    appliesTo: isOrganizationSharedSchemaFile,
    test: (src) =>
      /configFields:\s*z\.array\(\s*z\.unknown\(\)\s*\)/.test(src) ||
      /validationRules:\s*z\.array\(\s*z\.unknown\(\)\s*\)/.test(src) ||
      /setupSteps:\s*z\.array\(\s*z\.unknown\(\)\s*\)/.test(src) ||
      /installFlow:\s*z\.unknown\(\)\.optional\(\)/.test(src) ||
      /authBindings:\s*z\.array\(\s*z\.unknown\(\)\s*\)/.test(src) ||
      /assets:\s*z\.array\(\s*z\.unknown\(\)\s*\)\.optional\(\)/.test(src),
  },
  {
    // r57: actor version history is consumed by web history UI. Keep delta/source
    // structurally validated while leaving individual before/after field values
    // opaque.
    id: "r57_organization_actor_version_schema_depth",
    appliesTo: isOrganizationSharedSchemaFile,
    test: (src) =>
      /delta:\s*z\.unknown\(\)\.optional\(\)/.test(src) ||
      /source:\s*z\.unknown\(\)\.optional\(\)/.test(src),
  },
  {
    // r58: remote-agent app views are consumed by web dashboards that branch on
    // runtime state/catalog status and machine trust/lifecycle state. These
    // fields already have shared enum truth sources; keep the app schema from
    // accepting arbitrary strings again.
    id: "r58_remote_agents_runtime_status_schema_depth",
    appliesTo: isRemoteAgentsSharedSchemaFile,
    test: (src) =>
      /state:\s*z\.string\(\)/.test(src) ||
      /trustStatus:\s*z\.string\(\)/.test(src) ||
      /lifecycleState:\s*z\.string\(\)\.optional\(\)/.test(src) ||
      /machineLifecycleState:\s*z\.string\(\)\.optional\(\)/.test(src) ||
      /RemoteAgentRuntimeCatalogEntryViewSchema\s*=\s*z\.object\(\s*\{[\s\S]*?status:\s*z\.string\(\)[\s\S]*?metadata:/.test(
        src
      ),
  },
  {
    // r60: remote-agent binding status is a finite app/DB enum consumed by the
    // machine detail UI. Keep embedded agent bindings and machine-detail binding
    // rows from accepting arbitrary strings again.
    id: "r60_remote_agent_binding_status_schema_depth",
    appliesTo: (p) =>
      isRemoteAgentsSharedSchemaFile(p) || isRemoteAgentsPresenterFile(p),
    test: (src) =>
      /RemoteAgentBindingViewSchema\s*=\s*z\.object\(\s*\{[\s\S]*?status:\s*z\.string\(\)/.test(
        src
      ) ||
      /RemoteAgentMachineBindingViewSchema\s*=\s*z\.object\(\s*\{[\s\S]*?status:\s*z\.string\(\)/.test(
        src
      ) ||
      /bindingStatus\?:\s*string\b/.test(src) ||
      /export type MachineBindingRecord\s*=\s*RuntimeSummaryRow\s*&\s*\{[^}]*status:\s*string\b/.test(
        src
      ),
  },
  {
    // r61: automation executions, webhook endpoints, and event-source access
    // grants are app-facing rows consumed by dashboards and have finite shared
    // status sets. Keep their response schemas from accepting arbitrary strings.
    id: "r61_automation_response_status_schema_depth",
    appliesTo: isAutomationSharedSchemaFile,
    test: (src) =>
      /AutomationExecutionSchema\s*=\s*z\.object\(\s*\{[\s\S]*?status:\s*z\.string\(\)/.test(
        src
      ) ||
      /AutomationWebhookEndpointSchema\s*=\s*z\.object\(\s*\{[\s\S]*?status:\s*z\.string\(\)/.test(
        src
      ) ||
      /AutomationEventSourceAccessGrantSchema\s*=\s*z\.object\(\s*\{[\s\S]*?status:\s*z\.string\(\)/.test(
        src
      ),
  },
  {
    // r62: chat event timeline/context policies are DB-backed app enum fields
    // consumed by chat context/timeline readers. Keep the shared runtime schema
    // and exported TS types aligned with shared const tuples instead of open
    // placeholders or local string unions.
    id: "r62_chat_event_policy_schema_depth",
    appliesTo: (p) => isChatSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /eventTimelinePolicy:\s*z\.(?:unknown|string)\(\)\.optional\(\)/.test(
        src
      ) ||
      /eventContextPolicy:\s*z\.(?:unknown|string)\(\)\.optional\(\)/.test(
        src
      ) ||
      /export type ConversationEventTimelinePolicy\s*=\s*(?:\r?\n\s*)?\|/.test(
        src
      ) ||
      /export type ConversationEventContextPolicy\s*=\s*(?:\r?\n\s*)?\|/.test(
        src
      ),
  },
  {
    // r63: participant sessionStatus is sourced from either sessions.status or
    // remote-agent runtime state. Keep the app schema/type as that finite union
    // instead of accepting arbitrary dashboard status strings.
    id: "r63_chat_participant_session_status_schema_depth",
    appliesTo: (p) => isChatSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /sessionStatus:\s*z\.string\(\)\.optional\(\)/.test(src) ||
      /sessionStatus\?:\s*string\b/.test(src),
  },
  {
    // r64: chat feed item subtype is validated in service today and consumed by
    // web/mobile render/retry/reply paths. Keep shared app schemas and exported
    // TS types on shared const tuples instead of accepting arbitrary strings.
    id: "r64_chat_item_subtype_schema_depth",
    appliesTo: (p) => isChatSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /subtype:\s*z\.string\(\)/.test(src) ||
      /export type ConversationMessageSubtype\s*=\s*(?:\r?\n\s*)?\|/.test(
        src
      ) ||
      /export type ConversationFeedEventType\s*=\s*(?:\r?\n\s*)?\|/.test(src) ||
      /export type ConversationFeedMessageType\s*=\s*ConversationMessageSubtype\s*\|\s*["']summary["']/.test(
        src
      ) ||
      /subtype:\s*string\b/.test(src),
  },
  {
    // r65: automation rule category is stored as a DB enum, exposed as an
    // app-facing shared enum, and embedded in chat automation_notice payloads.
    // Keep runtime schemas on the shared tuple instead of open strings or
    // local duplicated tuples. DB enum parity is compile-time checked by
    // enum-compat.ts, which is intentionally outside guard-layering's scanned
    // file set because it imports generated DB types.
    id: "r65_automation_rule_category_schema_depth",
    appliesTo: (p) =>
      isAutomationSharedSchemaFile(p) || isChatSharedSchemaFile(p),
    test: (src) =>
      /AutomationRuleSchema\s*=\s*z\.object\(\s*\{[\s\S]*?category:\s*z\.string\(\)/.test(
        src
      ) ||
      /category:\s*z\.enum\(\[\s*["']schedule["']\s*,\s*["']event_subscription["']\s*\]\)/.test(
        src
      ),
  },
  {
    // r66: automation integration provider/ingress/target fields are DB-backed
    // app enums already asserted in enum-compat.ts. Keep response schemas from
    // accepting arbitrary integration labels.
    id: "r66_automation_integration_enum_schema_depth",
    appliesTo: isAutomationSharedSchemaFile,
    test: (src) =>
      /const eventSourceIntegrationSchema\s*=\s*z\.object\(\s*\{[\s\S]*?provider:\s*z\.string\(\)/.test(
        src
      ) ||
      /const eventSourceIntegrationSchema\s*=\s*z\.object\(\s*\{[\s\S]*?ingressKind:\s*z\.string\(\)/.test(
        src
      ) ||
      /const eventSourceIntegrationSchema\s*=\s*z\.object\(\s*\{[\s\S]*?targetKind:\s*z\.string\(\)/.test(
        src
      ),
  },
  {
    // r67: automation event-source createdByKind is a DB-backed app enum.
    // Keep the response schema and exported TS alias on the shared tuple.
    id: "r67_automation_creator_kind_schema_depth",
    appliesTo: (p) =>
      isAutomationSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /createdByKind:\s*z\.string\(\)/.test(src) ||
      /export type AutomationCreatorKind\s*=\s*(?:\r?\n\s*)?\|/.test(src) ||
      /export type AutomationCreatorKind\s*=\s*["']workspace_member["']\s*\|\s*["']session["']\s*\|\s*["']system["']/.test(
        src
      ),
  },
  {
    // r68: model-group item/version providerKind is a finite app/provider enum
    // already used by create/update DTOs and web branching. Keep response
    // schemas on PROVIDER_KINDS instead of accepting arbitrary strings.
    id: "r68_model_groups_provider_kind_schema_depth",
    appliesTo: isModelGroupsSharedSchemaFile,
    test: (src) =>
      /ModelGroupItemViewSchema\s*=\s*z\.strictObject\(\s*\{[\s\S]*?providerKind:\s*z\.string\(\)/.test(
        src
      ) ||
      /ModelGroupItemVersionViewSchema\s*=\s*z\.strictObject\(\s*\{[\s\S]*?providerKind:\s*z\.string\(\)/.test(
        src
      ),
  },
  {
    // r69: workspace trustLevel is a finite app enum. Responses add the
    // presenter-derived "owner" level on top of invite/member DB levels, so the
    // shared schema/type must use WORKSPACE_TRUST_LEVELS, not open strings.
    id: "r69_workspace_trust_level_schema_depth",
    appliesTo: (p) =>
      isWorkspaceSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /const TrustLevelFieldSchema\s*=\s*z\.string\(\)\.nullable\(\)/.test(
        src
      ) ||
      /trustLevel:\s*z\.string\(\)/.test(src) ||
      /trustLevel:\s*z\.string\(\)\.nullable\(\)/.test(src) ||
      /export type TrustLevel\s*=\s*["']owner["']\s*\|\s*["']admin["']\s*\|\s*["']member["']\s*\|\s*["']guest["']/.test(
        src
      ),
  },
  {
    // r70: relationship member summaries carry the same workspace trust-level
    // business enum used by workspace views. Keep schema/type aligned with the
    // shared trust-level tuple.
    id: "r70_relationship_member_trust_level_schema_depth",
    appliesTo: (p) =>
      isRelationshipSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /RelationshipMemberSummaryViewSchema\s*=\s*z\.object\(\s*\{[\s\S]*?trustLevel:\s*z\.string\(\)\.optional\(\)/.test(
        src
      ) || /trustLevel\?:\s*string\b/.test(src),
  },
  {
    // r71: actor-package latestRevision.transport mirrors the DB-backed plugin
    // package spec transport enum. It must not accept arbitrary strings or the
    // broader PluginTransport union, which also includes app-only filesystem.
    id: "r71_organization_actor_package_transport_schema_depth",
    appliesTo: (p) =>
      isOrganizationSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /MarketplaceVersionSchema\s*=\s*z\.object\(\s*\{[\s\S]*?transport:\s*z\.string\(\)\.optional\(\)/.test(
        src
      ) ||
      /interface MarketplaceVersion\s*\{[^}]*transport\?:\s*(?:string|PluginTransport)\b/.test(
        src
      ),
  },
  {
    // r72: relationship contact-hub/group summaries surface transportKind to
    // web/mobile UI. Keep it on the shared transport tuple instead of an open
    // label string.
    id: "r72_relationship_conversation_transport_schema_depth",
    appliesTo: (p) =>
      isRelationshipSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /ConversationSummaryViewSchema\s*=\s*z\.object\(\s*\{[\s\S]*?transportKind:\s*z\.string\(\)\.optional\(\)/.test(
        src
      ) ||
      /interface ConversationSummaryView\s*\{[^}]*transportKind\?:\s*string\b/.test(
        src
      ),
  },
  {
    // r73: actor summaries embedded in workspace/relationship app responses are
    // actor-domain records. Keep their role fields aligned with ACTOR_ROLES
    // instead of accepting arbitrary UI/display labels.
    id: "r73_actor_summary_role_schema_depth",
    appliesTo: (p) =>
      isWorkspaceSharedSchemaFile(p) ||
      isRelationshipSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p),
    test: (src) =>
      /WorkspaceChiefActorSummaryViewSchema\s*=\s*z\.object\(\s*\{[^}]*role:\s*z\.string\(\)/.test(
        src
      ) ||
      /RelationshipActorSummaryViewSchema\s*=\s*z\.object\(\s*\{[^}]*role:\s*z\.string\(\)/.test(
        src
      ) ||
      /interface WorkspaceChiefActorSummary\s*\{[^}]*role:\s*string\b/.test(
        src
      ) ||
      /interface RelationshipActorSummaryView\s*\{[^}]*role:\s*string\b/.test(
        src
      ),
  },
  {
    // r74: skills marketplace/install responses expose source/sync/effort
    // fields consumed by web. Keep runtime schemas and exported types on shared
    // tuples, and keep web from redeclaring the source-type union locally.
    id: "r74_skills_enum_schema_depth",
    appliesTo: (p) =>
      isSkillsSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isWebSkillsClientFile(p),
    test: (src) =>
      /effort:\s*z\.enum\(\[\s*["']low["']\s*,\s*["']medium["']\s*,\s*["']high["']\s*,\s*["']max["']\s*\]\)/.test(
        src
      ) ||
      /sourceType:\s*z\.enum\(\[\s*["']github["']\s*,\s*["']clawhub["']\s*\]\)/.test(
        src
      ) ||
      /lastSyncStatus:\s*z\.enum\(\[\s*["']pending["']\s*,\s*["']synced["']\s*,\s*["']error["']\s*\]\)/.test(
        src
      ) ||
      /export type SkillSourceType\s*=\s*["']github["']\s*\|\s*["']clawhub["']/.test(
        src
      ) ||
      /export type SkillMirrorSyncStatus\s*=\s*["']pending["']\s*\|\s*["']synced["']\s*\|\s*["']error["']/.test(
        src
      ) ||
      /export type SkillFrontmatterEffort\s*=\s*["']low["']\s*\|\s*["']medium["']\s*\|\s*["']high["']\s*\|\s*["']max["']/.test(
        src
      ) ||
      /type SkillImportSourceType\s*=\s*["']github["']\s*\|\s*["']clawhub["']/.test(
        src
      ),
  },
  {
    // r75: automation rule trigger/source/schedule, completion, target-policy,
    // rule-status, and event-source status are DB-backed app enums. Keep the
    // exported TS types and app schemas tied to the shared enum tuples.
    id: "r75_automation_rule_enum_type_depth",
    appliesTo: (p) =>
      isAutomationSharedSchemaFile(p) || isSharedTypesIndexFile(p),
    test: (src) =>
      /export type AutomationStatus\s*=\s*["']active["']\s*\|/.test(src) ||
      /export type AutomationTriggerKind\s*=\s*["']schedule["']\s*\|/.test(
        src
      ) ||
      /export type AutomationSourceKind\s*=\s*["']clock["']\s*\|/.test(src) ||
      /export type AutomationEventProviderKind\s*=\s*["']device["']\s*\|/.test(
        src
      ) ||
      /export type AutomationIntegrationProvider\s*=\s*["']github["']\s*\|/.test(
        src
      ) ||
      /export type AutomationIntegrationIngressKind\s*=\s*["']webhook["']\s*\|/.test(
        src
      ) ||
      /export type AutomationIntegrationTargetKind\s*=\s*["']repository["']\s*\|/.test(
        src
      ) ||
      /export type AutomationScheduleKind\s*=\s*["']cron["']\s*\|/.test(src) ||
      /export type AutomationCompletionStatus\s*=\s*["']completed["']\s*\|/.test(
        src
      ) ||
      /export type AutomationTargetPolicy\s*=\s*["']all_members["']\s*\|/.test(
        src
      ) ||
      /export type AutomationEventSourceStatus\s*=\s*["']active["']\s*\|/.test(
        src
      ) ||
      /triggerKind:\s*z\.enum\(\[\s*["']schedule["']\s*,\s*["']event["']\s*\]\)/.test(
        src
      ) ||
      /sourceKind:\s*z\.enum\(\[\s*["']clock["']\s*,\s*["']device["']\s*,\s*["']webhook["']\s*,\s*["']internal["']\s*,\s*["']integration["']\s*\]\)/.test(
        src
      ) ||
      /scheduleKind:\s*z\.enum\(\[\s*["']cron["']\s*,\s*["']at["']\s*,\s*["']interval["']\s*\]\)/.test(
        src
      ) ||
      /completionStatus:\s*z\.enum\(\[\s*["']completed["']\s*,\s*["']archived["']\s*\]\)/.test(
        src
      ) ||
      /targetPolicy:\s*z\.enum\(\[\s*["']all_members["']\s*,\s*["']specified_members["']\s*\]\)/.test(
        src
      ),
  },
  {
    // r76: conversation status is a shared app-view enum used by chat lists,
    // contact hub summaries, API presenters, and web store state. Keep it
    // tuple-derived instead of hand-writing active/completed at each surface.
    id: "r76_conversation_status_schema_depth",
    appliesTo: (p) =>
      isChatSharedSchemaFile(p) ||
      isRelationshipSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isChatPresenterFile(p) ||
      isChatSummaryViewFile(p) ||
      isWebChatStoreFile(p),
    test: (src) =>
      /status:\s*z\.enum\(\[\s*["']active["']\s*,\s*["']completed["']\s*\]\)/.test(
        src
      ) ||
      /status:\s*["']active["']\s*\|\s*["']completed["']/.test(src) ||
      /\?\s*\(?["']active["']\s+as const\)?\s*:\s*\(?["']completed["']\s+as const\)?/.test(
        src
      ) ||
      /\?\s*["']active["']\s*:\s*["']completed["']/.test(src) ||
      /status:\s*["']active["']\s*\|\s*["']completed["']\s*\|\s*["']failed["']/.test(
        src
      ),
  },
  {
    // r77: mcp plugin install/auth flow values are app-facing contract enums.
    // Keep shared schemas/types, API challenge adapters, and the web install
    // dialog tied to the shared tuples instead of scattering raw unions.
    id: "r77_mcp_plugin_auth_flow_enum_depth",
    appliesTo: (p) =>
      isMcpPluginsSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isMcpPluginsPresenterFile(p) ||
      isMcpPluginAuthConnectionsFile(p) ||
      isMcpPluginsFeishuAuthFile(p) ||
      isMcpPluginsMijiaAuthFile(p) ||
      isMcpPluginsMijiaTypesFile(p) ||
      isWebPluginInstallDialogFile(p),
    test: (src) =>
      /const PLUGIN_INSTALL_ACTION_KINDS\s*=\s*\[\s*["']auth_start/.test(src) ||
      /kind:\s*z\.enum\(\[\s*["']redirect["']\s*,\s*["']qr_code["']\s*,\s*["']none["']\s*\]\)/.test(
        src
      ) ||
      /openMode:\s*z\.enum\(\[\s*["']popup["']\s*,\s*["']replace["']\s*\]\)/.test(
        src
      ) ||
      /export type PluginInstallActionKind\s*=\s*["']auth_start["']\s*\|/.test(
        src
      ) ||
      /export type PluginAuthChallengeKind\s*=\s*["']redirect["']\s*\|/.test(
        src
      ) ||
      /openMode\??:\s*["']popup["']\s*\|\s*["']replace["']/.test(src) ||
      /kind\s*!==\s*["']redirect["']\s*&&\s*kind\s*!==\s*["']qr_code["']/.test(
        src
      ) ||
      /challenge\.openMode\s*===\s*["']replace["']\s*\|\|\s*challenge\.openMode\s*===\s*["']popup["']/.test(
        src
      ) ||
      /kind:\s*["']redirect["']/.test(src) ||
      /kind:\s*["']qr_code["']/.test(src) ||
      /openMode:\s*["']popup["']/.test(src) ||
      /challenge\?\.kind\s*===\s*["']qr_code["']/.test(src) ||
      /challenge\?\.kind\s*===\s*["']redirect["']/.test(src) ||
      /challenge\.kind\s*!==\s*["']qr_code["']/.test(src) ||
      /currentStep\.action\.kind\s*===\s*["']auth_start["']/.test(src) ||
      /currentStep\.action\.kind\s*===\s*["']external_link["']/.test(src),
  },
  {
    // r78: platform access binding source is a DB-backed app enum. Keep it
    // tuple-derived in shared and consume constants in API writes/branches and
    // the web access-management UI.
    id: "r78_platform_access_source_schema_depth",
    appliesTo: (p) =>
      isPlatformSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isPlatformRepoFile(p) ||
      isPlatformAdminServiceFile(p) ||
      isPlatformPresenterFile(p) ||
      isWebAccessManagementFile(p),
    test: (src) =>
      /source:\s*z\.enum\(\[\s*["']config["']\s*,\s*["']manual["']\s*\]\)/.test(
        src
      ) ||
      /(?:export\s+)?type PlatformAccessSource\s*=\s*["']config["']\s*\|\s*["']manual["']/.test(
        src
      ) ||
      /source:\s*["']config["']\s*\|\s*["']manual["']/.test(src) ||
      /\?\s*["']config["']\s*:\s*["']manual["']/.test(src) ||
      /source:\s*["']config["'](?:\s+as const)?/.test(src) ||
      /source:\s*["']manual["'](?:\s+as const)?/.test(src) ||
      /source\s*===\s*["']config["']/.test(src) ||
      /\.where\(\s*["']source["']\s*,\s*["']=["']\s*,\s*["']config["']/.test(
        src
      ) ||
      /\.where\(\s*["']source["']\s*,\s*["']=["']\s*,\s*["']manual["']/.test(
        src
      ),
  },
  {
    // r79: organization actor-package and actor-version app enum fields are
    // consumed by API presenters and web history/package views. Keep runtime
    // schemas, exported types, and API branches tied to shared tuples/constants
    // instead of local inline enums or raw value branches.
    id: "r79_organization_actor_package_enum_schema_depth",
    appliesTo: (p) =>
      isOrganizationSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isOrganizationPresenterFile(p) ||
      isOrganizationServiceFile(p) ||
      isOrganizationBuiltinActorPackagesFile(p),
    test: (src) =>
      /const actorPackageKindSchema\s*=\s*z\.enum\(\[\s*["']plugin["']/.test(
        src
      ) ||
      /const actorPackageSourceTypeSchema\s*=\s*z\.enum\(\[\s*["']builtin["']/.test(
        src
      ) ||
      /const marketplaceVersionStatusSchema\s*=\s*z\.enum\(\[\s*["']draft["']/.test(
        src
      ) ||
      /const marketplaceAssetKindSchema\s*=\s*z\.enum\(\[\s*["']skill_markdown["']/.test(
        src
      ) ||
      /const actorPackageDependencyKindSchema\s*=\s*z\.enum\(\[\s*["']required["']/.test(
        src
      ) ||
      /const actorPackageDependencyTargetKindSchema\s*=\s*z\.enum\(\[\s*["']plugin["']/.test(
        src
      ) ||
      /const actorUpdateSourceTypeSchema\s*=\s*z\.enum\(\[\s*["']workspace_member["']/.test(
        src
      ) ||
      /const actorVersionChangedFieldSchema\s*=\s*z\.enum\(\[\s*["']displayName["']/.test(
        src
      ) ||
      /const actorDocChangedFieldSchema\s*=\s*z\.enum\(\[\s*["']title["']/.test(
        src
      ) ||
      /const actorPackageLinkStatusSchema\s*=\s*z\.enum\(\[\s*["']up_to_date["']/.test(
        src
      ) ||
      /changeType:\s*z\.enum\(\[\s*["']added["']/.test(src) ||
      /export type ActorUpdateSourceType\s*=\s*(?:\n\s*\|\s*)?["']workspace_member["']/.test(
        src
      ) ||
      /export type ActorVersionChangedField\s*=\s*(?:\n\s*\|\s*)?["']displayName["']/.test(
        src
      ) ||
      /export type ActorDocChangedField\s*=\s*(?:\n\s*\|\s*)?["']title["']/.test(
        src
      ) ||
      /changeType:\s*["']added["']\s*\|\s*["']updated["']/.test(src) ||
      /export type MarketplaceItemKind\s*=\s*["']plugin["']\s*\|/.test(src) ||
      /export type MarketplaceSourceType\s*=\s*(?:\n\s*\|\s*)?["']builtin["']/.test(
        src
      ) ||
      /export type MarketplaceSyncMode\s*=\s*(?:\n\s*\|\s*)?["']notify["']/.test(
        src
      ) ||
      /export type MarketplaceVersionStatus\s*=\s*(?:\n\s*\|\s*)?["']draft["']/.test(
        src
      ) ||
      /export type MarketplaceAssetKind\s*=\s*(?:\n\s*\|\s*)?["']skill_markdown["']/.test(
        src
      ) ||
      /export type ActorPackageDependencyKind\s*=\s*Extract\b/.test(src) ||
      /export type ActorPackageTargetKind\s*=\s*Extract\b/.test(src) ||
      /export type ActorPackageSyncMode\s*=\s*["']notify["']\s*\|/.test(src) ||
      /export type ActorPackageLinkStatus\s*=\s*(?:\n\s*\|\s*)?["']up_to_date["']/.test(
        src
      ) ||
      /return\s+["'](?:builtin|official|workspace_upload|user_upload)["']/.test(
        src
      ) ||
      /kind:\s*["']actor["']/.test(src) ||
      /status\s*=\s*["'](?:up_to_date|detached|update_available_with_local_changes|diverged|update_available)["']/.test(
        src
      ) ||
      /row\.source_sync_mode\s*\|\|\s*["']notify["']/.test(src) ||
      /row\.source_sync_mode\s*===\s*["']manual_merge["']/.test(src) ||
      /field:\s*["'](?:title|visibility|priority|content)["']/.test(src) ||
      /buildFieldChange\(\s*["'](?:displayName|role|title|parentId|canRepresentUser|specialties|config)["']/.test(
        src
      ) ||
      /\?\s*["']updated["']\s*:\s*afterDoc\s*\?\s*["']added["']\s*:\s*["']removed["']/.test(
        src
      ) ||
      /input\.syncMode\s*\|\|\s*["']notify["']/.test(src) ||
      /requirementKind:\s*["'](?:required|recommended)["']/.test(src) ||
      /targetPackageKind:\s*["'](?:plugin|skill)["']/.test(src),
  },
  {
    // r80: mcp plugin config/auth/install-flow values are app-facing contract
    // enums. Keep schemas/types and API/web branches tied to shared
    // tuples/constants instead of local duplicate unions or raw value branches.
    id: "r80_mcp_plugin_config_auth_enum_schema_depth",
    appliesTo: (p) =>
      isMcpPluginsSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isMcpPluginsRepoFile(p) ||
      isMcpPluginsServiceFile(p) ||
      isMcpPluginsPresenterFile(p) ||
      isMcpPluginAuthConnectionsFile(p) ||
      isMcpPluginsFeishuAuthFile(p) ||
      isMcpPluginsMijiaAuthFile(p) ||
      isMcpPluginsMijiaTypesFile(p) ||
      isWebPluginInstallDialogFile(p),
    test: (src, p) =>
      /const PLUGIN_CONFIG_FIELD_TYPES\s*=\s*\[\s*["']text["']/.test(src) ||
      /const PLUGIN_INSTALL_STEP_KINDS\s*=\s*\[\s*["']form["']/.test(src) ||
      /const PLUGIN_AUTH_BINDING_DRIVER_KINDS\s*=\s*\[\s*["']oauth2_authorization_code_pkce["']/.test(
        src
      ) ||
      /const MARKETPLACE_REQUIREMENT_KINDS\s*=\s*\[\s*["']required["']/.test(
        src
      ) ||
      /const MARKETPLACE_REQUIREMENT_STATUSES\s*=\s*\[\s*["']satisfied["']/.test(
        src
      ) ||
      /z\.enum\(\[\s*["']workspace["']\s*,\s*["']plugin["']\s*\]\)/.test(src) ||
      /z\.enum\(\[\s*["']config["']\s*,\s*["']env["']\s*,\s*["']literal["']\s*,\s*["']derived["']\s*\]\)/.test(
        src
      ) ||
      /z\.enum\(\[\s*["']app_base_url["']\s*,\s*["']oauth_callback_url["']\s*\]\)/.test(
        src
      ) ||
      /z\.enum\(\[\s*["']required["']\s*,\s*["']pattern["']\s*,\s*["']url["']\s*,\s*["']min_length["']\s*,\s*["']max_length["']\s*,\s*["']prefix["']\s*,\s*["']enum["']\s*\]\)/.test(
        src
      ) ||
      /z\.enum\(\[\s*["']active["']\s*,\s*["']disabled["']\s*,\s*["']error["']\s*,\s*["']archived["']\s*\]\)/.test(
        src
      ) ||
      /z\.enum\(\[\s*["']notify["']\s*,\s*["']manual_merge["']\s*,\s*["']follow_upstream["']\s*,\s*["']detached["']\s*\]\)/.test(
        src
      ) ||
      /z\.enum\(\[\s*["']oauth2_authorization_code_pkce["']\s*,\s*["']mijia_qr_login["']\s*,\s*["']feishu_cli_setup["']\s*\]\)/.test(
        src
      ) ||
      /z\.enum\(\[\s*["']awaiting_start["'][\s\S]*["']finalizing["']\s*\]\)/.test(
        src
      ) ||
      /export type (?:PluginConfigFieldType|PluginInstallStepKind|PluginAuthBindingDriverKind|PluginAuthSessionPhase|MarketplaceRequirementKind|MarketplaceRequirementStatus|MarketplaceLineageKind|MarketplaceRequirementTargetKind|PluginInstallationMode)\s*=\s*(?:\n\s*\|\s*)?["']/.test(
        src
      ) ||
      (!isSharedTypesIndexFile(p) &&
        (/\b(?:field\.type|currentStep\?\.kind|currentStep\.kind|step\.kind|binding\?\.driver|binding\.driver|row\.driver|session\.driver|source\.source|source\.name|rule\.rule|row\.rootStatus|category\.targetKind|entry\.status|binding\.status|accessRow\.status|authState\.phase|authState\.status|currentAuthStepState\?\.status|state\.status|session\.status)\s*(?:===|!==)\s*["'](?:text|textarea|number|boolean|select|multiselect|secret|auth_connection|file|form|auth|check|confirm|reuse_scope|integration_events|config|env|literal|derived|app_base_url|oauth_callback_url|oauth2_authorization_code_pkce|mijia_qr_login|feishu_cli_setup|required|pattern|url|min_length|max_length|prefix|enum|active|disabled|error|archived|revoked|pending|completed|failed|expired|consumed|awaiting_callback|pending_scan|pending_confirm|plugin)["']/.test(
          src
        ) ||
          /case\s+["'](?:oauth2_authorization_code_pkce|mijia_qr_login|feishu_cli_setup|config|env|literal|derived|required|pattern|url|min_length|max_length|prefix|enum|pending|completed|failed|expired)["']/.test(
            src
          ) ||
          /\b(?:status|phase|driver|type|kind|scope|source|name|rule|sourceSyncMode|requirementKind)\s*:\s*["'](?:text|textarea|number|boolean|select|multiselect|secret|auth_connection|file|form|auth|check|confirm|reuse_scope|integration_events|plugin|config|env|literal|derived|app_base_url|oauth_callback_url|oauth2_authorization_code_pkce|mijia_qr_login|feishu_cli_setup|required|pattern|url|min_length|max_length|prefix|enum|active|disabled|error|archived|revoked|pending|completed|failed|expired|consumed|awaiting_callback|pending_scan|pending_confirm|notify|manual_merge|follow_upstream|detached)["']/.test(
            src
          ) ||
          /\[\s*["']completed["']\s*,\s*["']failed["']\s*,\s*["']expired["']\s*,\s*["']consumed["']\s*\]/.test(
            src
          ) ||
          /input\.syncMode:\s*["']notify["']/.test(src))),
  },
  {
    // r82: model binding API style and provider-side server tools are
    // app-facing feature values. Keep shared schemas/types, API runtime
    // branches, and web settings forms tied to shared constants instead of
    // local duplicate unions, inline enum tuples, or raw value comparisons.
    id: "r82_model_group_api_style_server_tools_schema_depth",
    appliesTo: (p) =>
      isModelGroupsSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isModelGroupsResolverFile(p) ||
      isAiIndexFile(p) ||
      isAiProviderRegistryFile(p) ||
      isAiProviderBuildToolsFile(p) ||
      isAiProviderFromGenerateTextFile(p) ||
      isAiProviderGetLanguageModelFile(p) ||
      isWebModelGroupBrowserFile(p) ||
      isWebModelItemDialogFile(p) ||
      isWebModelSettingsWorkbenchFile(p),
    test: (src, p) =>
      /z\.enum\(\[\s*["']chat["']\s*,\s*["']responses["']\s*\]\)/.test(src) ||
      /z\.enum\(\[\s*["']web_search["']\s*,\s*["']web_fetch["']\s*\]\)/.test(
        src
      ) ||
      /export type AnthropicBuiltinTool\s*=\s*(?:\n\s*\|\s*)?["']web_search["']/.test(
        src
      ) ||
      /export type ApiStyle\s*=\s*["']chat["']\s*\|\s*["']responses["']/.test(
        src
      ) ||
      /apiStyle\??:\s*["']chat["']\s*\|\s*["']responses["']/.test(src) ||
      /useState<["']chat["']\s*\|\s*["']responses["']>/.test(src) ||
      /type ServerTool\s*=\s*["']web_search["']\s*\|\s*["']web_fetch["']/.test(
        src
      ) ||
      (!isModelGroupsSharedSchemaFile(p) &&
        !isSharedTypesIndexFile(p) &&
        (/\b(?:apiStyleRaw|features\.apiStyle|style|event\.target\.value|e\.target\.value)\s*(?:===|!==)\s*["'](?:chat|responses)["']/.test(
          src
        ) ||
          /\b(?:name|sc\.type|call\.type|toolName|t|tool|value)\s*(?:===|!==)\s*["'](?:web_search|web_fetch)["']/.test(
            src
          ) ||
          /\b(?:apiStyle|defaultApiStyle|type|key)\s*:\s*["'](?:chat|responses|web_search|web_fetch)["']/.test(
            src
          ) ||
          /\[\s*["']web_search["']\s*,\s*["']web_fetch["']\s*\]/.test(src))),
  },
  {
    // r83: device pairing ticket and active-capability access target app
    // schemas are shared contracts consumed by API, web, and device-sdk.
    // Keep their finite values tied to shared/device-protocol tuples instead
    // of inline enum arrays or raw local z.literal discriminants.
    id: "r83_devices_pairing_access_target_schema_depth",
    appliesTo: isDevicesSharedSchemaFile,
    test: (src) =>
      /mode:\s*z\.enum\(\[\s*["']local_qr["'][\s\S]*["']service_join["']\s*\]\)/.test(
        src
      ) ||
      /status:\s*z\.enum\(\[\s*["']pending["'][\s\S]*["']rejected["']\s*\]\)/.test(
        src
      ) ||
      /subjectKind:\s*z\.enum\(\[\s*["']workspace["'][\s\S]*["']remote_agent["']\s*\]\)/.test(
        src
      ) ||
      /scopeKind:\s*z\.enum\(\[\s*["']conversation["']\s*\]\)/.test(src) ||
      /kind:\s*z\.literal\(\s*["'](?:workspace|actor|remote_agent|conversation)["']\s*\)/.test(
        src
      ),
  },
  {
    // r84: automation event-source access grants are app-management DTOs.
    // Keep the target type set in a shared automation-specific tuple and keep
    // API mapper branches on shared constants, not raw local strings.
    id: "r84_automation_access_target_type_schema_depth",
    appliesTo: (p) =>
      isAutomationSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isAutomationControllerFile(p),
    test: (src, p) =>
      /type:\s*z\.enum\(\[\s*["']workspace["'][\s\S]*["']actor["']\s*\]\)/.test(
        src
      ) ||
      /export type AutomationAccessTargetType\s*=\s*(?:\n\s*\|\s*)?["']workspace["']/.test(
        src
      ) ||
      (isAutomationControllerFile(p) &&
        /case\s+["'](?:workspace|workspace_member|conversation|actor)["']/.test(
          src
        )),
  },
  {
    // r85: realtime ASR start audio config is app input. Keep format/codec
    // runtime validation in shared and derive exported types from shared
    // tuples; API service only imports and parses the shared schema.
    id: "r85_asr_audio_config_schema_depth",
    appliesTo: (p) =>
      isAsrSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isAsrServiceFile(p),
    test: (src, p) =>
      (isAsrServiceFile(p) &&
        /z\.enum\(\[\s*["']pcm["']\s*,\s*["']ogg["']\s*\]\)|z\.enum\(\[\s*["']raw["']\s*,\s*["']opus["']\s*\]\)/.test(
          src
        )) ||
      /export type RealtimeAsrAudioFormat\s*=\s*["']pcm["']/.test(src) ||
      /export type RealtimeAsrAudioCodec\s*=\s*["']raw["']/.test(src) ||
      (isAsrSharedSchemaFile(p) &&
        /format:\s*z\.enum\(\[\s*["']pcm["']\s*,\s*["']ogg["']\s*\]\)|codec:\s*z\.enum\(\[\s*["']raw["']\s*,\s*["']opus["']\s*\]\)/.test(
          src
        )),
  },
  {
    // r86: chat transport context/delivery direction is an app-facing hydrated
    // view field. Keep schemas/types and API metadata mapping tied to shared
    // constants instead of hand-written inbound/outbound unions.
    id: "r86_chat_transport_direction_schema_depth",
    appliesTo: (p) =>
      isChatSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isChatServiceFile(p) ||
      isChatRepoFile(p),
    test: (src) =>
      /direction:\s*z\.enum\(\[\s*["']inbound["']\s*,\s*["']outbound["']\s*\]\)/.test(
        src
      ) ||
      /direction:\s*["']inbound["']\s*\|\s*["']outbound["']/.test(src) ||
      /value\.direction\s*===\s*["']inbound["'][\s\S]*value\.direction\s*===\s*["']outbound["']/.test(
        src
      ),
  },
  {
    // r87: chat automation notices reuse automation's app-facing source-kind
    // tuple. Keep the chat event payload schema from drifting into a duplicated
    // sourceKind enum.
    id: "r87_chat_automation_notice_source_kind_schema_depth",
    appliesTo: (p) => isChatSharedSchemaFile(p),
    test: (src) =>
      /sourceKind:\s*z\.enum\(\[\s*["']clock["']\s*,\s*["']device["']\s*,\s*["']webhook["']\s*,\s*["']internal["']\s*,\s*["']integration["']\s*\]\)/.test(
        src
      ),
  },
  {
    // r88: participant removal responses are an app-facing subset of
    // conversation participant states. Keep the schema/type/service return tied
    // to the dedicated shared left/removed tuple so it cannot accidentally
    // accept active.
    id: "r88_chat_participant_removal_state_schema_depth",
    appliesTo: (p) =>
      isChatSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isChatServiceFile(p),
    test: (src) =>
      /state:\s*z\.enum\(\[\s*["']left["']\s*,\s*["']removed["']\s*\]\)/.test(
        src
      ) ||
      /export type ChatParticipantRemovalState\s*=\s*["']left["']/.test(src) ||
      /state:\s*["']removed["']\s*\|\s*["']left["']/.test(src) ||
      /isSelfRemoval\s*\?\s*["']left["']\s*:\s*["']removed["']/.test(src),
  },
  {
    // r89: actor runtime health is an app-facing runtime status consumed by
    // web/mobile and IM integrations. Keep schema/type/producers/consumers tied
    // to the shared OK/ERROR tuple instead of duplicating ok/error strings.
    id: "r89_actor_runtime_health_schema_depth",
    appliesTo: (p) =>
      isChatSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isSharedUtilsIndexFile(p) ||
      isChatPresenterFile(p) ||
      isExecutionServiceFile(p) ||
      isSessionRuntimeFile(p) ||
      isImStatusResolverFile(p) ||
      isWebChatStoreFile(p) ||
      isWebChatRuntimeUiFile(p) ||
      isMobileActorActivityBubbleFile(p),
    test: (src) =>
      /health:\s*z\.enum\(\[\s*["']ok["']\s*,\s*["']error["']\s*\]\)/.test(
        src
      ) ||
      /export type ActorRuntimeHealth\s*=\s*["']ok["']\s*\|/.test(src) ||
      /health:\s*["']ok["']/.test(src) ||
      /health:\s*["']error["']/.test(src) ||
      /(?:runtime\.)?health\s*===\s*["']error["']/.test(src),
  },
  {
    // r90: membership updates are app sync-event payloads. Keep reason and
    // selfState tied to shared tuples/constants instead of local unions or
    // string literals in the API producer.
    id: "r90_chat_membership_update_reason_schema_depth",
    appliesTo: (p) =>
      isChatSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isChatServiceFile(p),
    test: (src) =>
      /reason:\s*z\.enum\(\[\s*["']kicked["']\s*,\s*["']left["']\s*,\s*["']added["']\s*\]\)/.test(
        src
      ) ||
      /reason\?:\s*["']kicked["']\s*\|\s*["']left["']\s*\|\s*["']added["']/.test(
        src
      ) ||
      /selfState:\s*["']active["']\s*\|\s*["']removed["']\s*\|\s*["']left["']/.test(
        src
      ) ||
      /reason:\s*["']added["']/.test(src) ||
      /isSelfRemoval\s*\?\s*["']left["']\s*:\s*["']kicked["']/.test(src) ||
      /selfState:\s*["']active["']/.test(src),
  },
  {
    // r91: feed/sync event payloads are DB JSONB records. The repo decodes
    // them to object records on read; service should only type-narrow and
    // enrich those records.
    id: "r91_chat_event_payload_json_repo_exit",
    appliesTo: (p) => isChatServiceFile(p),
    test: (src) =>
      /function\s+asJsonRecord\b/.test(src) ||
      /JSON\.parse\(value\)/.test(src) ||
      /asJsonRecord\(payload\)/.test(src),
  },
  {
    // r92: mobile/web clients consume auth/workspace app DTOs through shared
    // app-contract types. Keep the cleaned files from reintroducing local
    // field-interface duplicates that can drift from AuthMeViewSchema or
    // WorkspaceListItemViewSchema.
    id: "r92_client_workspace_auth_contract_shared",
    appliesTo: isClientWorkspaceAuthContractFile,
    test: (src) =>
      /\b(?:export\s+)?interface\s+AuthMeResponse\b/.test(src) ||
      /import\s+type\s*\{[\s\S]*\bAuthMeResponse\b[\s\S]*\}\s+from\s+["']@\/types\/api["']/.test(
        src
      ) ||
      /\b(?:export\s+)?interface\s+WorkspaceInfo\b/.test(src) ||
      /\btype\s+WorkspaceInfo\s*=\s*\{/.test(src) ||
      /\bexport\s+interface\s+WorkspaceListResponse\b/.test(src) ||
      /\bWorkspaceListResponse\s*=\s*\{\s*data:\s*Array<\s*\{/.test(src) ||
      /\bexport\s+interface\s+WorkspaceMemberView\b/.test(src),
  },
  {
    // r93: the workspace repo returns the created secretary actor with config
    // already decoded from JSONB. The presenter should only shape the app view,
    // not parse DB JSON strings.
    id: "r93_workspace_actor_config_json_repo_exit",
    appliesTo: isWorkspacePresenterFile,
    test: (src) =>
      /JSON\.parse\(\s*row\.config\s*\)/.test(src) ||
      /typeof\s+row\.config\s*===\s*["']string["']/.test(src),
  },
  {
    // r94: tool-call-task repo helpers return task/output records with JSONB
    // payloads and metadata already decoded. The presenter should only shape
    // app-facing records and serialize Date fields.
    id: "r94_tool_call_task_json_repo_exit",
    appliesTo: isToolCallTasksPresenterFile,
    test: (src) => /\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r95: runtime-authorization repo helpers return grant candidates with
    // sourceRequestArgs already decoded. The presenter should only shape the
    // app-facing grant record and serialize Date fields.
    id: "r95_runtime_auth_source_request_args_json_repo_exit",
    appliesTo: isRuntimeAuthorizationsPresenterFile,
    test: (src) =>
      /\bparseJsonObject\b/.test(src) ||
      /JSON\.parse\(/.test(src) ||
      /sourceRequestArgs:\s*parseJsonObject/.test(src),
  },
  {
    // r96: skills repo helpers return snapshot/mirror/item/version records with
    // selected JSONB fields already decoded. Service/presenter consumers should
    // only read those records and shape app-facing DTOs.
    id: "r96_skills_json_records_repo_exit",
    appliesTo: (p) => isSkillsServiceFile(p) || isSkillsPresenterFile(p),
    test: (src, p) =>
      (isSkillsPresenterFile(p) &&
        (/\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src))) ||
      (isSkillsServiceFile(p) &&
        /\bdecode(?:InstalledSkillVersionMetadata|SkillMirrorLocator|SkillPackageItemMetadata|SkillSnapshotHooks)\b/.test(
          src
        )),
  },
  {
    // r97: memory repo helpers return memory item records with metadata already
    // decoded. The presenter should only shape the app-facing memory DTO.
    id: "r97_memory_metadata_json_repo_exit",
    appliesTo: isMemoryPresenterFile,
    test: (src) =>
      /\bparseJsonObject\b/.test(src) ||
      /JSON\.parse\(/.test(src) ||
      /metadata:\s*parseJsonObject\(\s*row\.metadata\s*\)/.test(src),
  },
  {
    // r98: organization repo helpers return actor/version/package records with
    // selected JSONB fields already decoded. The presenter should only shape
    // app-facing DTOs and serialize Date fields.
    id: "r98_organization_json_records_repo_exit",
    appliesTo: isOrganizationPresenterFile,
    test: (src) =>
      /\bparseJsonObject\b/.test(src) ||
      /JSON\.parse\(/.test(src) ||
      /typeof\s+row\.(?:config|version_delta)\s*===\s*["']string["']/.test(src),
  },
  {
    // r99: tasks repo helpers return RawTaskRow summary records with selected
    // JSONB fields already decoded. The presenter should only shape app-facing
    // task DTOs and serialize Date fields.
    id: "r99_tasks_summary_json_repo_exit",
    appliesTo: isTasksPresenterFile,
    test: (src) => /\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r100: context repo helpers return archive-point records with metadata
    // already decoded. The presenter should only shape the canonical archive
    // point and serialize Date fields.
    id: "r100_context_archive_point_json_repo_exit",
    appliesTo: isContextPresenterFile,
    test: (src) => /\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r101: model-groups repo helpers return group/item/version records with
    // selected JSONB fields already decoded. The presenter should only shape
    // app DTOs and serialize Date fields.
    id: "r101_model_groups_presenter_json_repo_exit",
    appliesTo: isModelGroupsPresenterFile,
    test: (src) =>
      /\basObject\b/.test(src) ||
      /\bparseJsonObject\b/.test(src) ||
      /JSON\.parse\(/.test(src),
  },
  {
    // r102: automation repo helpers return selected app presenter rows with
    // JSONB fields already decoded. The presenter should only shape app DTOs,
    // run canonical content-block presentation, and serialize Date fields.
    id: "r102_automation_presenter_json_repo_exit",
    appliesTo: isAutomationPresenterFile,
    test: (src) => /\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r103: session repo helpers return session/message rows with
    // collaborationState and message metadata already decoded. The presenter
    // should only shape app DTOs, run content-block presentation, and serialize
    // Date fields.
    id: "r103_session_presenter_json_repo_exit",
    appliesTo: isSessionPresenterFile,
    test: (src) =>
      /\bparseJsonObject\b/.test(src) ||
      /\bparseSessionCollaborationState\b/.test(src) ||
      /JSON\.parse\(/.test(src),
  },
  {
    // r104: files repo helpers return file asset and file parse output rows
    // with origin details / structuredJson already decoded. The presenter
    // should only shape app DTOs and serialize Date fields.
    id: "r104_files_presenter_json_repo_exit",
    appliesTo: isFilesPresenterFile,
    test: (src) => /\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r105: mcp-plugins repo helpers return catalog/auth/public JSON records
    // already decoded. The presenter may still pick nested object fields, but
    // it must not parse JSON strings itself.
    id: "r105_mcp_plugins_presenter_json_repo_exit",
    appliesTo: isMcpPluginsPresenterFile,
    test: (src) => /\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r106: mcp-plugins service receives decoded configData and catalog
    // supportedReuseScopes from repo/presenter records. It may inspect object
    // and array values, but must not reintroduce JSON string parsing.
    id: "r106_mcp_plugins_service_no_json_string_parse",
    appliesTo: isMcpPluginsServiceFile,
    test: (src) => /\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r107: tasks repo helpers return decoded task command payloads,
    // session-plan collaboration state, grant options, and presets. The
    // service may validate object/array shape but must not parse JSON strings.
    id: "r107_tasks_service_no_json_string_parse",
    appliesTo: isTasksServiceFile,
    test: (src) => /\bparseJsonObject\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r116: task runtime-authorization grant_options / available_presets are
    // decoded by normalizeTaskRow() in tasks/repo.ts. Approval logic may read
    // the arrays but must not reintroduce a service-local JSON/array parser.
    id: "r116_tasks_runtime_auth_arrays_repo_exit",
    appliesTo: isTasksServiceFile,
    test: (src) =>
      /\bparseJsonArray\b/.test(src) ||
      /JSON\.parse\(\s*locked\.(?:grant_options|available_presets)\s*\)/.test(
        src
      ),
  },
  {
    // r108: audit details is app-facing JSON object data. Keep the shared
    // response schema explicit so callers don't receive arbitrary opaque
    // values through AuditLogView.details.
    id: "r108_audit_details_schema_depth",
    appliesTo: isAuditSharedSchemaFile,
    test: (src) => /details:\s*z\.unknown\(\)/.test(src),
  },
  {
    // r109: organization service consumes decoded actor docs / metadata from
    // repo and app DTO inputs. Presenter/doc codec owns doc-array presentation
    // shaping; service must not reintroduce JSON string fallback parsing.
    id: "r109_organization_service_no_json_string_parse",
    appliesTo: isOrganizationServiceFile,
    test: (src) => /\bparseJsonArray\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r110: skills service consumes decoded skill snapshot/file content-block
    // arrays from repo/app DTO inputs. The content-block codec owns
    // presentation shaping; service must not reintroduce JSON string fallback.
    id: "r110_skills_service_no_json_string_parse",
    appliesTo: isSkillsServiceFile,
    test: (src) => /\bparseJsonArray\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r111: prompt building is presentation logic. Actor docs and specialties
    // should arrive as decoded arrays from repo/app DTO paths; this layer must
    // not revive legacy JSON string fallback parsing.
    id: "r111_ai_prompt_builder_no_actor_doc_json_string_parse",
    appliesTo: isAiPromptBuilderFile,
    test: (src) => /\bparseJsonArray\b/.test(src) || /JSON\.parse\(/.test(src),
  },
  {
    // r112: inviteable actor docs are projected as JSONB arrays by this repo.
    // Keep the repo normalizer array-only so prompt/session tooling does not
    // rely on legacy JSON string fallback for actor docs.
    id: "r112_ai_repo_inviteable_actor_docs_no_json_string_parse",
    appliesTo: isAiRepoFile,
    test: (src) =>
      /JSON\.parse\(\s*value\s*\)/.test(src) ||
      /typeof\s+value\s*===\s*["']string["']/.test(src),
  },
  {
    // r113: execution-table tool_results.metadata is a DB JSONB field. The
    // cleaned path decodes it in ai/repo.ts before context-builder assembles
    // CanonicalToolResult; session-message metadata fallback remains out of
    // scope for this narrow repo-exit ratchet.
    id: "r113_ai_execution_tool_result_metadata_repo_exit",
    appliesTo: isAiContextBuilderFile,
    test: (src) => /\bparseMetadata\s*\(\s*resultRow\.metadata\s*\)/.test(src),
  },
  {
    // r114: session_wakeups.metadata is a DB JSONB field used by runtime
    // presentation to derive wakeup activation/delivery labels. The repo
    // decodes it before runtime consumes SessionWakeupRow.
    id: "r114_session_wakeup_metadata_repo_exit",
    appliesTo: isSessionRuntimeFile,
    test: (src) =>
      /\bparseMetadata\s*\(\s*row\.metadata\s*\)/.test(src) ||
      /\bfunction\s+parseMetadata\s*\(/.test(src),
  },
  {
    // r115: the turn-activity runtime presentation reads selected JSONB fields
    // through session/repo.ts: tool_calls.normalized_input/source_snapshot,
    // tool_results.metadata, and tool_call_tasks final payloads. Keep runtime
    // from reintroducing field-local JSON parsing on those repo-returned rows.
    id: "r115_session_runtime_tool_activity_json_repo_exit",
    appliesTo: isSessionRuntimeFile,
    test: (src) =>
      /\bparseJsonValue\s*\(\s*toolCall\.normalizedInput\s*\)/.test(src) ||
      /\bparseJsonValue\s*\(\s*metadata\s*\)/.test(src) ||
      /\bparseJsonValue\s*\(\s*(?:params\.task|task)\?\.(?:finalResultPayload|finalErrorPayload)\s*\)/.test(
        src
      ),
  },
  {
    // r81: Weixin QR and DingTalk device-flow session statuses are app-facing
    // IM DTO enums. Keep shared schemas/types and API/web consumers tied to
    // shared tuples/constants; provider raw statuses (e.g. Weixin `scaned`,
    // DingTalk uppercase poll states) remain local provider contracts.
    id: "r81_im_qr_device_flow_status_schema_depth",
    appliesTo: (p) =>
      isImSharedSchemaFile(p) ||
      isSharedTypesIndexFile(p) ||
      isImWeixinQrLoginFile(p) ||
      isImDingtalkControllerFile(p) ||
      isImDingtalkDeviceRegistrationFile(p) ||
      isImDingtalkRegistrationSessionStoreFile(p) ||
      isWebImDashboardFile(p) ||
      isWebSidebarWeixinBindingFile(p),
    test: (src, p) =>
      /status:\s*z\.enum\(\[\s*["']waiting["']\s*,\s*["']scanned["']/.test(
        src
      ) ||
      /status:\s*z\.enum\(\[\s*["']waiting["']\s*,\s*["']success["']/.test(
        src
      ) ||
      /export type WeixinQrLoginStatus\s*=\s*(?:\n\s*\|\s*)?["']waiting["']/.test(
        src
      ) ||
      /export type DingtalkDeviceFlowStatus\s*=\s*(?:\n\s*\|\s*)?["']waiting["']/.test(
        src
      ) ||
      /export type RegistrationSessionStatus\s*=\s*(?:\n\s*\|\s*)?["']waiting["']/.test(
        src
      ) ||
      /status\??:\s*["']waiting["']\s*\|\s*["']success["']/.test(src) ||
      (!isSharedTypesIndexFile(p) &&
        !isImSharedSchemaFile(p) &&
        (/\[\s*["']waiting["']\s*,\s*["']scanned["']\s*\]\.includes/.test(
          src
        ) ||
          /\[\s*["']expired["']\s*,\s*["']error["']\s*\]\.includes/.test(src) ||
          /\[\s*["']fail["']\s*,\s*["']expired["']\s*\]\.includes/.test(src) ||
          /\b(?:session|existing|nextSession|weixinSession|dingtalkSession|result\?\.session|pollResult)\??\.status\s*(?:===|!==)\s*["'](?:waiting|scanned|confirmed|expired|error|success|fail)["']/.test(
            src
          ) ||
          /\b(?:status|nextStatus):\s*["'](?:waiting|scanned|confirmed|expired|error|success|fail)["']/.test(
            src
          ) ||
          (isImWeixinQrLoginFile(p) &&
            /return\s+["'](?:waiting|scanned|confirmed|expired|error)["']/.test(
              src
            )) ||
          ((isImDingtalkControllerFile(p) ||
            isImDingtalkDeviceRegistrationFile(p)) &&
            /case\s+["'](?:waiting|success|fail|expired)["']/.test(src)))),
  },
  {
    // r59: relationship request-list views are consumed by web/mobile contact
    // flows and already have a shared RelationshipRequestStatus truth source.
    // Keep both the runtime schema and presenter record types from accepting
    // arbitrary status strings again.
    id: "r59_relationship_request_status_schema_depth",
    appliesTo: (p) =>
      isRelationshipSharedSchemaFile(p) || isRelationshipPresenterFile(p),
    test: (src) =>
      /(?:FriendRequestViewSchema|ActorAccessRequestViewSchema|RemoteAgentAccessRequestViewSchema)\s*=\s*z\.object\(\s*\{[^}]*status:\s*z\.string\(\)/.test(
        src
      ) ||
      /export type (?:FriendRequestRecord|ActorAccessRequestRecord|RemoteAgentAccessRequestRecord) = \{[^}]*status:\s*string\b/.test(
        src
      ),
  },
]

const files = [
  ...walk(MODULES),
  WORKSPACE_SHARED_SCHEMA,
  WORKSPACE_APPS_SHARED_SCHEMA,
  AUTOMATION_SHARED_SCHEMA,
  CHAT_SHARED_SCHEMA,
  IM_SHARED_SCHEMA,
  SHARED_TYPES_INDEX,
  SHARED_UTILS_INDEX,
  ORGANIZATION_SHARED_SCHEMA,
  REMOTE_AGENTS_SHARED_SCHEMA,
  RELATIONSHIP_SHARED_SCHEMA,
  MODEL_GROUPS_SHARED_SCHEMA,
  SKILLS_SHARED_SCHEMA,
  PLATFORM_SHARED_SCHEMA,
  MCP_PLUGINS_SHARED_SCHEMA,
  DEVICES_SHARED_SCHEMA,
  WEB_SKILLS_CLIENT,
  WEB_CHAT_STORE,
  WEB_CHAT_RUNTIME_UI,
  WEB_PLUGIN_INSTALL_DIALOG,
  WEB_PLUGIN_INSTALLATION_WORKBENCH,
  WEB_PLUGIN_INSTALLATION_DETAIL_PAGE,
  WEB_PLUGIN_INSTALL_PAGE,
  WEB_ACCESS_MANAGEMENT,
  WEB_IM_DASHBOARD,
  WEB_SIDEBAR_WEIXIN_BINDING,
  WEB_MODEL_GROUP_BROWSER,
  WEB_MODEL_ITEM_DIALOG,
  WEB_MODEL_SETTINGS_WORKBENCH,
  WEB_API_CLIENT,
  WEB_POST_LOGIN,
  WEB_INTEGRATION_EVENT_SOURCES,
  WEB_WORKSPACE_PROVIDER,
  MOBILE_ACTOR_ACTIVITY_BUBBLE,
  MOBILE_API_TYPES,
  MOBILE_API_CLIENT,
  MOBILE_SESSION_PROVIDER,
  MOBILE_WORKSPACE_PROVIDER,
]

// Strip line + block comments so a rule's keyword inside a doc-comment (e.g.
// "never uses TableRow<...>") is not a false positive. String literals are left
// intact — the rules target code constructs, not arbitrary strings.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

const current = {}
for (const r of RULES) current[r.id] = []
for (const p of files) {
  const src = stripComments(readFileSync(p, "utf8"))
  const rel = relative(REPO_ROOT, p)
  for (const r of RULES) {
    if (r.appliesTo(p) && r.test(src, p)) current[r.id].push(rel)
  }
}
for (const r of RULES) current[r.id].sort()

if (WRITE) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n")
  const total = Object.values(current).reduce((a, b) => a + b.length, 0)
  console.log(`guard-layering: wrote baseline (${total} grandfathered entries)`)
  process.exit(0)
}

let baseline = {}
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"))
} catch {
  console.error(
    "guard-layering: missing baseline; run `node scripts/guard-layering.mjs --write`"
  )
  process.exit(1)
}

let failed = false
for (const r of RULES) {
  const allow = new Set(baseline[r.id] ?? [])
  const cur = new Set(current[r.id] ?? [])
  const added = [...cur].filter((f) => !allow.has(f))
  const removed = [...allow].filter((f) => !cur.has(f))
  if (added.length) {
    failed = true
    console.error(`\n✗ [${r.id}] NEW violations (not in baseline):`)
    for (const f of added) console.error(`    ${f}`)
  }
  if (removed.length) {
    failed = true
    console.error(
      `\n✗ [${r.id}] baseline is STALE — these files no longer violate; remove them from the baseline:`
    )
    for (const f of removed) console.error(`    ${f}`)
  }
}

if (failed) {
  console.error(
    "\nguard-layering FAILED. Fix the new violation, or (if a file was cleaned) run --write to shrink the baseline."
  )
  process.exit(1)
}
console.log("guard-layering: clean (no new layering violations)")
