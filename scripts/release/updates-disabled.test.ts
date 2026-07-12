import { expect, test } from "bun:test"
import { validateUpdatesDisabledMarker } from "./updates-disabled"

test("requires the explicit pre-build environment marker", () => {
  expect(validateUpdatesDisabledMarker(undefined)).toEqual(["SIMULATOR_UPDATES_DISABLED must equal 1"])
  expect(validateUpdatesDisabledMarker("true")).toEqual(["SIMULATOR_UPDATES_DISABLED must equal 1"])
  expect(validateUpdatesDisabledMarker("1")).toEqual([])
})

test("requires the packaged Info.plist marker after build", () => {
  expect(validateUpdatesDisabledMarker("1", "<missing>")).toEqual(["Info.plist SimulatorUpdatesDisabled must be true"])
  expect(validateUpdatesDisabledMarker("1", "false")).toEqual(["Info.plist SimulatorUpdatesDisabled must be true"])
  expect(validateUpdatesDisabledMarker("1", "true")).toEqual([])
})
