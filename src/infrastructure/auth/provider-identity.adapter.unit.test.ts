import { describe, expect, it } from 'bun:test';
import { ProviderIdentityAdapter } from './provider-identity.adapter.js';

describe('ProviderIdentityAdapter (stub)', () => {
  const adapter = new ProviderIdentityAdapter();

  it('resolves providerId from request header x-provider-id', async () => {
    const req = { headers: { 'x-provider-id': 'provider-alpha' } };
    const identity = await adapter.resolveFromRequest(req);
    expect(identity.providerId).toBe('provider-alpha');
    expect(identity.scopes).toContain('wagering:read');
    expect(identity.scopes).toContain('wagering:write');
  });

  it('resolves providerId from request body', async () => {
    const req = { body: { providerId: 'provider-beta' } };
    const identity = await adapter.resolveFromRequest(req);
    expect(identity.providerId).toBe('provider-beta');
  });

  it('resolves providerId from request params', async () => {
    const req = { params: { providerId: 'provider-gamma' } };
    const identity = await adapter.resolveFromRequest(req);
    expect(identity.providerId).toBe('provider-gamma');
  });

  it('falls back to default-provider when request contains no providerId', async () => {
    const identity = await adapter.resolveFromRequest({});
    expect(identity.providerId).toBe('default-provider');
  });
});
