import { types as utilTypes } from "node:util"
import type { TrustDecision } from "./types.js"

export function parseTrustDecision(input: unknown, label: string): TrustDecision {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input) || utilTypes.isProxy(input) ||
        Object.getPrototypeOf(input) !== Object.prototype) {
      throw new Error(`${label} decision must be a plain object`)
    }
    if (Object.getOwnPropertySymbols(input).length !== 0) throw new Error(`${label} decision must not have Symbol keys`)
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Object.keys(descriptors)
    if (JSON.stringify(keys.sort()) !== JSON.stringify(["evidence", "source", "subject", "trusted"])) {
      throw new Error(`${label} decision must have exact keys`)
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) throw new Error(`${label} decision accessor forbidden: ${key}`)
    }
    const decision = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])) as unknown as TrustDecision
    if (decision.trusted !== true || typeof decision.subject !== "string" || typeof decision.source !== "string" ||
        typeof decision.evidence !== "string") {
      throw new Error(`${label} decision schema mismatch`)
    }
    return decision
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error
    throw new Error(`${label} decision failed closed`)
  }
}
