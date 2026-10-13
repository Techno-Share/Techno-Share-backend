import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Give each file its own timestamp.
 *
 * `documents` had none, so every file row in the UI showed `uploads.uploaded_at`
 * — the folder's age, repeated down the list. A file added to an existing
 * upload therefore read as old as the upload it joined: attach something now to
 * a folder posted last week and the row says "7 days ago".
 *
 * Backfilled from the parent upload rather than left at now(). It is the best
 * available approximation — every file that existed before this migration was
 * created with its upload or shortly after — and stamping them all with the
 * migration's own run time would have been actively wrong, making the entire
 * library look as though it had been posted the moment this shipped.
 */
export class AddDocumentCreatedAt1790553600000 implements MigrationInterface {
  name = 'AddDocumentCreatedAt1790553600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Nullable first: adding it NOT NULL with a default would stamp every
    // existing row with now() before the backfill could run.
    await queryRunner.query(`
      alter table documents
        add column if not exists created_at timestamptz;
    `);

    await queryRunner.query(`
      update documents d
         set created_at = u.uploaded_at
        from uploads u
       where u.id = d.upload_id
         and d.created_at is null;
    `);

    // Any row whose upload vanished mid-migration; the FK makes this all but
    // impossible, but NOT NULL below would fail on it.
    await queryRunner.query(`
      update documents set created_at = now() where created_at is null;
    `);

    await queryRunner.query(`
      alter table documents
        alter column created_at set not null,
        alter column created_at set default now();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table documents drop column if exists created_at;
    `);
  }
}
