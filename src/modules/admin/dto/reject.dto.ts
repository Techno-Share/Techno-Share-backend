import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class RejectDto {
  /**
   * Required, on every rejection.
   *
   * It was optional, and the reason is the only thing the uploader gets back —
   * a silent rejection tells a student their work was turned down and leaves
   * them to guess whether to fix it or give up. The notification and their
   * dashboard both read "was not approved." with nothing after it.
   *
   * Enforced here rather than in the modals, which is where it used to live:
   * the moderator queue disabled its Confirm button until the box had text,
   * but the two admin screens did not, so the same action had two rules
   * depending on which screen you reached it from. A client-side rule is also
   * no rule at all against a direct PATCH.
   *
   * `Matches(/\S/)` is what actually enforces it — IsNotEmpty passes a string
   * of spaces, which stores as an empty reason the moment it is trimmed.
   */
  @IsString()
  @IsNotEmpty({ message: 'Tell the uploader why it was rejected' })
  @Matches(/\S/, { message: 'Tell the uploader why it was rejected' })
  @MaxLength(300)
  reason: string;
}
