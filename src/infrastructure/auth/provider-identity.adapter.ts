import { Injectable } from '@nestjs/common';
import type { ProviderIdentity, ProviderIdentityPort } from './provider-identity.port.js';

/**
 * ProviderIdentityAdapter — implementação inicial (stub) de ProviderIdentityPort.
 *
 * Requirement 13.2: resolve o providerId a partir dos headers ou payload
 * da requisição sem validar tokens externos de autenticação.
 * Permite substituição transparente por integração com Keycloak ou Zitadel.
 */
@Injectable()
export class ProviderIdentityAdapter implements ProviderIdentityPort {
  async resolveFromRequest(request: unknown): Promise<ProviderIdentity> {
    const req = request as {
      headers?: Record<string, string | undefined>;
      body?: { providerId?: string };
      params?: { providerId?: string };
    };

    const providerId =
      req?.headers?.['x-provider-id'] ??
      req?.body?.providerId ??
      req?.params?.providerId ??
      'default-provider';

    return {
      providerId,
      scopes: ['wagering:read', 'wagering:write'],
    };
  }
}
