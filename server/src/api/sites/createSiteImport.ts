import { FastifyReply, FastifyRequest } from "fastify";
import { getUserHasAdminAccessToSite } from "../../lib/auth-utils.js";
import { ImportLimiter } from "../../services/import/importLimiter.js";
import { ImportQuotaTracker } from "../../services/import/importQuotaChecker.js";
import { db } from "../../db/postgres/postgres.js";
import { sites } from "../../db/postgres/schema.js";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { z } from "zod";

const createSiteImportRequestSchema = z
  .object({
    params: z.object({
      site: z.string().min(1),
    }),
    body: z.object({
      platform: z.enum(["umami"]),
      fileName: z.string().min(1),
    }),
  })
  .strict();

type CreateSiteImportRequest = {
  Params: z.infer<typeof createSiteImportRequestSchema.shape.params>;
  Body: z.infer<typeof createSiteImportRequestSchema.shape.body>;
};

export async function createSiteImport(request: FastifyRequest<CreateSiteImportRequest>, reply: FastifyReply) {
  try {
    const parsed = createSiteImportRequestSchema.safeParse({
      params: request.params,
      body: request.body,
    });

    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation error", details: parsed.error });
    }

    const { site } = parsed.data.params;
    const { platform, fileName } = parsed.data.body;
    const siteId = Number(site);

    // Check user authorization
    const userHasAccess = await getUserHasAdminAccessToSite(request, site);
    if (!userHasAccess) {
      return reply.status(403).send({ error: "Forbidden" });
    }

    // Get site's organization ID
    const [siteRecord] = await db
      .select({ organizationId: sites.organizationId })
      .from(sites)
      .where(eq(sites.siteId, siteId))
      .limit(1);

    if (!siteRecord) {
      return reply.status(404).send({ error: "Site not found" });
    }

    // Create import record with concurrency check
    const importResult = await ImportLimiter.createImportWithConcurrencyCheck({
      siteId,
      organizationId: siteRecord.organizationId,
      platform,
      fileName,
      status: "pending",
      importedEvents: 0,
      errorMessage: null,
    });

    if (!importResult.success) {
      return reply.status(429).send({ error: importResult.reason });
    }

    // Get quota information to determine allowed date ranges
    const quotaTracker = await ImportQuotaTracker.create(siteRecord.organizationId);
    const summary = quotaTracker.getSummary();

    // Calculate the earliest and latest allowed dates
    const oldestAllowedDate = DateTime.fromFormat(summary.oldestAllowedMonth + "01", "yyyyMMdd", { zone: "utc" });
    const earliestAllowedDate = oldestAllowedDate.toFormat("yyyy-MM-dd");
    const latestAllowedDate = DateTime.utc().toFormat("yyyy-MM-dd");

    return reply.send({
      data: {
        importId: importResult.importId,
        allowedDateRange: {
          earliestAllowedDate,
          latestAllowedDate,
          historicalWindowMonths: summary.totalMonthsInWindow,
        },
      },
    });
  } catch (error) {
    console.error("Error creating import:", error);
    return reply.status(500).send({ error: "Internal server error" });
  }
}
