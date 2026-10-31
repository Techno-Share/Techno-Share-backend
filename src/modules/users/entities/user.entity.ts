import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Major } from '../../majors/entities/major.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('text')
  first_name: string;

  @Column('text')
  last_name: string;

  @Column({ type: 'text', unique: true })
  email: string;

  /**
   * Null for accounts created through Google, which have no password of ours.
   * login() rejects those rather than comparing against a placeholder.
   */
  @Column({ type: 'text', nullable: true })
  password_hash: string | null;

  /**
   * When this address was proved to belong to whoever is using it.
   *
   * Null blocks login: registering only says an address was typed, and the
   * whole point of verification is that typing is not proof. Set immediately
   * for Google accounts, which arrive with `email_verified` from Google, and
   * backfilled for every account that predates the feature.
   */
  @Column({ type: 'timestamptz', nullable: true })
  email_verified_at: Date | null;

  /**
   * Google's `sub` claim — stable for the life of the account, unlike the email,
   * which can be reassigned. Null until a Google identity is linked.
   */
  @Column({ type: 'text', nullable: true })
  google_id: string | null;

  @Column({ type: 'text', default: 'user' })
  role: string;

  @Column({ type: 'uuid', nullable: true })
  major_id: string | null;

  @ManyToOne(() => Major, { nullable: true })
  @JoinColumn({ name: 'major_id' })
  major: Major | null;

  @Column({ type: 'int', nullable: true })
  year_level: number | null;

  @Column({ type: 'text', nullable: true })
  avatar_url: string | null;

  /**
   * Telegram handle or t.me link, the single place contact details live.
   *
   * Books and requests each used to carry their own copy, so the same person
   * retyped it per listing and the copies could disagree. Never exposed until a
   * request is accepted — see the books service.
   */
  @Column({ type: 'text', nullable: true })
  telegram: string | null;

  /**
   * Every Telegram account this user has saved. `telegram` names whichever of
   * these is currently in use, so the two are kept in step by updateMe.
   */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  telegram_handles: string[];

  /**
   * The chat this user's Telegram notifications are delivered to, or null when
   * they have not connected Telegram.
   *
   * Deliberately not one of the handles above: those are contact details the
   * user types, and anybody can type anybody's. A chat_id is issued by Telegram
   * to a conversation the user themselves started with our bot, which is what
   * makes it proof rather than a claim. Unique across accounts — see the
   * migration.
   */
  @Column({ type: 'text', nullable: true })
  telegram_chat_id: string | null;

  /** When the link was made. Shown in settings; null while unconnected. */
  @Column({ type: 'timestamptz', nullable: true })
  telegram_linked_at: Date | null;

  /**
   * The manual rollover instant this student has already been advanced for.
   *
   * An instant, not a year number: two rollovers can be scheduled inside one
   * academic year, and a year makes the second look like the first — so nobody
   * moves. This identifies the event, which is what makes "has this student had
   * THIS rollover?" answerable. The year-counting column it replaced,
   * promoted_for_year, was dropped in DropUserPromotedForYear.
   */
  @Column({ type: 'timestamptz', nullable: true })
  promoted_rollover_at: Date | null;

  /**
   * Whether this account is banned is NOT stored here.
   *
   * banned_at / ban_reason / banned_by lived on this row until
   * DropUserBanColumns. They duplicated `user_bans`, which had to hold the same
   * facts anyway to keep a history across unbans — and a ban recorded twice
   * needed a transaction to stay consistent. Ask BanLookupService, or join
   * `user_bans` on `lifted_at is null` as the JWT strategy does.
   */

  /**
   * The last time this account made an authenticated request.
   *
   * Written by JwtStrategy at most once a minute, so it trails real activity by
   * up to that long — the admin table's "online" threshold is set well above it
   * for that reason. Null means the account has not been seen since the column
   * was added, which is not the same as never having signed in.
   */
  @Column({ type: 'timestamptz', nullable: true })
  last_seen_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
