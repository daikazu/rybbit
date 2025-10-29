import { access, constants } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { parse } from "@fast-csv/parse";
import { DateTime } from "luxon";
import { IJobQueue } from "../queues/jobQueue.js";
import { r2Storage } from "../../storage/r2StorageService.js";
import { CSV_PARSE_QUEUE, CsvParseJob, DATA_INSERT_QUEUE, DataInsertJob } from "./jobs.js";
import { UmamiEvent, umamiHeaders } from "../mappings/umami.js";
import { updateImportStatus } from "../importStatusManager.js";
import { deleteImportFile } from "../utils.js";
import { ImportQuotaTracker } from "../importQuotaChecker.js";
import { createServiceLogger } from "../../../lib/logger/logger.js";

const logger = createServiceLogger("import:csv-parser");

const getImportDataHeaders = (platform: string) => {
  switch (platform) {
    case "umami":
      return umamiHeaders;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
};

const createR2FileStream = async (storageLocation: string, platform: string) => {
  logger.info({ storageLocation }, "Reading from R2");
  const fileStream = await r2Storage.getImportFileStream(storageLocation);
  return fileStream.pipe(
    parse({
      headers: getImportDataHeaders(platform),
      renameHeaders: true,
      ignoreEmpty: true,
    })
  );
};

const createLocalFileStream = async (storageLocation: string, platform: string) => {
  logger.info({ storageLocation }, "Reading from local disk");
  await access(storageLocation, constants.F_OK | constants.R_OK);
  return createReadStream(storageLocation).pipe(
    parse({
      headers: getImportDataHeaders(platform),
      renameHeaders: true,
      ignoreEmpty: true,
    })
  );
};

const createDateRangeFilter = (startDateStr?: string, endDateStr?: string) => {
  const startDate = startDateStr
    ? DateTime.fromFormat(startDateStr, "yyyy-MM-dd", { zone: "utc" }).startOf("day")
    : null;
  const endDate = endDateStr ? DateTime.fromFormat(endDateStr, "yyyy-MM-dd", { zone: "utc" }).endOf("day") : null;

  if (startDate && !startDate.isValid) {
    throw new Error(`Invalid start date: ${startDateStr}`);
  }

  if (endDate && !endDate.isValid) {
    throw new Error(`Invalid end date: ${endDateStr}`);
  }

  return (dateStr: string) => {
    const createdAt = DateTime.fromFormat(dateStr, "yyyy-MM-dd HH:mm:ss", { zone: "utc" });
    if (!createdAt.isValid) {
      return false;
    }

    if (startDate && createdAt < startDate) {
      return false;
    }

    if (endDate && createdAt > endDate) {
      return false;
    }

    return true;
  };
};

export async function createCsvParseWorker(jobQueue: IJobQueue) {
  await jobQueue.work<CsvParseJob>(CSV_PARSE_QUEUE, async job => {
    const { site, importId, platform, storageLocation, isR2Storage, organization, startDate, endDate } = job;

    let stream: ReturnType<typeof parse> | null = null;
    let processingTimeout: NodeJS.Timeout | null = null;

    try {
      const quotaTracker = await ImportQuotaTracker.create(organization);

      const chunkSize = 5000;
      const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max

      let chunk: UmamiEvent[] = [];
      let totalSkippedQuota = 0;
      let totalProcessed = 0;

      stream = isR2Storage
        ? await createR2FileStream(storageLocation, platform)
        : await createLocalFileStream(storageLocation, platform);

      // Add explicit error handler before starting to consume the stream
      stream.on("error", error => {
        logger.error({ importId, error }, "Stream error");
        // Error will be caught by the outer try/catch
      });

      await updateImportStatus(importId, "processing");
      logger.info({ importId, platform, organization }, "Started processing CSV import");

      // Set timeout to prevent indefinite processing
      processingTimeout = setTimeout(() => {
        if (stream) {
          stream.destroy(new Error("Import processing timeout exceeded"));
        }
      }, PROCESSING_TIMEOUT_MS);

      const isDateInRange = createDateRangeFilter(startDate, endDate);

      for await (const data of stream) {
        // Skip rows with missing or invalid dates
        if (!data.created_at) {
          continue;
        }

        // Apply user-specified date range filter
        if (!isDateInRange(data.created_at)) {
          continue;
        }

        // Check per-month quota (includes historical window check)
        if (!quotaTracker.canImportEvent(data.created_at)) {
          totalSkippedQuota++;
          continue;
        }

        // Event passed all filters - add to chunk
        chunk.push(data);
        totalProcessed++;

        if (chunk.length >= chunkSize) {
          await jobQueue.send<DataInsertJob>(DATA_INSERT_QUEUE, {
            site,
            importId,
            platform,
            chunk,
            allChunksSent: false,
          });
          chunk = [];
        }
      }

      // Send final chunk if any data remains
      if (chunk.length > 0) {
        await jobQueue.send<DataInsertJob>(DATA_INSERT_QUEUE, {
          site,
          importId,
          platform,
          chunk,
          allChunksSent: false,
        });
      }

      // Check if some events couldn't be imported due to quotas
      if (totalSkippedQuota > 0) {
        const quotaSummary = quotaTracker.getSummary();
        const errorMessage =
          `${totalSkippedQuota} events exceeded monthly quotas or fell outside the ${quotaSummary.totalMonthsInWindow}-month historical window. ` +
          `${quotaSummary.monthsAtCapacity} of ${quotaSummary.totalMonthsInWindow} months are at full capacity. ` +
          `Try importing newer data or upgrade your plan for higher monthly quotas.`;
        await updateImportStatus(importId, "failed", errorMessage);
        const deleteResult = await deleteImportFile(storageLocation, isR2Storage);
        if (!deleteResult.success) {
          logger.warn({ importId, error: deleteResult.error }, "File cleanup failed");
        }
        return;
      }

      // Send finalization signal with total chunk count
      logger.info({ importId, totalProcessed, totalSkippedQuota }, "CSV parsing completed successfully");
      await jobQueue.send<DataInsertJob>(DATA_INSERT_QUEUE, {
        site,
        importId,
        platform,
        chunk: [],
        allChunksSent: true,
      });
    } catch (error) {
      logger.error({ importId, error }, "Error in CSV parse worker");

      await updateImportStatus(importId, "failed", "An unexpected error occurred during import processing");

      // Don't re-throw - worker should continue processing other jobs
      logger.error({ importId }, "Import failed, worker continuing");
    } finally {
      // Clean up timeout
      if (processingTimeout) {
        clearTimeout(processingTimeout);
      }

      // Ensure stream is destroyed to prevent memory leaks
      if (stream) {
        try {
          stream.destroy();
        } catch (streamError) {
          logger.warn({ importId, error: streamError }, "Failed to destroy stream");
        }
      }

      // Clean up file - don't throw on failure to prevent worker crashes
      const deleteResult = await deleteImportFile(storageLocation, isR2Storage);
      if (!deleteResult.success) {
        logger.warn({ importId, error: deleteResult.error }, "File cleanup failed, will remain in storage");
        // File will be orphaned but import status is already recorded
        // importCleanupService.ts handles orphans
      }
    }
  });
}
