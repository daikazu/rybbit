import { unlink } from "node:fs/promises";
import { IS_CLOUD } from "../../lib/const.js";
import { r2Storage } from "../storage/r2StorageService.js";
import { createServiceLogger } from "../../lib/logger/logger.js";

const logger = createServiceLogger("import:utils");

export interface DeleteFileResult {
  success: boolean;
  error?: string;
}

export interface StorageLocationInfo {
  location: string;
  isR2: boolean;
}

export function getImportStorageLocation(importId: string, filename: string): StorageLocationInfo {
  const isR2 = IS_CLOUD && r2Storage.isEnabled();
  if (isR2) {
    return {
      location: `imports/${importId}/${filename}`,
      isR2: true,
    };
  }
  return {
    location: `/tmp/imports/${importId}/${filename}`,
    isR2: false,
  };
}

/**
 * Delete an import file from storage.
 * Returns result instead of throwing to prevent worker crashes.
 */
export const deleteImportFile = async (storageLocation: string, isR2Storage: boolean): Promise<DeleteFileResult> => {
  try {
    if (isR2Storage) {
      await r2Storage.deleteImportFile(storageLocation);
      logger.debug({ storageLocation }, "Deleted R2 file");
    } else {
      await unlink(storageLocation);
      logger.debug({ storageLocation }, "Deleted local file");
    }
    return { success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    logger.error({ storageLocation, error: errorMsg }, "Failed to delete file");

    // DON'T throw - return error info instead to prevent worker crashes
    return { success: false, error: errorMsg };
  }
};
