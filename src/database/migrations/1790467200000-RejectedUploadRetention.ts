import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `uploads.files_purged_at`, and mark already-rejected uploads as purged.
 *
 * Rejecting an upload used to delete its files from storage immediately. They
 * are now kept for a retention window (see common/retention.ts) and removed by
 * an hourly sweep, so a rejection can be questioned or reversed while the bytes
 * still exist.
 *
 * The column records when the sweep actually ran, which the deadline alone
 * cannot tell us: without it every sweep would re-attempt the same long-dead
 * uploads forever, and nothing could say whether a rejected upload still has
 * its files.
 *
 * Existing rejected rows are backfilled as purged on purpose. Their objects
 * were deleted the moment they were rejected, under the old behaviour — leaving
 * the column null would claim the files are retained and send the sweep looking
 * for keys that have not existed for weeks.
 */
export class RejectedUploadRetention1790467200000 implements MigrationInterface {
  name = 'RejectedUploadRetention1790467200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      alter table uploads
        add column if not exists files_purged_at timestamptz;
    `);

    await queryRunner.query(`
      update uploads
         set files_purged_at = coalesce(rejected_at, now())
       where status = 'rejected'
         and files_purged_at is null;
    `);

    /**
     * The sweep's lookup: rejected, not yet purged, past the deadline. Partial
     * so it indexes only what the sweep can act on — a handful of rows out of
     * every upload ever rejected, since each one leaves the index as it is
     * purged.
     */
    await queryRunner.query(`
      create index if not exists idx_uploads_pending_purge
        on uploads (rejected_at)
       where status = 'rejected' and files_purged_at is null;
    `);

    /**
     * Rejecting a group left its file rows reading 'active' while their bytes
     * were deleted — a file marked live that cannot be opened. The upload's own
     * status hid it, but any query that filters files by status would have
     * taken them for real.
     */
    await queryRunner.query(`
      update documents d
         set status = 'rejected'
        from uploads u
       where u.id = d.upload_id
         and u.status = 'rejected'
         and d.status <> 'rejected';
    `);
  }

  /**
   * The file rows are deliberately not put back to 'active': they were wrong,
   * and on a rollback the old code reads the upload's status anyway.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      drop index if exists idx_uploads_pending_purge;
    `);
    await queryRunner.query(`
      alter table uploads
        drop column if exists files_purged_at;
    `);
  }
}
