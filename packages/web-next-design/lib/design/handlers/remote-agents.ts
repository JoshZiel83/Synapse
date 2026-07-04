import {
  RemoteAgentResponseSchema,
  RemoteAgentMachinePairingSessionResponseSchema,
  RemoteAgentMachineDetailResponseSchema,
  RemoteAgentGroupTaskGrantsResponseSchema,
  WorkspaceResourceSuccessViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import {
  designRemoteAgents,
  designMachines,
  findRemoteAgent,
} from "../fixtures/remote-agents"
import type { DesignHandlers } from "./_types"

// Remote agents: list / detail / lifecycle mutations, machine pairing + machine
// list/detail, and group-task grants. Curated fixtures (a real Claude Code /
// Codex fleet across paired machines) replace the random faker output; pairing +
// machine-detail + grants stay mocked for Phase 2.
export const remoteAgentsHandlers = {
  getRemoteAgents: async () => ({ remoteAgents: designRemoteAgents }),
  getRemoteAgent: async (_ws: string, id: string) => ({
    remoteAgent: findRemoteAgent(id) ?? designRemoteAgents[0],
  }),
  createRemoteAgent: async () => ({ remoteAgent: designRemoteAgents[0] }),
  updateRemoteAgent: async (_ws: string, id: string) => ({
    remoteAgent: findRemoteAgent(id) ?? designRemoteAgents[0],
  }),
  deleteRemoteAgent: async () => mock(WorkspaceResourceSuccessViewSchema),
  bindRemoteAgent: async (_ws: string, id: string) => ({
    remoteAgent: findRemoteAgent(id) ?? designRemoteAgents[0],
  }),
  createRemoteAgentMachinePairingSession: async () =>
    mock(RemoteAgentMachinePairingSessionResponseSchema),
  getRemoteAgentMachines: async () => ({ machines: designMachines }),
  getRemoteAgentMachine: async () =>
    mock(RemoteAgentMachineDetailResponseSchema),
  getRemoteAgentGroupTaskGrants: async () =>
    mock(RemoteAgentGroupTaskGrantsResponseSchema),
  updateRemoteAgentGroupTaskGrants: async () =>
    mock(RemoteAgentGroupTaskGrantsResponseSchema),
} satisfies DesignHandlers
