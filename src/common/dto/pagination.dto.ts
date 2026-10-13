import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * The page the caller is asking for.
 *
 * Extended rather than repeated per endpoint so every paginated list agrees on
 * the bounds. `Max` matters as much as `Min`: without it `?limit=100000` is a
 * supported way to ask the database for the whole table, which is the exact
 * thing pagination exists to prevent.
 *
 * 100 is the largest option the admin tables offer (PAGE_SIZE_OPTIONS in
 * AdminDashboardView.vue), so the cap admits every legitimate request and
 * nothing beyond it.
 *
 * Both fields are optional: the service applies DEFAULT_ADMIN_PAGE_SIZE and
 * page 1, so a caller that sends neither still gets a page rather than
 * everything.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** The shape every paginated endpoint answers with. */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
