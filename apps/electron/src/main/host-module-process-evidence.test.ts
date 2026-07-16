import { describe, expect, test } from 'bun:test'
import {
  parseSanitizedMacosProcessTree,
  processGroupsAddedSince,
} from './host-module-process-evidence'

describe('Host Module macOS process evidence', () => {
  test('discovers a new dedicated group by numeric ownership without trusting its executable name', () => {
    const baseline = parseSanitizedMacosProcessTree(`
      100 1 90 /Applications/Simulator.app/Contents/MacOS/Simulator
      110 100 90 /Applications/Simulator.app/Contents/Frameworks/Simulator Helper
      200 100 200 /tmp/module-daemon
    `, 100)
    const duringJourney = parseSanitizedMacosProcessTree(`
      100 1 90 /Applications/Simulator.app/Contents/MacOS/Simulator
      110 100 90 /Applications/Simulator.app/Contents/Frameworks/Simulator Helper
      200 100 200 /tmp/module-daemon
      300 100 300 /private/runtime/unexpected-macos-26-name
      301 300 300 (unexpected-macos-26-name)
    `, 100)

    expect(baseline.directChildGroupLeaders).toEqual([200])
    expect(processGroupsAddedSince(
      new Set(baseline.directChildGroupLeaders),
      duringJourney.directChildGroupLeaders,
    )).toEqual([300])
    expect(duringJourney.records.find((record) => record.pid === 300)?.executable)
      .toBe('unexpected-macos-26-name')
  })

  test('retains only members of an exact known group after they are re-parented', () => {
    const observed = parseSanitizedMacosProcessTree(`
      100 1 90 Simulator
      401 1 400 (runtime-child)
      501 1 500 unrelated-child
      600 100 90 /bin/ps
    `, 100, new Set([400]))

    expect(observed.records).toEqual([{
      pid: 401,
      ppid: 1,
      pgid: 400,
      executable: 'runtime-child',
    }])
    expect(observed.directChildGroupLeaders).toEqual([])
  })

  test('does not claim a nested dedicated group as a provider process', () => {
    const observed = parseSanitizedMacosProcessTree(`
      100 1 90 Simulator
      200 100 200 module-daemon
      300 200 300 lazy-module-helper
    `, 100)

    expect(observed.records.map((record) => record.pid)).toEqual([200, 300])
    expect(observed.directChildGroupLeaders).toEqual([200])
  })

  test('rejects malformed or non-positive process rows', () => {
    const observed = parseSanitizedMacosProcessTree(`
      100 1 90 Simulator
      0 100 0 invalid
      201 nope 201 invalid
      202 100 202 valid-runtime
    `, 100)

    expect(observed.records).toEqual([{
      pid: 202,
      ppid: 100,
      pgid: 202,
      executable: 'valid-runtime',
    }])
    expect(observed.directChildGroupLeaders).toEqual([202])
  })
})
