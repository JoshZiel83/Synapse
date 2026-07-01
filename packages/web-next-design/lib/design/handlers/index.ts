import type { DesignHandlers } from "./_types"
import { actorsHandlers } from "./actors"
import { authHandlers } from "./auth"
import { automationHandlers } from "./automation"
import { chatHandlers } from "./chat"
import { devicesRuntimeAuthHandlers } from "./devices-runtime-auth"
import { imCoreHandlers } from "./im-core"
import { imWeixinDingtalkHandlers } from "./im-weixin-dingtalk"
import { mcpPluginsHandlers } from "./mcp-plugins"
import { memoriesHandlers } from "./memories"
import { miscHandlers } from "./misc"
import { modelGroupsMemberActorHandlers } from "./model-groups-member-actor"
import { modelGroupsWsPlatformHandlers } from "./model-groups-ws-platform"
import { platformHandlers } from "./platform"
import { relationshipContactsHandlers } from "./relationship-contacts"
import { remoteAgentsHandlers } from "./remote-agents"
import { skillsHandlers } from "./skills"
import { workspaceHandlers } from "./workspace"
import { workspaceResourcesInvitesHandlers } from "./workspace-resources-invites"

// Merged map of every domain's mocked methods. Each domain module exports an
// object `satisfies DesignHandlers` and is spread in here. Methods absent from
// this map fall through to the Proxy catch-all in ../mock-api.ts.
export const handlers: DesignHandlers = {
  ...actorsHandlers,
  ...authHandlers,
  ...automationHandlers,
  ...chatHandlers,
  ...devicesRuntimeAuthHandlers,
  ...imCoreHandlers,
  ...imWeixinDingtalkHandlers,
  ...mcpPluginsHandlers,
  ...memoriesHandlers,
  ...miscHandlers,
  ...modelGroupsMemberActorHandlers,
  ...modelGroupsWsPlatformHandlers,
  ...platformHandlers,
  ...relationshipContactsHandlers,
  ...remoteAgentsHandlers,
  ...skillsHandlers,
  ...workspaceHandlers,
  ...workspaceResourcesInvitesHandlers,
}
