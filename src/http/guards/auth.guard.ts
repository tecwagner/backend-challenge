import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * AuthGuard — implementação inicial no-op (Requirement 13.1).
 *
 * Permite todas as requisições sem verificação de token/credenciais.
 * Para substituir por uma implementação real (Keycloak / Zitadel):
 *  1. Injete `ProviderIdentityPort` (via token `PROVIDER_IDENTITY_PORT`).
 *  2. Implemente `canActivate` validando o bearer token JWT.
 *  3. Nenhum controller ou use case precisa ser alterado.
 *
 * Os endpoints de health (`/health/live`, `/health/ready`) são registrados
 * sem este guard — veja HealthController.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // no-op: sempre permite a requisição
    return true;
  }
}
