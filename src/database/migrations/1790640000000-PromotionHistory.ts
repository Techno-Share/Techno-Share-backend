import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Keep a permanent, dated record of every promotion.
 *
 * `users.promoted_rollover_at` holds only the most recent rollover a student
 * received and is overwritten by the next one, so the date a student became a
 * year 4 was being destroyed the moment they became a year 5. The promotion
 * notice wants to show that history and there was nothing to read it from.
 *
 * That column STAYS. `isRolloverDue` reads it inside `getMe`, which runs on
 * every page load, and deciding "is a promotion owed?" from a date-ordered log
 * would put a scan into the app's hottest read. The same split as
 * `user_bans` beside `users.banned_at`: the column drives behaviour, this table
 * is the history, and `applyPendingPromotion` writes both.
 *
 * NOTHING IS BACKFILLED, and that is deliberate.
 *
 * It looks as though one row per student could be recovered from
 * `promoted_rollover_at` — but that stamp does not mean the student MOVED. It
 * is written identically for a capped advance, so a year 5 student carries the
 * stamp of the rollover that left them at 5, and a Foundation year 2 student
 * carries one written when they chose a department. Seeding from it would
 * invent promotions that never happened and date them precisely. An empty log
 * is honest; a fabricated one is worse than none.
 *
 * So the history begins at the next rollover. Existing students see their
 * promotions accumulate from there.
 */
export class PromotionHistory1790640000000 implements MigrationInterface {
  name = 'PromotionHistory1790640000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * user_id cascades: a promotion belonging to a deleted account describes
     * nobody. major_id is `set null` — deleting a department must not erase the
     * record that students were promoted inside it.
     */
    await queryRunner.query(`
      create table if not exists promotion_events (
        id          uuid primary key default gen_random_uuid(),
        user_id     uuid not null references users (id) on delete cascade,
        from_year   int not null,
        to_year     int not null,
        major_id    uuid references majors (id) on delete set null,
        rollover_at timestamptz not null,
        created_at  timestamptz not null default now(),
        constraint promotion_events_to_year_moved check (to_year > from_year)
      );
    `);

    /** The notice reads one student's promotions, newest first. */
    await queryRunner.query(`
      create index if not exists idx_promotion_events_user
        on promotion_events (user_id, rollover_at desc);
    `);

    /**
     * One row per student per rollover.
     *
     * `getMe` applies the promotion, and two can be in flight at once — two
     * tabs, or the two backend replicas. The year update is idempotent because
     * both requests compute the same next year; this is what stops the log from
     * recording the same promotion twice. The service relies on it and inserts
     * with `on conflict do nothing`.
     */
    await queryRunner.query(`
      alter table promotion_events
        add constraint promotion_events_user_rollover_uniq
        unique (user_id, rollover_at);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`drop table if exists promotion_events;`);
  }
}
