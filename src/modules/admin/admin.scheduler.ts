import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AdminService } from './admin.service';
import { REJECTED_FILE_RETENTION_DAYS } from '../../common/retention';

/**
 * Deletes the files of uploads rejected longer ago than the retention window.
 *
 * A separate class from AdminService, so the schedule lives next to nothing else:
 * the service holds the rule, this decides when it runs. Backend-driven because
 * nobody is watching a rejected upload — it is precisely the thing no page has
 * open, so a frontend timer would never fire for it.
 */
@Injectable()
export class AdminScheduler {
  private readonly logger = new Logger(AdminScheduler.name);

  constructor(private readonly admin: AdminService) {}

  /**
   * Hourly. The window is measured in days, so the exact minute does not
   * matter, and an hourly sweep keeps each batch small. Safe on both replicas:
   * purgeRejectedUploads claims its rows before deleting anything.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeRejectedUploads() {
    try {
      const { purged, files } = await this.admin.purgeRejectedUploads();
      if (purged > 0)
        this.logger.log(
          `Purged ${files} file(s) from ${purged} upload(s) rejected over ${REJECTED_FILE_RETENTION_DAYS} days ago`,
        );
    } catch (err) {
      // Never let a sweep failure take the process down. The claim was released
      // on the way out, so the next run retries the same uploads.
      this.logger.error('Failed to purge rejected upload files', err);
    }
  }
}
