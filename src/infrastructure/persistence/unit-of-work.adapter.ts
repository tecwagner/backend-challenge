import { EntityManager } from '@mikro-orm/core';
import type { UnitOfWorkPort } from '../../application/ports/unit-of-work.port.js';

/**
 * Adapta EntityManager.transactional() do MikroORM como UnitOfWorkPort.
 *
 * Todos os repositórios que recebem o mesmo EntityManager participam
 * automaticamente da mesma transação SQL aberta aqui.
 *
 * Requirements: 6.3, 9.1, 10.6
 */
export class UnitOfWorkAdapter implements UnitOfWorkPort {
  constructor(private readonly em: EntityManager) {}

  transactional<T>(work: () => Promise<T>): Promise<T> {
    return this.em.transactional(work);
  }
}
