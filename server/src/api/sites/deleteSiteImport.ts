import { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getUserHasAdminAccessToSite } from "../../lib/auth-utils.js";
import { ImportStatusManager } from "../../services/import/importStatusManager.js";
import { deleteImportFile } from "../../services/import/utils.js";
import { IS_CLOUD } from "../../lib/const.js";
import { r2Storage } from "../../services/storage/r2StorageService.js";
import { clickhouse } from "../../db/clickhouse/clickhouse.js";

const deleteImportRequestSchema = z
  .object({
    params: z.object({
      site: z.string().min(1),
      importId: z.string().min(1),
    }),
  })
  .strict();

type DeleteImportRequest = {
  Params: z.infer<typeof deleteImportRequestSchema.shape.params>;
};

export async function deleteSiteImport(request: FastifyRequest<DeleteImportRequest>, reply: FastifyReply) {
  try {
    const parsed = deleteImportRequestSchema.safeParse({
      params: request.params,
    });

    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error" });
    }

    const { site, importId } = parsed.data.params;

    const userHasAccess = await getUserHasAdminAccessToSite(request, site);
    if (!userHasAccess) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    const importRecord = await ImportStatusManager.getImportById(importId);
    if (!importRecord) {
      return reply.status(404).send({ error: "Import not found" });
    }

    if (importRecord.siteId !== Number(site)) {
      return reply.status(403).send({ error: "Import does not belong to this site" });
    }

    if (importRecord.status === "pending" || importRecord.status === "processing") {
      return reply.status(400).send({ error: "Cannot delete active import" });
    }

    // Delete the import file if it exists
    try {
      let storageLocation: string;
      if (IS_CLOUD && r2Storage.isEnabled()) {
        storageLocation = `imports/${importId}/${importRecord.fileName}`;
      } else {
        storageLocation = `/tmp/imports/${importId}.csv`;
      }

      await deleteImportFile(storageLocation, IS_CLOUD && r2Storage.isEnabled());
    } catch (fileError) {
      // Log the error but don't fail the deletion - the file might not exist
      console.warn(`Failed to delete import file for ${importId}:`, fileError);
    }

    // Delete events from ClickHouse that were imported with this importId
    // This is a critical operation - if it fails, we fail the entire deletion
    try {
      await clickhouse.command({
        query: `DELETE FROM events WHERE import_id = {importId:String} AND site_id = {siteId:UInt16}`,
        query_params: {
          importId: importId,
          siteId: Number(site),
        },
      });
      console.log(`Deleted events for import ${importId} from ClickHouse`);
    } catch (chError) {
      console.error(`Failed to delete ClickHouse events for ${importId}:`, chError);
      return reply.status(500).send({
        error: "Failed to delete imported events from database",
      });
    }

    // Delete the import record from the database
    try {
      await ImportStatusManager.deleteImport(importId);
    } catch (dbError) {
      console.error(`Failed to delete import record ${importId}:`, dbError);
      return reply.status(500).send({
        error: "Import events deleted but failed to remove import record",
      });
    }

    return reply.send({
      data: {
        message: "Import deleted successfully",
      },
    });
  } catch (error) {
    console.error("Error deleting import:", error);
    return reply.status(500).send({ error: "Internal server error" });
  }
}
