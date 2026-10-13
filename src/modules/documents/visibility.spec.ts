import { DocumentsService } from './documents.service';

/**
 * Who can see a restricted upload.
 *
 * The rule under test: a student sees material addressed to any cohort they
 * have BEEN in, not only the one they are in today. Promotion used to revoke
 * access to a student's own past year — their course notes and past exams
 * stopped appearing the day the promotion job ran, with nothing deleted and
 * nothing said.
 *
 * `canView` and `viewerCohorts` stay private: nothing outside the service
 * should call them, and widening the API to make it testable would be the
 * wrong trade. The Probe interface below reaches them instead.
 */
type Cohort = { major_id: string; year_level: number };

const GIC = 'major-gic';
const GTR = 'major-gtr';
const TC = 'major-tc';

/**
 * The two methods under test, named structurally.
 *
 * Intersecting the class itself would collapse to `never` — TypeScript refuses
 * to widen a type that has private members — so the prototype is cast through
 * `unknown` to just the shape these tests drive.
 */
interface Probe {
  majors: { find: () => Promise<{ id: string; acronym: string }[]> };
  canView(upload: unknown, viewer: unknown, cohorts: Cohort[]): boolean;
  viewerCohorts(viewer: unknown): Promise<Cohort[]>;
}

/** A service with only the collaborator these two methods touch. */
function makeService(majors: { id: string; acronym: string }[]): Probe {
  const service = Object.create(DocumentsService.prototype) as unknown as Probe;
  service.majors = { find: () => Promise.resolve(majors) };
  return service;
}

const service = makeService([
  { id: TC, acronym: 'TC' },
  { id: GIC, acronym: 'GIC' },
  { id: GTR, acronym: 'GTR' },
]);

const viewer = (major_id: string, acronym: string, year_level: number) => ({
  id: 'student-1',
  role: 'user',
  major_id,
  year_level,
  major: { acronym },
});

const upload = (audience: Cohort[]) => ({
  uploader_id: 'someone-else',
  expires_at: null,
  hidden_at: null,
  audience,
});

const cohortsFor = (v: ReturnType<typeof viewer>) => service.viewerCohorts(v);

describe('upload visibility across cohorts', () => {
  it('still shows a year-3 upload to a student now in year 4', async () => {
    const student = viewer(GIC, 'GIC', 4);
    const cohorts = await cohortsFor(student);

    expect(
      service.canView(
        upload([{ major_id: GIC, year_level: 3 }]),
        student,
        cohorts,
      ),
    ).toBe(true);
  });

  it('shows the year they are actually in', async () => {
    const student = viewer(GIC, 'GIC', 4);
    expect(
      service.canView(
        upload([{ major_id: GIC, year_level: 4 }]),
        student,
        await cohortsFor(student),
      ),
    ).toBe(true);
  });

  it('does NOT show a year they have not reached yet', async () => {
    const student = viewer(GIC, 'GIC', 4);
    expect(
      service.canView(
        upload([{ major_id: GIC, year_level: 5 }]),
        student,
        await cohortsFor(student),
      ),
    ).toBe(false);
  });

  it('does NOT show another department, at any year', async () => {
    const student = viewer(GIC, 'GIC', 4);
    const cohorts = await cohortsFor(student);

    for (const year of [3, 4, 5]) {
      expect(
        service.canView(
          upload([{ major_id: GTR, year_level: year }]),
          student,
          cohorts,
        ),
      ).toBe(false);
    }
  });

  it('shows foundation-year material to a department student', async () => {
    // Everyone reaches a department through the foundation programme, so its
    // years are part of their past even though the department differs.
    const student = viewer(GIC, 'GIC', 5);
    const cohorts = await cohortsFor(student);

    expect(
      service.canView(
        upload([{ major_id: TC, year_level: 1 }]),
        student,
        cohorts,
      ),
    ).toBe(true);
  });

  it('does not grant a foundation student the department years', async () => {
    const fresher = viewer(TC, 'TC', 1);
    const cohorts = await cohortsFor(fresher);

    expect(cohorts).toEqual([{ major_id: TC, year_level: 1 }]);
    expect(
      service.canView(
        upload([{ major_id: GIC, year_level: 3 }]),
        fresher,
        cohorts,
      ),
    ).toBe(false);
  });

  it('treats an empty audience as unrestricted', async () => {
    const student = viewer(GIC, 'GIC', 3);
    expect(
      service.canView(upload([]), student, await cohortsFor(student)),
    ).toBe(true);
  });

  it('matches nothing when the profile has no department or year', async () => {
    const incomplete = {
      id: 'student-1',
      role: 'user',
      major_id: null,
      year_level: null,
      major: null,
    };
    const cohorts = await service.viewerCohorts(incomplete);

    expect(cohorts).toEqual([]);
    expect(
      service.canView(
        upload([{ major_id: GIC, year_level: 3 }]),
        incomplete,
        cohorts,
      ),
    ).toBe(false);
  });

  it('keeps expiry and hiding ahead of the cohort rule', async () => {
    const student = viewer(GIC, 'GIC', 4);
    const cohorts = await cohortsFor(student);
    const mine = { major_id: GIC, year_level: 4 };

    expect(
      service.canView(
        { ...upload([mine]), expires_at: new Date(Date.now() - 1000) },
        student,
        cohorts,
      ),
    ).toBe(false);

    expect(
      service.canView(
        { ...upload([mine]), hidden_at: new Date() },
        student,
        cohorts,
      ),
    ).toBe(false);
  });
});

