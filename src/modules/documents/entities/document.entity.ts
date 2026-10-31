import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Upload } from './upload.entity';

// Named DocumentFile to avoid clashing with the DOM `Document` type.
@Entity('documents')
export class DocumentFile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  upload_id: string;

  @ManyToOne(() => Upload, (upload) => upload.documents, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'upload_id' })
  upload: Upload;

  /**
   * Where the object was publicly reachable, before the bucket was made
   * private. Kept for the backfill's sake and for legacy readers; it is NOT an
   * access-control mechanism and must not be handed to a client. Reads go
   * through `storage_key` and a presigned URL — see DocumentStorageKeys.
   */
  @Column('text')
  file_url: string;

  /** Canonical object ref, "<bucket>/<key>". Null only on un-backfilled rows. */
  @Column({ type: 'text', nullable: true })
  storage_key: string | null;

  /** Canonical ref for the generated PDF preview, when there is one. */
  @Column({ type: 'text', nullable: true })
  preview_key: string | null;

  // PDF rendition for in-browser preview of office files (pptx/docx/xlsx),
  // generated on upload by a LibreOffice conversion that no longer runs.
  // Null for every file uploaded since, and for files that never needed one
  // (already-previewable pdf/images) or when conversion was unavailable/failed.
  @Column({ type: 'text', nullable: true })
  preview_url: string | null;

  @Column({ type: 'text', nullable: true })
  original_name: string | null;

  @Column({ type: 'int', nullable: true })
  file_size_kb: number | null;

  /**
   * Review state for THIS file (see the CreateDocuments migration).
   *
   * 'active' for files that arrive with a new upload — the upload's own review
   * covers them. A file added to an already-approved upload lands 'pending' and
   * is hidden from everyone but its uploader until a moderator clears it, which
   * leaves the upload and its reviewed files untouched in the feed.
   */
  @Column({ type: 'text', default: 'active' })
  status: string;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;

  /**
   * Set when the uploader hides this individual file; null means visible.
   * Distinct from `status` (review state) — see the AddDocumentHiddenAt
   * migration. Hiding the last visible file also hides the parent upload.
   */
  @Column({ type: 'timestamptz', nullable: true })
  hidden_at: Date | null;

  /**
   * When this file was attached — its own, not its upload's.
   *
   * A file added to an existing upload is newer than the folder it joined, and
   * the list used to show the upload's date against every row.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
