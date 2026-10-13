import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Major } from '../../majors/entities/major.entity';
import { User } from '../../users/entities/user.entity';

@Entity('subjects')
export class Subject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  major_id: string;

  @ManyToOne(() => Major)
  @JoinColumn({ name: 'major_id' })
  major: Major;

  @Column('text')
  name: string;

  // Short display code (initials of `name`), shown when a subject has no cover.
  @Column('text')
  acronym: string;

  @Column('int')
  year_level: number;

  @Column({ type: 'int', nullable: true })
  semester: number | null;

  @Column({ type: 'text', nullable: true })
  subject_url: string | null;

  /**
   * 'active' for everything created now. Legacy rows may still read 'pending'
   * or 'rejected' from the review era; both are invisible, since every lookup
   * filters to active.
   */
  @Column({ type: 'text', default: 'active' })
  status: string;

  @Column({ type: 'uuid', nullable: true })
  submitted_by: string | null;

  @ManyToOne(() => User, { nullable: true })
  @JoinColumn({ name: 'submitted_by' })
  submitter: User | null;

  /**
   * Left from the review era, when a subject was approved or rejected by a
   * moderator. Nothing writes it now — a subject is created by a moderator of
   * its own department and is active immediately. Kept only because the column
   * still exists for rows written before that change.
   */
  @Column({ type: 'uuid', nullable: true })
  reviewed_by: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
