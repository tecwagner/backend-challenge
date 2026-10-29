/**
 * UnitOfWorkPort abstracts a single atomic transaction boundary.
 *
 * All repository operations performed inside the `work` callback share the
 * same database transaction and are committed or rolled back together.
 *
 * The concrete adapter wraps MikroORM's EntityManager.transactional().
 *
 * Requirements: 6.3, 9.1, 10.6
 */
export interface UnitOfWorkPort {
  transactional<T>(work: () => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWorkPort');
