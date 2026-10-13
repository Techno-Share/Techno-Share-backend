import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RejectDto } from './dto/reject.dto';
import { DeclineRequestDto } from '../books/dto/decline-request.dto';

/**
 * Every rejection has to say why.
 *
 * The reason used to be optional on the document routes, and two of the three
 * screens that reject did not ask for one — so a student could be told their
 * upload "was not approved." with nothing after it, and no way to learn what
 * to change. Disabling a Confirm button is not the rule; this is.
 *
 * Driven through the validator rather than by reading the decorators, because
 * the failure mode here is subtle: IsNotEmpty passes a string of spaces, which
 * stores as an empty reason the moment it is trimmed.
 */
const messagesFor = async (dto: object) => {
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
};

describe.each([
  ['RejectDto (documents and files)', RejectDto],
  ['DeclineRequestDto (book requests)', DeclineRequestDto],
])('%s requires a reason', (_name, Dto) => {
  const build = (body: unknown) => plainToInstance(Dto, body);

  it('refuses a missing reason', async () => {
    expect(await messagesFor(build({}))).not.toHaveLength(0);
  });

  it('refuses an empty reason', async () => {
    expect(await messagesFor(build({ reason: '' }))).not.toHaveLength(0);
  });

  it('refuses whitespace only — the trap IsNotEmpty alone misses', async () => {
    expect(await messagesFor(build({ reason: '   \t\n  ' }))).not.toHaveLength(
      0,
    );
  });

  it('refuses a non-string', async () => {
    expect(await messagesFor(build({ reason: 42 }))).not.toHaveLength(0);
  });

  it('accepts a real reason', async () => {
    expect(
      await messagesFor(build({ reason: 'Duplicate of an existing upload' })),
    ).toHaveLength(0);
  });

  it('caps the length at 300, so one field cannot carry an essay', async () => {
    expect(await messagesFor(build({ reason: 'x'.repeat(300) }))).toHaveLength(
      0,
    );
    expect(
      await messagesFor(build({ reason: 'x'.repeat(301) })),
    ).not.toHaveLength(0);
  });

  it('explains itself — the message is what the reviewer reads', async () => {
    const messages = await messagesFor(build({ reason: ' ' }));
    expect(messages.join(' ')).toMatch(/why/i);
  });
});
