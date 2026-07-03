import {
  PlatformAccessBindingListViewSchema,
  PlatformAccessBindingViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Platform admin surface: nav gating flags, the access-binding list, and the
// grant mutation. `revokePlatformAccess` returns the raw fetch wrapper (no
// *View) so it is left to the Proxy catch-all.
export const platformHandlers = {
  // Stable flags (all true) so every nav section is reachable + doesn't flicker
  // on refresh (random-mocking booleans made menus appear/disappear).
  getPlatformNavigation: async () => ({
    canAccessPlatformModels: true,
    canAccessPlatformAccess: true,
    canAccessPlatformSkills: true,
  }),
  getPlatformAccess: async () => mock(PlatformAccessBindingListViewSchema),
  grantPlatformAccess: async () => mock(PlatformAccessBindingViewSchema),
} satisfies DesignHandlers
