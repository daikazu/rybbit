import { IJobQueue } from "../queues/jobQueue.js";
import { UmamiImportMapper } from "../mappings/umami.js";
import { DataInsertJob, DATA_INSERT_QUEUE } from "./jobs.js";
import { clickhouse } from "../../../db/clickhouse/clickhouse.js";
import { updateImportStatus, updateImportProgress } from "../importStatusManager.js";
import { createServiceLogger } from "../../../lib/logger/logger.js";

const logger = createServiceLogger("import:data-insert");

const getImportDataMapping = (platform: string) => {
  switch (platform) {
    case "umami":
      return UmamiImportMapper;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
};

export async function createDataInsertWorker(jobQueue: IJobQueue) {
  await jobQueue.work<DataInsertJob>(DATA_INSERT_QUEUE, async job => {
    const { site, importId, platform, chunk, allChunksSent } = job;

    if (allChunksSent) {
      try {
        await updateImportStatus(importId, "completed");
        logger.info({ importId }, "Import completed successfully");
        return;
      } catch (error) {
        logger.error({ importId, error }, "Failed to mark as completed");
        // Try to update to failed status, but don't crash worker
        try {
          await updateImportStatus(importId, "failed", "Failed to complete import");
        } catch (updateError) {
          logger.error({ importId, error: updateError }, "Could not update status to failed");
        }
        // Don't re-throw - worker should continue
        return;
      }
    }

    try {
      const dataMapper = getImportDataMapping(platform);
      const transformedRecords = dataMapper.transform(chunk, site, importId);

      // Insert to ClickHouse (critical - must succeed)
      await clickhouse.insert({
        table: "events",
        values: transformedRecords,
        format: "JSONEachRow",
      });

      logger.debug({ importId, recordCount: transformedRecords.length }, "Inserted chunk to ClickHouse");

      // Update progress (non-critical - log if fails but don't crash)
      try {
        await updateImportProgress(importId, transformedRecords.length);
      } catch (progressError) {
        logger.warn(
          { importId, error: progressError instanceof Error ? progressError.message : progressError },
          "Progress update failed (data inserted successfully)"
        );
        // Don't throw - data is safely in ClickHouse, progress can be off slightly
      }
    } catch (error) {
      logger.error({ importId, error }, "ClickHouse insert failed");

      try {
        await updateImportStatus(importId, "failed", "Data insertion failed due to unknown error");
      } catch (updateError) {
        logger.error({ importId, error: updateError }, "Could not update status to failed");
      }

      // Don't re-throw - worker should continue processing other jobs
      logger.error({ importId }, "Import chunk failed, worker continuing");
    }
  });
}
