import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drop `subjects.rejection_reason` and `rejected_at`, and make `status` default
 * to 'active'.
 *
 * Subjects no longer have a review. A subject is created by a moderator of its
 * own department and is visible immediately, so there is no one to reject it
 * and nothing to record a reason for — the columns have had no writer since the
 * review code was removed.
 *
 * The CHECK on `status` is deliberately left alone, still naming 'pending' and
 * 'rejected'. Tightening it would mean first mutating or deleting rows that
 * carry those values, which is a decision about someone else's content, not a
 * schema cleanup. Leaving it costs nothing: no code can write either value, and
 * every lookup filters to 'active', so such rows stay invisible exactly as they
 * are today.
 *
 * The default is the one real fix here. It was 'pending', from the era when a
 * new subject started life awaiting review; `create()` passes 'active'
 * explicitly, so the mismatch was harmless — but only until some other insert
 * path forgot to, at which point it would have written a subject nobody can
 * ever see and reported success.
 */
export class DropSubjectRejection1790380800000 implements MigrationInterface {
  name = 'DropSubjectRejection1790380800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table subjects
        drop column if exists rejection_reason,
        drop column if exists rejected_at,
        alter column status set default 'active';
    `);
  }

  /**
   * Restores the columns, empty. The reasons themselves cannot come back — this
   * migration is where they are lost, which is the point of it.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table subjects
        add column if not exists rejection_reason text,
        add column if not exists rejected_at timestamptz,
        alter column status set default 'pending';
    `);
  }
}
