import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Major } from '../../majors/entities/major.entity';
import { User } from '../../users/entities/user.entity';
import { Subject } from '../../subjects/entities/subject.entity';
import { DocumentFile } from './document.entity';
import { UploadPin } from './upload-pin.entity';

/** One department + year that may see an upload. */
export type AudienceEntry = { major_id: string; year_level: number };

@Entity('uploads')
export class Upload {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  uploader_id: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'uploader_id' })
  uploader: User | null;

  @Column({ type: 'uuid' })
  major_id: string;

  @ManyToOne(() => Major)
  @JoinColumn({ name: 'major_id' })
  major: Major;

  @Column({ type: 'uuid', nullable: true })
  subject_id: string | null;

  @ManyToOne(() => Subject, { nullable: true })
  @JoinColumn({ name: 'subject_id' })
  subject: Subject | null;

  @Column('text')
  title: string;

  // Optional free-text description (replaced the per-upload tags feature).
  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column('text')
  doc_type: string;

  @Column('int')
  year_level: number;

  @Column({ type: 'text', nullable: true })
  academic_year: string | null;

  @Column({ type: 'text', default: 'pending' })
  status: string;

  // Who may see this upload, as explicit (department, year) pairs — see
  // db/015-upload-audience-pairs.sql. Empty = everyone. Decoupled from the doc's
  // own major_id/year_level: an uploader may target any set of pairs. Enforced
  // in the feed/detail queries.
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  audience: AudienceEntry[];

  // Optional soft expiry (see db/009-upload-expiry.sql). Null = never. Once past,
  // the upload is kept but hidden from everyone except its uploader and admins.
  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  /**
   * Set when the uploader hides the document; null means visible. Distinct from
   * `status` (review state) and `expires_at` (a scheduled date) — see the
   * AddUploadHiddenAt migration.
   */
  @Column({ type: 'timestamptz', nullable: true })
  hidden_at: Date | null;

  /** Who approved or rejected it; null until reviewed. */
  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;

  /**
   * The reviewer as a row rather than an id, so a list can name them without a
   * second query. Nullable twice over: never reviewed, or reviewed by an
   * account since deleted — the FK is ON DELETE SET NULL.
   */
  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'reviewed_by' })
  reviewer: User | null;

  @Column({ type: 'text', nullable: true })
  rejection_reason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rejected_at: Date | null;

  /**
   * When this rejected upload's files were actually deleted from storage.
   *
   * Null on a rejected upload means the bytes are still there, inside the
   * retention window — see common/retention.ts. The sweep claims rows by
   * setting this, so two backend replicas cannot purge the same upload twice.
   */
  @Column({ type: 'timestamptz', nullable: true })
  files_purged_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  uploaded_at: Date;

  @OneToMany(() => DocumentFile, (doc) => doc.upload)
  documents: DocumentFile[];

  /**
   * Pins on this upload, one per user who pinned it. Listings join this
   * filtered to the viewer, so `pins` holds at most their own — see
   * CreateUploadPins.
   */
  @OneToMany(() => UploadPin, (pin) => pin.upload)
  pins: UploadPin[];
}
