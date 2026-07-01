import {
  RemoteAgentListResponseSchema,
  RemoteAgentResponseSchema,
  RemoteAgentMachinePairingSessionResponseSchema,
  RemoteAgentMachineListResponseSchema,
  RemoteAgentMachineDetailResponseSchema,
  RemoteAgentGroupTaskGrantsResponseSchema,
  WorkspaceResourceSuccessViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Remote agents: list / detail / lifecycle mutations, machine pairing + machine
// list/detail, and group-task grants. These drive the remote-agents console
// (agent roster, machine pairing flow, per-agent grant editor).
export const remoteAgentsHandlers = {
  getRemoteAgents: async () => mock(RemoteAgentListResponseSchema),
  getRemoteAgent: async () => mock(RemoteAgentResponseSchema),
  createRemoteAgent: async () => mock(RemoteAgentResponseSchema),
  updateRemoteAgent: async () => mock(RemoteAgentResponseSchema),
  deleteRemoteAgent: async () => mock(WorkspaceResourceSuccessViewSchema),
  bindRemoteAgent: async () => mock(RemoteAgentResponseSchema),
  createRemoteAgentMachinePairingSession: async () =>
    mock(RemoteAgentMachinePairingSessionResponseSchema),
  getRemoteAgentMachines: async () =>
    mock(RemoteAgentMachineListResponseSchema),
  getRemoteAgentMachine: async () =>
    mock(RemoteAgentMachineDetailResponseSchema),
  getRemoteAgentGroupTaskGrants: async () =>
    mock(RemoteAgentGroupTaskGrantsResponseSchema),
  updateRemoteAgentGroupTaskGrants: async () =>
    mock(RemoteAgentGroupTaskGrantsResponseSchema),
} satisfies DesignHandlers
