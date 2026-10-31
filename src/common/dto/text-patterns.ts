/**
 * Validation patterns shared by the DTOs that accept free text.
 *
 * `TITLE_PATTERN` was declared four times — in both book DTOs and both
 * document DTOs — with the same regex, the same comment and the same message
 * in each. Four copies of one rule is four places to edit and three places to
 * forget, and the rule has to agree with the client: the frontend enforces the
 * same shape in `src/utils/format.ts` as `TEXT_NAME_PATTERN`. Changing one of
 * five copies produces a form that accepts a title the API then rejects.
 *
 * Deliberately NOT shared with the subject/major name rule. That one omits the
 * underscore (`[\p{L}\p{M}\p{N}\s-]`) and is a different business rule that
 * happens to look similar — merging them would silently start accepting
 * underscores in department names.
 */

/**
 * Letters in any script including Khmer combining marks, numbers, spaces,
 * underscores and hyphens, with at least one letter or number somewhere.
 *
 * The lookahead is what stops a title of `---` or a single space: the
 * character class alone would admit both.
 */
export const TITLE_PATTERN = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s_-]+$/u;

/** Message for `TITLE_PATTERN`. Kept beside it so the two cannot drift. */
export const TITLE_MESSAGE = 'Title must not contain special characters';

/**
 * Free text that merely must not carry template-injection characters.
 *
 * Applied to descriptions, which are allowed punctuation that a title is not.
 * `$`, `{` and `}` are excluded because these values are interpolated into
 * notification bodies and Telegram messages downstream.
 */
export const NO_TEMPLATE_CHARS_PATTERN = /^[^${}]*$/;

/** Message for `NO_TEMPLATE_CHARS_PATTERN`. */
export const NO_TEMPLATE_CHARS_MESSAGE = 'Must not contain $, { or }';

/**
 * A subject or department name: letters in any script, numbers, spaces and
 * hyphens, with at least one letter or number.
 *
 * Was declared twice — `SUBJECT_NAME_PATTERN` and `MAJOR_NAME_PATTERN`, the
 * second admitting in its own comment that it "mirrors" the first. The client
 * holds the matching copy as `ACADEMIC_NAME_PATTERN` in `src/utils/format.ts`;
 * the name is kept identical on both sides so the pair is greppable.
 *
 * No underscore, unlike TITLE_PATTERN. A subject name is written out rather
 * than pasted from a file name, so an underscore here is a typo.
 */
export const ACADEMIC_NAME_PATTERN =
  /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}\s-]+$/u;

/** Message for `ACADEMIC_NAME_PATTERN`. */
export const ACADEMIC_NAME_MESSAGE = 'Name must not contain special characters';

/**
 * A person's given or family name.
 *
 * Latin or Khmer, starting with a capital where the script has one. Khmer has
 * no case, so the range `ក-៿` is admitted at the start as well — restricting
 * the first character to `A-Z` made it impossible to register under a Khmer
 * name. No spaces: each name part is its own field.
 *
 * Was declared identically in `register.dto.ts` and `update-user.dto.ts`, and
 * the two must agree — otherwise a profile edit could set a name that sign-up
 * would have refused.
 */
export const PERSON_NAME_PATTERN = /^[A-Zក-៿][A-Za-zក-៿]*$/;

/** Message for `PERSON_NAME_PATTERN`. */
export const PERSON_NAME_MESSAGE =
  'Name must start with a capital letter and contain no spaces, ' +
  'digits or symbols';
