/**
 * Mock challenge factories used by the offline compliance and security
 * test suites. Devnet integration tests use `test/integration/devnet-helpers.ts`
 * instead.
 */

export function createMockChargeChallenge(
  overrides: Partial<{
    amount: string
    currency: string
    recipient: string
    network: string
    description: string
    externalId: string
  }> = {},
): {
  id: string
  realm: string
  method: string
  intent: string
  request: {
    amount: string
    currency: string
    recipient: string
    methodDetails?: { network?: string; reference?: string }
  }
} {
  return {
    id: `test-challenge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    realm: 'test.example.com',
    method: 'xrpl',
    intent: 'charge',
    request: {
      amount: overrides.amount ?? '1000000',
      currency: overrides.currency ?? 'XRP',
      recipient: overrides.recipient ?? 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      ...(overrides.description && { description: overrides.description }),
      ...(overrides.externalId && { externalId: overrides.externalId }),
      methodDetails: {
        network: overrides.network ?? 'testnet',
        reference: `ref-${Date.now()}`,
      },
    },
  }
}

export function createMockChannelChallenge(
  overrides: Partial<{
    amount: string
    channelId: string
    recipient: string
    network: string
    cumulativeAmount: string
  }> = {},
): {
  id: string
  realm: string
  method: string
  intent: string
  request: {
    amount: string
    channelId: string
    recipient: string
    methodDetails?: { network?: string; reference?: string; cumulativeAmount?: string }
  }
} {
  return {
    id: `test-channel-challenge-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    realm: 'test.example.com',
    method: 'xrpl',
    intent: 'channel',
    request: {
      amount: overrides.amount ?? '100000',
      channelId: overrides.channelId ?? '0'.repeat(64),
      recipient: overrides.recipient ?? 'rf5kMNrUqgLzJT8YUzxM1pptc5r3Lfx1J9',
      methodDetails: {
        network: overrides.network ?? 'testnet',
        reference: `ref-${Date.now()}`,
        cumulativeAmount: overrides.cumulativeAmount ?? '0',
      },
    },
  }
}
