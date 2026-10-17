import { describe, expect, it } from 'vitest'
import { allowed, approvalHash, canonical, classify } from '../src/core/policy'
import type { ConnectorTool } from '../src/shared/types'

describe('classify', () => {
  it('trusts annotations first', () => {
    expect(classify({ name: 'delete_everything', annotations: { readOnlyHint: true } })).toBe('read')
    expect(classify({ name: 'list_things', annotations: { destructiveHint: true } })).toBe('sensitive')
  })

  it('reads the name in snake_case and camelCase', () => {
    expect(classify({ name: 'list_issues' })).toBe('read')
    expect(classify({ name: 'getPullRequest' })).toBe('read')
    expect(classify({ name: 'search_code' })).toBe('read')
    expect(classify({ name: 'merge_pull_request' })).toBe('sensitive')
    expect(classify({ name: 'deployService' })).toBe('sensitive')
    expect(classify({ name: 'send_email' })).toBe('sensitive')
    expect(classify({ name: 'create_issue' })).toBe('write')
    expect(classify({ name: 'update_issue' })).toBe('write')
  })

  it('prefers sensitive when a name mixes a read verb with a sensitive word', () => {
    expect(classify({ name: 'get_and_delete_cache' })).toBe('sensitive')
  })

  it('does not match words inside other words', () => {
    expect(classify({ name: 'list_payments' })).toBe('read') // "pay" is not "payments"
    expect(classify({ name: 'resend_invite' })).toBe('write') // "send" is not "resend"
  })
})

describe('allowed', () => {
  const tool = (cls: ConnectorTool['cls'], enabled = true): ConnectorTool => ({ name: 't', description: '', cls, enabled, highRisk: false, isNew: false })

  it('read grants only read tools; read_write grants all; none and missing grant nothing', () => {
    expect(allowed(tool('read'), 'read')).toBe(true)
    expect(allowed(tool('write'), 'read')).toBe(false)
    expect(allowed(tool('sensitive'), 'read')).toBe(false)
    expect(allowed(tool('sensitive'), 'read_write')).toBe(true)
    expect(allowed(tool('read'), 'none')).toBe(false)
    expect(allowed(tool('read'), undefined)).toBe(false)
  })

  it('never allows a disabled tool', () => {
    expect(allowed(tool('read', false), 'read_write')).toBe(false)
  })
})

describe('approval binding', () => {
  it('canonical JSON ignores key order, keeps array order and drops undefined', () => {
    expect(canonical({ b: 1, a: { d: [2, 1], c: 'x' }, z: undefined })).toBe('{"a":{"c":"x","d":[2,1]},"b":1}')
  })

  it('the same call hashes the same; any change gives another hash', () => {
    const h = approvalHash('github', 'merge_pull_request', { repo: 'acme/checkout', pull_number: 213 })
    expect(approvalHash('github', 'merge_pull_request', { pull_number: 213, repo: 'acme/checkout' })).toBe(h)
    expect(approvalHash('github', 'merge_pull_request', { repo: 'acme/checkout', pull_number: 214 })).not.toBe(h)
    expect(approvalHash('github', 'merge_pull_request', { repo: 'acme/checkout', pull_number: '213' })).not.toBe(h)
    expect(approvalHash('gitlab', 'merge_pull_request', { repo: 'acme/checkout', pull_number: 213 })).not.toBe(h)
  })
})
