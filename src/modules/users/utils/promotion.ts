import {
  isFoundationMajor,
  yearLevelsForMajor,
} from '../../documents/utils/year-levels';

/**
 * Students move up a year when an admin schedules a promotion. This module owns
 * that rule; nothing else should reason about the date.
 *
 * There was an automatic 1 July rollover here too. It was removed: the
 * institute's year does not always turn on the same date, and a rule that fires
 * by itself cannot be held back when it should not. Scheduling is now the only
 * way anybody advances — which also means nobody advances until an admin says
 * so.
 *
 * The advance is applied lazily, on the student's next visit after the moment
 * passes, rather than by a batch job at the moment itself. A cron was available
 * — AdminScheduler already runs one hourly — and was still the wrong tool here:
 *
 *  - Foundation year 2 cannot be advanced without asking which department the
 *    student joined, so an interactive path has to exist regardless. A batch
 *    job would be a second mechanism doing the same work, and the two could
 *    disagree.
 *  - `promoted_to_year` is set by the same write that advances the year, so
 *    "congratulate them once" needs no extra flag.
 *  - isRolloverDue is a comparison over stored state, so it can be asked any
 *    number of times and corrects itself. A batch UPDATE happens once.
 *
 * The cost is that `users.year_level` trails reality until each student
 * returns, so counts grouped by year under-report straight after a rollover.
 */

/**
 * Whether a student is owed the manually scheduled rollover.
 *
 * An admin schedules one instant and every student advances once when it
 * passes. The student's own stamp records which rollover they have already had,
 * so a second one can be scheduled inside the same academic year — something
 * the year-counting rule could not express, because two dates in one year are
 * the same number to it. That is why setting a new date used to advance nobody.
 *
 * Pure, and takes the schedule rather than reading it, so the rule stays
 * testable and the database access stays in one place.
 */
export function isRolloverDue(
  rolloverAt: Date | null,
  appliedAt: Date | null,
  now = new Date(),
  /**
   * When the account was created. A rollover that fired before the student
   * existed is not theirs to receive — they were not here for that year.
   *
   * This used to be handled by stamping `promoted_rollover_at` on first sight
   * of an unstamped account, which was wrong twice over: that branch could
   * only ever be reached for a rollover still in the FUTURE (a past one with
   * no stamp is simply due), so it never protected a new account from an old
   * rollover — and what it did instead was consume the upcoming one, leaving
   * `appliedAt === rolloverAt` so the student was skipped when the moment
   * finally came. Expressed as a comparison, it needs no write at all.
   */
  createdAt: Date | null = null,
): boolean {
  if (!rolloverAt) return false;
  if (rolloverAt > now) return false; // scheduled, not yet reached
  if (createdAt && rolloverAt <= createdAt) return false; // predates the account
  return !appliedAt || appliedAt < rolloverAt;
}

/**
 * The foundation programme's final year is the one that ends in a department,
 * so it cannot be advanced automatically — which department comes next is the
 * student's to say.
 *
 * isFoundationMajor rather than an acronym comparison here: this and the year
 * range have to agree on what counts as foundation, and when they were separate
 * literals a TC student got years 3–5 *and* no prompt.
 */
export function needsDepartmentChoice(
  acronym: string | null | undefined,
  yearLevel: number | null,
): boolean {
  return isFoundationMajor(acronym) && yearLevel === 2;
}

/**
 * The year level a student should be on after `rollovers` promotions.
 *
 * Capped at the major's final year: departments stop at 5, and advancing past
 * it would leave an audience pair no upload can ever target, silently emptying
 * the student's feed. Final-year students simply stay put.
 */
export function advanceYearLevel(
  acronym: string | null | undefined,
  yearLevel: number,
  rollovers: number,
): number {
  const years = yearLevelsForMajor(acronym ?? '');
  const highest = years[years.length - 1];
  return Math.min(yearLevel + rollovers, highest);
}
