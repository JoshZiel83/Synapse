import {
  PlatformNavigationViewSchema,
  PlatformAccessBindingListViewSchema,
  PlatformAccessBindingViewSchema,
} from "@synapse/shared/schemas"
import { mock } from "../faker-setup"
import type { DesignHandlers } from "./_types"

// Platform admin surface: nav gating flags, the access-binding list, and the
// grant mutation. `revokePlatformAccess` returns the raw fetch wrapper (no
// *View) so it is left to the Proxy catch-all.
export const platformHandlers = {
  getPlatformNavigation: async () => mock(PlatformNavigationViewSchema),
  getPlatformAccess: async () => mock(PlatformAccessBindingListViewSchema),
  grantPlatformAccess: async () => mock(PlatformAccessBindingViewSchema),
} satisfies DesignHandlers
