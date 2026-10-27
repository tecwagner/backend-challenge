/**
 * ProviderIdentityPort — ponto de extensão para validação de identidade do Provider.
 *
 * Requirement 13.2: exposto como porta na camada de aplicação, documentado em
 * ARCHITECTURE.md com o desenho de integração com Identity Provider externo
 * (Keycloak ou Zitadel).
 *
 * A implementação inicial é um stub que extrai `providerId` diretamente do
 * payload da requisição sem validar tokens externos.
 * Para substituir por uma implementação real (JWT / Keycloak / Zitadel):
 *  1. Crie uma nova classe que implemente `ProviderIdentityPort`.
 *  2. Registre-a no módulo de infraestrutura no lugar do adapter stub.
 *  3. Nenhum controller ou use case precisa ser alterado.
 */

export interface ProviderIdentity {
  /** Identificador estável do provedor de jogos autenticado. */
  providerId: string;
  /** Escopos/permissões concedidos ao provider pelo Identity Provider. */
  scopes: string[];
}

export const PROVIDER_IDENTITY_PORT = Symbol('ProviderIdentityPort');

export interface ProviderIdentityPort {
  /**
   * Resolve a identidade do provider a partir do contexto de autenticação
   * (cabeçalhos HTTP, token JWT, etc.).
   *
   * @throws {ProviderUnauthorizedError} quando a identidade não puder ser determinada.
   */
  resolveFromRequest(request: unknown): Promise<ProviderIdentity>;
}
