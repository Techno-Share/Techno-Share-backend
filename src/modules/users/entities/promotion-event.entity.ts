import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from './user.entity';
import { Major } from '../../majors/entities/major.entity';

/**
 * One row per year a student actually moved up, kept forever.
 *
 * `users.promoted_rollover_at` records only the LATEST rollover a student has
 * received, and each new one overwrites it — so before this table the app could
 * answer "has this student had THIS rollover?" but never "when did they become
 * a year 4?". That is what the admin dashboard's Promotions table shows, and
 * the answer was being discarded on every advance.
 *
 * The column stays where it is. It is read inside `getMe` on every page load to
 * decide whether a promotion is owed, and answering that from a log would put a
 * date-ordered scan into the hottest read in the app. Same division as
 * `user_bans` beside `users.banned_at`: the column drives the behaviour, this
 * table is the history next to it.
 *
 * Append-only. Nothing updates or deletes a row — a promotion that happened
 * stays happened.
 */
@Entity('promotion_events')
@Index(['user_id', 'rollover_at'])
/**
 * One row per student per rollover, enforced rather than assumed.
 *
 * `getMe` applies the promotion, and two of those can be in flight at once —
 * two browser tabs, or the two backend replicas behind the load balancer. The
 * year update is naturally idempotent (both compute the same next year), but a
 * second insert would show the student the same promotion twice. The rollover
 * instant identifies the event, so it is what makes the row unique.
 */
@Unique('promotion_events_user_rollover_uniq', ['user_id', 'rollover_at'])
export class PromotionEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  /** The year they were on before this rollover. */
  @Column({ type: 'int' })
  from_year: number;

  /**
   * The year they moved to. Always greater than `from_year` — a capped advance
   * leaves the student where they were and writes no row, because there is no
   * promotion to show them.
   */
  @Column({ type: 'int' })
  to_year: number;

  /**
   * The department they were in when it happened.
   *
   * Recorded per event rather than read from the student's profile, because the
   * profile holds only their CURRENT department: a GIC student's year 1 -> 2
   * promotion happened while they were still in Foundation, and reading
   * `users.major_id` would relabel it GIC. Null once the department row is
   * deleted — the promotion still happened, so the key is `set null`.
   */
  @Column({ type: 'uuid', nullable: true })
  major_id: string | null;

  @ManyToOne(() => Major, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'major_id' })
  major: Major | null;

  /**
   * The scheduled rollover this row is for — not when it was written.
   *
   * The advance is applied lazily, on the student's next visit, so a student
   * who was away for a fortnight would otherwise be shown a promotion dated to
   * the day they came back rather than the day their year turned.
   */
  @Column({ type: 'timestamptz' })
  rollover_at: Date;

  /** When the row was written: the visit that collected the promotion. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  created_at: Date;
}