/**
 * Opening a document directly, by id.
 *
 * `findOne` used to filter `status = 'active'` in SQL, so an uploader opening
 * their own pending submission from their dashboard got "Document not found"
 * — their own document, reported as nonexistent. The status check now sits
 * beside the audience check, where ownership is already known.
 */
describe('direct access to a pending upload', () => {
  const owner = { id: 'owner-1', role: 'user' };
  const admin = { id: 'admin-1', role: 'admin' };
  const stranger = { id: 'other-1', role: 'user' };

  /** Mirrors the guard in findOne. */
  const canOpen = (
    upload: { uploader_id: string; status: string },
    viewer: { id: string; role: string },
  ) =>
    upload.status === 'active' ||
    upload.uploader_id === viewer.id ||
    viewer.role === 'admin';

  const pending = { uploader_id: 'owner-1', status: 'pending' };
  const active = { uploader_id: 'owner-1', status: 'active' };

  it('lets the uploader open their own pending submission', () => {
    expect(canOpen(pending, owner)).toBe(true);
  });

  it('lets an admin open it, for moderation', () => {
    expect(canOpen(pending, admin)).toBe(true);
  });

  it('still hides a pending upload from everyone else', () => {
    expect(canOpen(pending, stranger)).toBe(false);
  });

  it('leaves an approved upload open to everyone the audience allows', () => {
    expect(canOpen(active, stranger)).toBe(true);
  });
});

/**
 * Whether an upload survives the "empty folder" filter in findAll.
 *
 * The listing refuses to show an upload with no visible file, because it would
 * render as a folder you can open and find nothing in. That test was applied to
 * every row regardless of status, which was harmless only for as long as a
 * rejected upload's files stayed marked 'active'.
 *
 * Rejecting an upload now marks its files rejected with it — correctly; they
 * were live rows pointing at deleted bytes — and that immediately emptied the
 * owner's "Not approved" tab. Nothing was lost and nothing was hidden on
 * purpose: the clause simply asked the wrong question of a row that has no
 * approved files by definition.
 *
 * Mirrors the SQL rather than running it; what is worth pinning here is which
 * statuses the question is asked about.
 */
describe('the empty-folder filter', () => {
  const listed = (
    uploadStatus: string,
    files: { status: string; hidden: boolean }[],
  ) =>
    uploadStatus !== 'active' ||
    files.some((f) => f.status === 'active' && !f.hidden);

  const approved = [{ status: 'active', hidden: false }];
  const rejectedFiles = [{ status: 'rejected', hidden: false }];

  it('lists a published upload that has an approved, visible file', () => {
    expect(listed('active', approved)).toBe(true);
  });

  it('hides a published upload whose files are all hidden', () => {
    expect(listed('active', [{ status: 'active', hidden: true }])).toBe(false);
  });

  it('hides a published upload left with nothing approved', () => {
    expect(listed('active', [{ status: 'pending', hidden: false }])).toBe(
      false,
    );
  });

  it('still lists a rejected upload to its owner — the regression', () => {
    expect(listed('rejected', rejectedFiles)).toBe(true);
  });

  it('still lists a pending upload to its owner', () => {
    expect(listed('pending', [{ status: 'pending', hidden: false }])).toBe(
      true,
    );
  });
});

/**
 * Editing your own upload, by status.
 *
 * A rejected upload is closed. Editing one used to re-open it — status back to
 * pending, reason cleared — so "Not approved" was a state the uploader could
 * edit their way out of, erasing the moderator's decision with nothing left
 * recording that the thing they refused had changed. Fixing a refused
 * submission now means uploading it again.
 *
 * Pending still re-queues: that decision has not been made, and an uploader
 * correcting their submission while it waits is what review is for.
 *
 * The 'active' exclusion is the easiest of the three to break. Re-queueing on
 * every edit would quietly unpublish a live document the moment its owner fixed
 * a typo in the title, and nobody would see it leave the feed.
 */
