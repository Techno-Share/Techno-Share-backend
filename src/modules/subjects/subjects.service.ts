import {
  Injectable,
  InternalServerErrorException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from './entities/subject.entity';
import { BUCKETS, StorageService } from '../storage/storage.service';
import { pgCode, errMessage } from '../../common/utils/pg-error';
import { CreateSubjectDto } from './dto/create-subject.dto';
import { UpdateSubjectDto } from './dto/update-subject.dto';
import { acronymFromName } from '../../common/utils/acronym';
import { ModerationService } from '../admin/moderation.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class SubjectsService {
  constructor(
    @InjectRepository(Subject)
    private readonly subjects: Repository<Subject>,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly moderation: ModerationService,
  ) {}

  async countsByMajor(majorId: string): Promise<Record<number, number>> {
    let rows: { year_level: number }[];
    try {
      rows = await this.subjects.find({
        select: { year_level: true },
        where: { major_id: majorId, status: 'active' },
      });
    } catch {
      throw new InternalServerErrorException('Failed to fetch subject counts');
    }

    const counts: Record<number, number> = {};
    for (const row of rows) {
      const year = Number(row.year_level);
      if (Number.isInteger(year) && year >= 1) {
        counts[year] = (counts[year] ?? 0) + 1;
      }
    }
    return counts;
  }

  async findByMajor(
    majorId: string,
    yearLevel?: number,
    semester?: number,
    search?: string,
  ) {
    const qb = this.subjects
      .createQueryBuilder('s')
      .select([
        's.id',
        's.name',
        's.acronym',
        's.semester',
        's.year_level',
        's.subject_url',
      ])
      .where('s.major_id = :majorId', { majorId })
      // Approved only. Nothing is ever created pending now, and the rows that
      // predate that change were published with it.
      .andWhere('s.status = :active', { active: 'active' })
      // Alphabetical. Was semester, then subject_url — which sorted by image
      // URL, so whether a subject had a cover decided where it sat.
      .orderBy('s.name', 'ASC');

    if (yearLevel && yearLevel > 0)
      qb.andWhere('s.year_level = :yearLevel', { yearLevel });
    if (semester === 1 || semester === 2)
      qb.andWhere('s.semester = :semester', { semester });
    if (search?.trim())
      qb.andWhere('s.name ILIKE :search', { search: `%${search.trim()}%` });

    try {
      return await qb.getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch subjects');
    }
  }

  async create(
    dto: CreateSubjectDto,
    image?: Express.Multer.File,
    submittedBy?: string,
  ) {
    /**
     * Adding a subject is a curation decision, not a contribution: it defines
     * what the department's shelves ARE, and a wrong or duplicated one is seen
     * by everybody until someone tidies it. So it is limited to the people who
     * already decide that — an admin anywhere, a moderator inside the
     * departments they moderate.
     *
     * Checked against the department being written to, never against a role on
     * the request, so a moderator of GIC cannot add a subject to GTR.
     */
    const reviewer = await this.moderation.resolveReviewer(submittedBy ?? '');
    if (!this.moderation.canModerate(reviewer, dto.major_id)) {
      throw new ForbiddenException(
        'Only a moderator of this department can add a subject to it',
      );
    }
    const subjectUrl = dto.subject_url?.trim();

    let uploadedImageUrl: string | null = null;
    let uploadedKey: string | null = null;

    if (image) {
      const ext = image.originalname.split('.').pop() ?? 'bin';
      uploadedKey = `${dto.major_id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      try {
        uploadedImageUrl = await this.storage.upload(
          BUCKETS.SUBJECTS,
          uploadedKey,
          image.buffer,
          image.mimetype,
        );
      } catch (err) {
        throw new InternalServerErrorException(
          errMessage(err) || 'Failed to upload subject image',
        );
      }
    }

    // Null when the submitter supplied neither a file nor a URL. Deliberately
    // NOT a placeholder image: the client decides what to render for a subject
    // with no cover (SubjectCard shows the acronym), and it can only do that if
    // "no cover" is representable.
    const finalSubjectUrl = uploadedImageUrl ?? subjectUrl ?? null;

    try {
      const saved = await this.subjects.save(
        this.subjects.create({
          major_id: dto.major_id,
          name: dto.name.trim(),
          // Never supplied by the form — initials of the name. Admins can
          // override it afterwards.
          acronym: acronymFromName(dto.name),
          year_level: dto.year_level,
          semester: dto.semester,
          subject_url: finalSubjectUrl,
          // Everyone who may create one may also approve it, so there is
          // nothing left to review — the same rule uploads follow. Keeping it
          // pending would mean the creator approving their own subject one
          // click later, which is a ritual rather than a control.
          status: 'active',
          submitted_by: submittedBy ?? null,
        }),
      );

      /**
       * No "waiting for review" notice: nothing is waiting. It was telling the
       * department's moderators about a subject that is already part of the
       * course, which is a queue entry with nothing in it.
       */

      return {
        id: saved.id,
        name: saved.name,
        acronym: saved.acronym,
        year_level: saved.year_level,
        semester: saved.semester,
        major_id: saved.major_id,
        subject_url: saved.subject_url,
      };
    } catch (err) {
      if (uploadedKey)
        await this.storage.remove([`${BUCKETS.SUBJECTS}/${uploadedKey}`]);

      const code = pgCode(err);
      if (code === '23505')
        throw new ConflictException(
          'A subject with this name already exists for this major',
        );
      if (code === '23503') throw new BadRequestException('Invalid major_id');
      if (code === '23502')
        throw new BadRequestException(
          errMessage(err) || 'Missing required field for subject creation',
        );
      throw new BadRequestException(
        errMessage(err) || 'Failed to create subject',
      );
    }
  }

  async findMine(userId: string) {
    let rows: Subject[];
    try {
      rows = await this.subjects
        .createQueryBuilder('s')
        .leftJoinAndSelect('s.major', 'major')
        .where('s.submitted_by = :userId', { userId })
        // Only the leftovers: a subject created now is active at once, so this
        // can return nothing but rows left pending when review was removed.
        .andWhere('s.status = :pending', { pending: 'pending' })
        // Newest first. Was `s.id DESC`, which orders by uuid — meaningless,
        // and it made your own submissions list look shuffled.
        .orderBy('s.created_at', 'DESC')
        .addOrderBy('s.id', 'DESC')
        .getMany();
    } catch {
      throw new InternalServerErrorException('Failed to fetch your subjects');
    }

    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      acronym: s.acronym,
      year_level: s.year_level,
      semester: s.semester,
      subject_url: s.subject_url,
      status: s.status,
      created_at: s.created_at,
      majors: s.major ? { id: s.major.id, acronym: s.major.acronym } : null,
    }));
  }

  async updateOwn(id: string, userId: string, dto: UpdateSubjectDto) {
    const existing = await this.subjects.findOne({
      where: { id },
      select: { id: true, submitted_by: true, status: true, major_id: true },
    });

    if (!existing) throw new NotFoundException('Subject not found');
    /**
     * Curation, start to finish: whoever may ADD a subject to a department may
     * also fix or remove one.
     *
     * Was "your own, while it is still pending" — a rule that cannot survive
     * the review flow going away. A subject is created active now, so the
     * `status === 'active'` guard would have blocked the moderator who made it
     * one second earlier; and the legacy pending rows, once published, would
     * have left the students who proposed them able to edit live subjects.
     */
    const reviewer = await this.moderation.resolveReviewer(userId);
    if (!this.moderation.canModerate(reviewer, existing.major_id)) {
      throw new ForbiddenException(
        'Only a moderator of this department can change its subjects',
      );
    }

    const updates: Partial<Subject> = {};
    if (dto.name !== undefined) {
      updates.name = dto.name.trim();
      // The acronym follows the name; overriding it is an admin action.
      updates.acronym = acronymFromName(dto.name);
    }
    if (dto.semester !== undefined) updates.semester = dto.semester;

    if (!Object.keys(updates).length) return existing;

    try {
      await this.subjects.update({ id }, updates);
    } catch {
      throw new InternalServerErrorException('Failed to update subject');
    }

    const updated = await this.subjects.findOne({
      where: { id },
      select: {
        id: true,
        name: true,
        acronym: true,
        year_level: true,
        semester: true,
        subject_url: true,
        status: true,
      },
    });
    return updated;
  }

  async removeOwn(id: string, userId: string) {
    const existing = await this.subjects.findOne({
      where: { id },
      select: { id: true, submitted_by: true, status: true, major_id: true },
    });

    if (!existing) throw new NotFoundException('Subject not found');
    /**
     * Curation, start to finish: whoever may ADD a subject to a department may
     * also fix or remove one.
     *
     * Was "your own, while it is still pending" — a rule that cannot survive
     * the review flow going away. A subject is created active now, so the
     * `status === 'active'` guard would have blocked the moderator who made it
     * one second earlier; and the legacy pending rows, once published, would
     * have left the students who proposed them able to edit live subjects.
     */
    const reviewer = await this.moderation.resolveReviewer(userId);
    if (!this.moderation.canModerate(reviewer, existing.major_id)) {
      throw new ForbiddenException(
        'Only a moderator of this department can change its subjects',
      );
    }

    try {
      await this.subjects.delete({ id });
    } catch {
      throw new InternalServerErrorException('Failed to delete subject');
    }
    return { message: 'Subject deleted' };
  }
}
