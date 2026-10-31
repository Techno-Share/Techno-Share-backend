import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * When each account was last active, for the admin users table.
 *
 * "Online" means "made an authenticated request recently", not "holds an open
 * socket". The notifications gateway is the more precise signal but cannot
 * answer this alone: it has no disconnect handler, so a socket set would only
 * grow, and a replica killed mid-connection leaves entries nothing removes.
 * Correcting that means refcounting sockets across both replicas and expiring
 * them on a crash — a presence system, for one admin column.
 *
 * A timestamp cannot go stale, survives a restart, is already shared between
 * replicas because it lives in Postgres, and answers "last seen three days
 * ago" as well as "online now".
 *
 * Nullable with no backfill: an account that has not made a request since this
 * migration genuinely has not been seen, and dating it to the deploy would
 * claim activity that never happened.
 */
export class UserLastSeen1790726400000 implements MigrationInterface {
  name = 'UserLastSeen1790726400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * No index. The column is read as part of a row the users table already
     * fetches, never filtered or ordered by — and an index on a value rewritten
     * every minute per active account is maintenance bought for nothing. Add
     * one if the table ever learns to sort by it.
     */
    await queryRunner.query(`
      alter table users
        add column if not exists last_seen_at timestamptz;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table users drop column if exists last_seen_at;
    `);
  }
}
