import {
  advanceYearLevel,
  isRolloverDue,
  needsDepartmentChoice,
} from './promotion';

/**
 * The promotion rule, which decides what every student can see. Pure functions,
 * so they are tested directly rather than through a request.
 */
describe('promotion', () => {
  /**
   * The regression this guards: an account seen BEFORE the moment arrived
   * used to be stamped with the upcoming rollover, which made it equal to
   * the schedule and therefore never due. Two real students were skipped.
   */
  it('is still due for an account that was seen before the moment arrived', () => {
    const scheduled = new Date('2026-10-04T08:00:00Z');
    const after = new Date('2026-10-04T08:04:00Z');
    // Visited at 07:55 and nothing was recorded — the stamp stays null.
    expect(isRolloverDue(scheduled, null, after)).toBe(true);
  });

  it('does not apply a rollover that fired before the account existed', () => {
    const scheduled = new Date('2026-10-04T08:00:00Z');
    const after = new Date('2026-10-04T09:00:00Z');
    const createdLater = new Date('2026-10-04T08:30:00Z');
    expect(isRolloverDue(scheduled, null, after, createdLater)).toBe(false);
  });

  it('does apply a rollover that fired after the account existed', () => {
    const scheduled = new Date('2026-10-04T08:00:00Z');
    const after = new Date('2026-10-04T09:00:00Z');
    const createdEarlier = new Date('2026-09-01T00:00:00Z');
    expect(isRolloverDue(scheduled, null, after, createdEarlier)).toBe(true);
  });

  describe('isRolloverDue', () => {
    const scheduled = new Date('2026-09-16T07:31:00Z');
    const before = new Date('2026-09-16T07:30:00Z');
    const after = new Date('2026-09-16T07:32:00Z');

    it('is not due when nothing is scheduled', () => {
      expect(isRolloverDue(null, null, after)).toBe(false);
    });

    it('is not due before the moment arrives', () => {
      expect(isRolloverDue(scheduled, null, before)).toBe(false);
    });

    it('is due once it has passed and the student has never had one', () => {
      expect(isRolloverDue(scheduled, null, after)).toBe(true);
    });

    it('is not due twice for the same rollover', () => {
      expect(isRolloverDue(scheduled, scheduled, after)).toBe(false);
    });

    it('is due again for a LATER rollover in the same academic year', () => {
      // The case the old year-counting rule could not express: two dates inside
      // one year are the same number to it, so the second one moved nobody.
      const earlier = new Date('2026-09-16T07:20:00Z');
      expect(isRolloverDue(scheduled, earlier, after)).toBe(true);
    });

    it('ignores a rollover older than the one already applied', () => {
      // Re-scheduling backwards must not re-run something already done.
      const older = new Date('2026-09-01T00:00:00Z');
      expect(isRolloverDue(older, scheduled, after)).toBe(false);
    });
  });

  describe('one rollover means one step', () => {
    /** Mirrors applyPendingPromotion now that the July rule is gone. */
    const steps = (rolloverDue: boolean) => (rolloverDue ? 1 : 0);

    it('advances by exactly one when a rollover is due', () => {
      expect(steps(true)).toBe(1);
    });

    it('advances nobody when none is due', () => {
      expect(steps(false)).toBe(0);
    });
  });

  describe('advanceYearLevel', () => {
    it('caps at the major final year rather than running past it', () => {
      expect(advanceYearLevel('GIC', 4, 1)).toBe(5);
      expect(advanceYearLevel('GIC', 5, 1)).toBe(5);
      expect(advanceYearLevel('GIC', 4, 3)).toBe(5);
    });
  });

  /**
   * Which rollovers a student should actually be told about.
   *
   * `getMe` reports `promoted_to_year` only when the year MOVED, and these are
   * the cases that decides between. A capped advance stamps the student as
   * having received the rollover while leaving them where they were — telling
   * them they were promoted would be untrue.
   */
  describe('a promotion worth announcing', () => {
    const announced = (acronym: string, from: number) => {
      const to = advanceYearLevel(acronym, from, 1);
      return to > from ? to : null;
    };

    it.each([
      ['TC', 1, 2],
      ['GIC', 3, 4],
      ['GIC', 4, 5],
    ])('%s year %i -> %i is announced', (acronym, from, to) => {
      expect(announced(acronym, from)).toBe(to);
    });

    it('says nothing to a final-year student', () => {
      expect(announced('GIC', 5)).toBeNull();
    });

    it('says nothing at the top of Foundation', () => {
      // Foundation year 2 is capped too. That student gets the department
      // prompt instead, which applyPendingPromotion returns early for.
      expect(announced('TC', 2)).toBeNull();
    });
  });

  describe('needsDepartmentChoice', () => {
    it('is true for a foundation student in their final year', () => {
      expect(needsDepartmentChoice('TC', 2)).toBe(true);
    });

    it('is false once they have joined a department', () => {
      expect(needsDepartmentChoice('GIC', 3)).toBe(false);
      expect(needsDepartmentChoice('TC', 1)).toBe(false);
    });
  });
});