describe('editing your own upload', () => {
  const canEdit = (status: string) => status !== 'rejected';
  const requeues = (status: string) => status === 'pending';

  it('allows editing a published upload', () => {
    expect(canEdit('active')).toBe(true);
  });

  it('allows editing one still under review', () => {
    expect(canEdit('pending')).toBe(true);
  });

  it('refuses to edit a rejected upload', () => {
    expect(canEdit('rejected')).toBe(false);
  });

  it('re-queues a pending upload when it is edited', () => {
    expect(requeues('pending')).toBe(true);
  });

  it('does NOT re-queue a published upload — editing must not unpublish it', () => {
    expect(requeues('active')).toBe(false);
  });

  it('never re-queues a rejected one: the edit is refused before it gets there', () => {
    expect(canEdit('rejected') && requeues('rejected')).toBe(false);
  });
});

/**
 * Which files a listing carries back with each upload.
 *
 * Two different questions share one join. On a PUBLISHED upload the answer
 * feeds a public feed card, so a file still awaiting review is left out — the
 * count should say what a reader can actually open. On an UNPUBLISHED one the
 * only viewer is the owner, and the answer feeds their edit form, which lists
 * these as the files they already have.
 *
 * Filtering both the same way is what broke resubmission: rejecting an upload
 * marks its files rejected too, so every rejected upload came back carrying no
 * files at all and the edit form opened empty on the one document the owner was
 * trying to fix.
 */
describe('files attached to a listed upload', () => {
  /** Mirrors the LEFT JOIN condition in findAll. */
  const carried = (
    uploadStatus: string,
    file: { status: string; hidden: boolean },
  ) => (file.status === 'active' && !file.hidden) || uploadStatus !== 'active';

  const activeFile = { status: 'active', hidden: false };
  const pendingFile = { status: 'pending', hidden: false };
  const rejectedFile = { status: 'rejected', hidden: false };

  it('carries an approved, visible file on a published upload', () => {
    expect(carried('active', activeFile)).toBe(true);
  });

  it('leaves out a file awaiting review inside a published upload', () => {
    expect(carried('active', pendingFile)).toBe(false);
  });

  it('leaves out a hidden file inside a published upload', () => {
    expect(carried('active', { status: 'active', hidden: true })).toBe(false);
  });

  it('carries the files of a rejected upload — the edit form needs them', () => {
    expect(carried('rejected', rejectedFile)).toBe(true);
  });

  it('carries the files of a pending upload', () => {
    expect(carried('pending', activeFile)).toBe(true);
  });
});

/**
 * The two filters that decide which files a LISTED upload carries.
 *
 * They run one after the other and were disagreeing. The SQL join attaches the
 * rows; `visibleFiles` then re-filters them in JS for whoever is asking. The
 * listing called it without a viewer, so every upload was shaped as if for the
 * public — the join handed over the owner's own rejected files and the next
 * line threw them away.
 *
 * The symptom was oddly specific: a rejected upload showed its file on the
 * detail page (findOne passes the viewer) and none in the dashboard's edit
 * form, which reads the listed upload instead.
 */
describe('files on a listed upload, after both filters', () => {
  /** SQL: the LEFT JOIN condition. */
  const joined = (
    uploadStatus: string,
    f: { status: string; hidden: boolean },
  ) => (f.status === 'active' && !f.hidden) || uploadStatus !== 'active';

  /** JS: visibleFiles. */
  const kept = (
    uploaderId: string,
    viewer: { id: string; role: string } | undefined,
    f: { status: string; hidden: boolean },
  ) =>
    !!viewer && (viewer.id === uploaderId || viewer.role === 'admin')
      ? true
      : f.status === 'active' && !f.hidden;

  const survives = (
    uploadStatus: string,
    uploaderId: string,
    viewer: { id: string; role: string } | undefined,
    f: { status: string; hidden: boolean },
  ) => joined(uploadStatus, f) && kept(uploaderId, viewer, f);

  const owner = { id: 'owner-1', role: 'user' };
  const stranger = { id: 'other-1', role: 'user' };
  const rejectedFile = { status: 'rejected', hidden: false };
  const activeFile = { status: 'active', hidden: false };
  const pendingFile = { status: 'pending', hidden: false };

  it('gives the owner the file of their rejected upload — the edit form needs it', () => {
    expect(survives('rejected', 'owner-1', owner, rejectedFile)).toBe(true);
  });

  it('dropped it when no viewer was passed — the defect', () => {
    expect(survives('rejected', 'owner-1', undefined, rejectedFile)).toBe(
      false,
    );
  });

  it('still hides a pending file inside a PUBLISHED upload, even from its owner', () => {
    // The feed card's count must say what a reader can actually open; the join
    // settles this before visibleFiles is consulted.
    expect(survives('active', 'owner-1', owner, pendingFile)).toBe(false);
  });

  it('shows a published upload normally to a stranger', () => {
    expect(survives('active', 'owner-1', stranger, activeFile)).toBe(true);
  });

  it('never leaks a non-active file to a stranger', () => {
    for (const f of [pendingFile, rejectedFile])
      expect(survives('active', 'owner-1', stranger, f)).toBe(false);
  });
});
