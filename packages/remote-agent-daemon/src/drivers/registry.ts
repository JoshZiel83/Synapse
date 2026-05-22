import type { AgentDriver, RuntimeKind } from "./types.js"

const drivers = new Map<RuntimeKind, AgentDriver>()

export function registerDriver(driver: AgentDriver) {
  drivers.set(driver.runtimeKind, driver)
}

export function getDriver(runtimeKind: RuntimeKind): AgentDriver {
  const driver = drivers.get(runtimeKind)
  if (!driver) {
    throw new Error(`No driver registered for runtime ${runtimeKind}`)
  }
  return driver
}

export function tryGetDriver(runtimeKind: RuntimeKind): AgentDriver | null {
  return drivers.get(runtimeKind) ?? null
}

export function listDrivers(): AgentDriver[] {
  return [...drivers.values()]
}

/** Test helper. Drops all registered drivers. */
export function __clearDriversForTest() {
  drivers.clear()
}
