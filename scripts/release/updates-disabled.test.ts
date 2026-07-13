import { expect, test } from "bun:test"
import { validateUpdatesDisabledMarker } from "./updates-disabled"

test("requires the explicit pre-build environment marker", () => {
  expect(validateUpdatesDisabledMarker(undefined)).toEqual(["SIMULATOR_DISABLE_UPDATES must equal 1"])
  expect(validateUpdatesDisabledMarker("true")).toEqual(["SIMULATOR_DISABLE_UPDATES must equal 1"])
  expect(validateUpdatesDisabledMarker("1")).toEqual([])
})

test("accepts the exact packaged build policy", () => {
  expect(validateUpdatesDisabledMarker("1", '{"schemaVersion":1,"updatesDisabled":true}', true)).toEqual([])
})

test("rejects a missing packaged marker", () => {
  expect(validateUpdatesDisabledMarker("1", null, true)).toEqual([
    "Packaged marker is missing: Contents/Resources/app/dist/resources/build-policy.json",
  ])
})

test("rejects updatesDisabled false", () => {
  expect(validateUpdatesDisabledMarker("1", '{"schemaVersion":1,"updatesDisabled":false}', true)).toEqual([
    "Packaged build policy must exactly equal {schemaVersion:1, updatesDisabled:true}",
  ])
})

test("rejects malformed marker JSON", () => {
  expect(validateUpdatesDisabledMarker("1", '{"schemaVersion":1,', true)).toEqual([
    "Packaged marker is malformed JSON: Contents/Resources/app/dist/resources/build-policy.json",
  ])
})

test.each([
  '{"schemaVersion":"1","updatesDisabled":true}',
  '{"schemaVersion":1,"updatesDisabled":"true"}',
  '{"schemaVersion":1,"updatesDisabled":true,"extra":false}',
  '[]',
])("rejects marker values outside the strict schema", (content) => {
  expect(validateUpdatesDisabledMarker("1", content, true)).toEqual([
    "Packaged build policy must exactly equal {schemaVersion:1, updatesDisabled:true}",
  ])
})
