import {
  ACADEMIC_NAME_PATTERN,
  NO_TEMPLATE_CHARS_PATTERN,
  PERSON_NAME_PATTERN,
  TITLE_PATTERN,
} from './text-patterns';

/**
 * These patterns were four copies in four DTOs before they were shared. The
 * copies agreed, so consolidating them must not change a single verdict —
 * that is what this file pins.
 *
 * It also pins the rule against the client: the frontend enforces the same
 * shape as `TEXT_NAME_PATTERN` in `src/utils/format.ts`, and a title the form
 * accepts but the API rejects is a user staring at a field that looks fine.
 */
describe('TITLE_PATTERN', () => {
  it.each([
    ['Thesis Report', 'plain Latin'],
    ['របាយការណ៍និក្ខេបបទ', 'Khmer, including combining marks'],
    ['week_01-notes', 'underscore and hyphen'],
    ['Lab 3', 'digits'],
    ['a', 'a single character'],
  ])('accepts %j — %s', (title) => {
    expect(TITLE_PATTERN.test(title)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace only'],
    ['---', 'punctuation only — the lookahead case'],
    ['___', 'underscores only'],
    ['hello!', 'an exclamation mark'],
    ['a@b', 'an at sign'],
    ['<script>', 'markup'],
    ['a${b}', 'template syntax'],
  ])('rejects %j — %s', (title) => {
    expect(TITLE_PATTERN.test(title)).toBe(false);
  });

  it('requires at least one letter or number, not merely allowed characters', () => {
    // The character class alone would admit all three. The lookahead is the
    // only reason they fail, and dropping it is the likeliest future mistake.
    for (const only of ['-', ' ', '_-_']) {
      expect(TITLE_PATTERN.test(only)).toBe(false);
    }
  });
});

describe('NO_TEMPLATE_CHARS_PATTERN', () => {
  it('allows ordinary punctuation a description needs', () => {
    expect(NO_TEMPLATE_CHARS_PATTERN.test('Week 3 — slides, part (a).')).toBe(
      true,
    );
  });

  it.each(['a$b', 'a{b', 'a}b', '${name}'])(
    'rejects %j — it reaches a notification template downstream',
    (text) => {
      expect(NO_TEMPLATE_CHARS_PATTERN.test(text)).toBe(false);
    },
  );
});

describe('ACADEMIC_NAME_PATTERN', () => {
  it('accepts the names a subject or department actually has', () => {
    for (const name of [
      'Applied Mathematics',
      'Web Development',
      'វិស្វកម្មព័ត៌មាន',
      'Year-1 Core',
    ]) {
      expect(ACADEMIC_NAME_PATTERN.test(name)).toBe(true);
    }
  });

  it('rejects the underscore that TITLE_PATTERN allows', () => {
    // This is the whole reason the two rules are separate. Merging them would
    // silently start accepting `applied_mathematics` as a department name.
    expect(ACADEMIC_NAME_PATTERN.test('applied_mathematics')).toBe(false);
    expect(TITLE_PATTERN.test('applied_mathematics')).toBe(true);
  });

  it('still requires a letter or number', () => {
    expect(ACADEMIC_NAME_PATTERN.test('- -')).toBe(false);
  });
});

describe('PERSON_NAME_PATTERN', () => {
  it.each(['Pharoth', 'Thy', 'សុខា'])('accepts %j', (name) => {
    expect(PERSON_NAME_PATTERN.test(name)).toBe(true);
  });

  it.each([
    ['pharoth', 'lowercase first letter'],
    ['Thy Pharoth', 'a space — each part is its own field'],
    ['Thy2', 'a digit'],
    ["O'Brien", 'an apostrophe'],
    ['', 'empty'],
  ])('rejects %j — %s', (name) => {
    expect(PERSON_NAME_PATTERN.test(name)).toBe(false);
  });

  it('admits a Khmer first character, which has no uppercase', () => {
    // Restricting the first character to [A-Z] made Khmer registration
    // impossible. That regression is what this case exists to catch.
    expect(PERSON_NAME_PATTERN.test('ស')).toBe(true);
  });
});
