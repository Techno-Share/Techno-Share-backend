import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { PromotionSettingsService } from '../settings/promotion-settings.service';
import { DepartmentModerator } from '../admin/entities/department-moderator.entity';
import {
  advanceYearLevel,
  isRolloverDue,
  needsDepartmentChoice,
} from './utils/promotion';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(DepartmentModerator)
    private readonly moderators: Repository<DepartmentModerator>,
    private readonly storage: StorageService,
    private readonly promotionSettings: PromotionSettingsService,
  ) {}

  async getMe(userId: string) {
    let user = await this.users.findOne({
      where: { id: userId },
      relations: { major: true },
    });

    if (!user) throw new NotFoundException('User not found');

    // getMe is the app's first call on every load, which makes it the natural
    // place to catch up on a promotion the student has not collected yet.
    user = await this.applyPendingPromotion(user);

    // A count, not the list — the client is told THAT they moderate, never
    // which departments. Which ones is an authorisation detail and the server
    // is the only thing that needs it.
    const moderatedCount = await this.moderators.countBy({ user_id: userId });
    const rolloverAt = await this.promotionSettings.rolloverAt();

    return {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      major_id: user.major_id,
      year_level: user.year_level,
      avatar_url: user.avatar_url,
      /** Contact for book handovers; shown to the other party only after a
          request is accepted. */
      telegram: user.telegram,
      /** Every account they have saved; `telegram` is the one in use. */
      telegram_handles: user.telegram_handles ?? [],
      role: user.role,
      /**
       * Whether this account moderates any department.
       *
       * A capability, not a role: a moderator is an ordinary user who also
       * reviews submissions, and promoting them to admin to make the screen
       * reachable would hand them the whole admin surface. The client uses this
       * only to decide what to show — every review request is still authorised
       * on the server, per department, against the resource itself.
       */
      is_moderator: moderatedCount > 0,
      created_at: user.created_at,
      majors: user.major
        ? {
            id: user.major.id,
            name: user.major.name,
            acronym: user.major.acronym,
          }
        : null,
      /**
       * True when a Foundation year 2 student is owed the scheduled rollover:
       * they have finished Foundation and the client must ask which department
       * they joined. Computed here so the date rule lives in one place.
       */
      needs_department_choice:
        needsDepartmentChoice(user.major?.acronym, user.year_level) &&
        isRolloverDue(rolloverAt, user.promoted_rollover_at),
    };
  }

  /**
   * Move a student up if a scheduled rollover has passed since they were last
   * seen, and record that we did.
   *
   * Three cases:
   *  - never seen before -> stamp where the schedule stands, move nobody. An
   *    account cannot be advanced by a rollover that passed before it existed.
   *  - Foundation year 2 -> left alone. Only the student can say which
   *    department they joined, so getMe flags it and the client asks.
   *  - anyone else -> one year, capped at their major's final year.
   */
  private async applyPendingPromotion(user: User): Promise<User> {
    const rolloverAt = await this.promotionSettings.rolloverAt();
    // The only promotion rule there is, now that the automatic July rollover is
    // gone. Tracked by instant rather than by year, so a second rollover inside
    // the same academic year still counts.
    const rolloverDue = isRolloverDue(
      rolloverAt,
      user.promoted_rollover_at,
      new Date(),
      user.created_at,
    );

    // Nothing owed. Deliberately no write here: an unstamped account is one
    // that has not had this rollover yet, and recording the schedule against
    // it before the moment arrives is what used to skip the student entirely.
    if (!rolloverDue) return user;

    // Foundation year 2: leave the stamp STALE on purpose. It is what getMe
    // reads to decide whether to ask, so stamping here would close out the
    // rollover before the student has told us which department they joined,
    // and the prompt would never appear. updateMe stamps it when they answer.
    if (needsDepartmentChoice(user.major?.acronym, user.year_level))
      return user;

    // Record which rollover this was, so it fires once and a later one still can.
    const updates: Partial<User> = { promoted_rollover_at: rolloverAt };
    // An incomplete profile has no year to advance; the complete-profile prompt
    // collects the current one directly, so stamping alone is right.
    if (user.year_level !== null) {
      updates.year_level = advanceYearLevel(
        user.major?.acronym,
        user.year_level,
        1,
      );
    }

    await this.users.update({ id: user.id }, updates);
    return Object.assign(user, updates);
  }

  async updateMe(userId: string, dto: UpdateUserDto) {
    // Build the update payload — only include fields that were actually sent
    const updates: Partial<User> = {};
    if (dto.first_name !== undefined) updates.first_name = dto.first_name;
    if (dto.last_name !== undefined) updates.last_name = dto.last_name;
    if (dto.major_id !== undefined) updates.major_id = dto.major_id;
    if (dto.year_level !== undefined) updates.year_level = dto.year_level;
    if (dto.avatar_url !== undefined) updates.avatar_url = dto.avatar_url;
    // Empty string clears it; anything else is stored as typed.
    if (dto.telegram !== undefined)
      updates.telegram = dto.telegram.trim() || null;

    if (dto.telegram_handles !== undefined) {
      // De-duplicated in order, so the list the client sends back next time
      // matches what was stored. The trim is belt-and-braces: the DTO pattern
      // rejects padding before this runs.
      const handles: string[] = [];
      for (const raw of dto.telegram_handles) {
        const handle = raw.trim();
        if (handle && !handles.includes(handle)) handles.push(handle);
      }
      updates.telegram_handles = handles;
    }

    /**
     * `telegram` and `telegram_handles` describe one thing between them — the
     * account in use, and the set it was chosen from — so neither is allowed to
     * drift out of the other.
     *
     * Sending a new list drops the selection if it is no longer in it and falls
     * back to the first saved account. Choosing a handle without sending a list
     * adds it to the list, so a client that only knows about `telegram` still
     * leaves the two consistent.
     */
    if (updates.telegram_handles !== undefined) {
      const handles = updates.telegram_handles;
      let selected = updates.telegram;
      if (selected === undefined) {
        const current = await this.users.findOne({
          where: { id: userId },
          select: { telegram: true },
        });
        selected = current?.telegram ?? null;
      }
      if (selected && !handles.includes(selected)) selected = null;
      updates.telegram = selected ?? handles[0] ?? null;
    } else if (updates.telegram) {
      const current = await this.users.findOne({
        where: { id: userId },
        select: { telegram_handles: true },
      });
      const handles = current?.telegram_handles ?? [];
      if (!handles.includes(updates.telegram))
        updates.telegram_handles = [...handles, updates.telegram];
    }
    /**
     * Department and year are not freely editable.
     *
     * They are what `canView` matches an upload's audience against, so a
     * student who could retype them at will could read any cohort's restricted
     * documents. Only the two legitimate moments are allowed:
     *
     *   - the profile is incomplete, so the complete-profile prompt is filling
     *     it in for the first time;
     *   - a rollover is due out of the foundation programme, so the
     *     promotion prompt is asking which department they joined.
     *
     * Anything else is refused, which is also what makes the read-only fields
     * in ProfileView more than a suggestion.
     */
    if (dto.major_id !== undefined || dto.year_level !== undefined) {
      const current = await this.users.findOne({
        where: { id: userId },
        relations: { major: true },
      });
      if (!current) throw new NotFoundException('User not found');

      const incomplete = !current.major_id || current.year_level === null;
      const rolloverAt = await this.promotionSettings.rolloverAt();
      const promotionDue =
        needsDepartmentChoice(current.major?.acronym, current.year_level) &&
        isRolloverDue(rolloverAt, current.promoted_rollover_at);

      if (!incomplete && !promotionDue)
        throw new ForbiddenException(
          'Your department and year are set by the institute and cannot be changed here',
        );

      // Answering the promotion prompt settles the rollover, so they are not
      // asked again on the next page load. Only a real move counts — see the
      // profile-save bug this replaced.
      if (promotionDue && dto.major_id && dto.major_id !== current.major_id)
        updates.promoted_rollover_at = rolloverAt;
    }

    if (Object.keys(updates).length === 0) {
      // Nothing to update — just return current profile
      return this.getMe(userId);
    }

    // If the avatar is being changed or removed, remember the old one so we can
    // delete the now-orphaned file from storage after the row is updated.
    let oldAvatarUrl: string | null = null;
    if (dto.avatar_url !== undefined) {
      const current = await this.users.findOne({
        where: { id: userId },
        select: { avatar_url: true },
      });
      oldAvatarUrl = current?.avatar_url ?? null;
    }

    try {
      await this.users.update({ id: userId }, updates);
    } catch {
      throw new InternalServerErrorException('Failed to update profile');
    }

    if (oldAvatarUrl && oldAvatarUrl !== dto.avatar_url) {
      await this.deleteAvatarFile(oldAvatarUrl);
    }

    return this.getMe(userId);
  }

  /** Removes an avatar file from storage given its public URL. Best-effort. */
  private async deleteAvatarFile(avatarUrl: string) {
    const key = this.storage.extractKey(avatarUrl);
    if (key) await this.storage.remove([key]);
  }

  async uploadAvatar(userId: string, file: Express.Multer.File) {
    const ext = file.originalname.split('.').pop();
    const key = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    try {
      const url = await this.storage.upload(
        BUCKETS.AVATARS,
        key,
        file.buffer,
        file.mimetype,
      );
      return { url };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      throw new InternalServerErrorException(
        `Avatar upload failed: ${message}`,
      );
    }
  }
}
