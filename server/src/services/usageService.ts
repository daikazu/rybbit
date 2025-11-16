import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import * as cron from "node-cron";
import { processResults } from "../api/analytics/utils.js";
import { clickhouse } from "../db/clickhouse/clickhouse.js";
import { db } from "../db/postgres/postgres.js";
import { member, organization, sites, user } from "../db/postgres/schema.js";
import { IS_CLOUD } from "../lib/const.js";
import { sendLimitExceededEmail } from "../lib/email/email.js";
import { createServiceLogger } from "../lib/logger/logger.js";
import { getBestSubscription } from "../lib/subscriptionUtils.js";

class UsageService {
  private sitesOverLimit = new Set<number>();
  private usageCheckTask: cron.ScheduledTask | null = null;
  private logger = createServiceLogger("usage-checker");

  constructor() {
    this.initializeUsageCheckCron();
  }

  /**
   * Initialize the cron job for checking monthly usage
   */
  private initializeUsageCheckCron() {
    if (IS_CLOUD && process.env.NODE_ENV !== "development") {
      // Schedule the monthly usage checker to run every 30 minutes
      this.usageCheckTask = cron.schedule(
        "*/30 * * * *",
        async () => {
          try {
            await this.updateOrganizationsMonthlyUsage();
          } catch (error) {
            this.logger.error(error as Error, "Error during usage check");
          }
        },
        { timezone: "UTC" }
      );

      // Run immediately on startup
      this.updateOrganizationsMonthlyUsage();

      this.logger.info("Monthly usage check cron initialized (runs every 30 minutes)");
    }
  }

  /**
   * Gets the set of site IDs that are over their monthly limit
   */
  public getSitesOverLimit(): Set<number> {
    return this.sitesOverLimit;
  }

  /**
   * Checks if a site is over its monthly limit
   */
  public isSiteOverLimit(siteId: number): boolean {
    return this.sitesOverLimit.has(siteId);
  }

  /**
   * Gets the first day of the current month in YYYY-MM-DD format using Luxon
   */
  private getStartOfMonth(): string {
    return DateTime.now().startOf("month").toISODate() as string;
  }

  /**
   * Gets the emails of all organization owners
   */
  private async getOrganizationOwnerEmails(organizationId: string): Promise<string[]> {
    try {
      const owners = await db
        .select({
          email: user.email,
        })
        .from(member)
        .innerJoin(user, eq(member.userId, user.id))
        .where(and(eq(member.organizationId, organizationId), eq(member.role, "owner")));

      return owners.map(owner => owner.email);
    } catch (error) {
      this.logger.error(error as Error, `Error getting owner emails for organization ${organizationId}`);
      return [];
    }
  }

  /**
   * Gets all site IDs for an organization
   */
  private async getSiteIdsForOrganization(organizationId: string): Promise<number[]> {
    try {
      const siteRecords = await db
        .select({ siteId: sites.siteId })
        .from(sites)
        .where(eq(sites.organizationId, organizationId));

      return siteRecords.map(record => record.siteId);
    } catch (error) {
      this.logger.error(error as Error, `Error getting sites for organization ${organizationId}`);
      return [];
    }
  }

  /**
   * Gets event limit and billing period start date for an organization based on their best subscription.
   * Checks both AppSumo and Stripe subscriptions and uses the one with the higher event limit.
   * @returns [eventLimit, periodStartDate]
   */
  private async getOrganizationSubscriptionInfo(orgData: {
    id: string;
    stripeCustomerId: string | null;
    createdAt: string;
    name: string;
  }): Promise<[number, string | null]> {
    // Special case for specific organizations
    if (orgData.name === "tomato 2" || orgData.name === "Zam") {
      return [Infinity, this.getStartOfMonth()];
    }

    // Get the best subscription (highest event limit from AppSumo or Stripe)
    const subscription = await getBestSubscription(orgData.id, orgData.stripeCustomerId);

    // Log subscription details
    if (subscription.source === "appsumo") {
      this.logger.info(
        `Organization ${orgData.name} using AppSumo ${subscription.planName} with ${subscription.eventLimit} events/month`
      );
    } else if (subscription.source === "stripe") {
      this.logger.info(
        `Organization ${orgData.name} using Stripe ${subscription.planName} (${subscription.interval}) with ${subscription.eventLimit} events/month`
      );
    } else {
      this.logger.info(`Organization ${orgData.name} on free tier with ${subscription.eventLimit} events/month`);
    }

    return [subscription.eventLimit, subscription.periodStart];
  }

  /**
   * Gets monthly event count from ClickHouse for the given site IDs
   * Sites with ID < 2000 are grandfathered in and only count pageviews
   * Sites with ID >= 2000 count all event types (pageview, custom_event, performance)
   */
  private async getMonthlyEventCount(siteIds: number[], startDate: string | null): Promise<number> {
    if (!siteIds.length) {
      return 0;
    }

    // If no startDate is provided (e.g., no subscription), default to start of month
    const periodStart = startDate || this.getStartOfMonth();

    // Split sites into grandfathered (< 2000) and new (>= 2000)
    const grandfatheredSites = siteIds.filter(id => id < 2000);
    const newSites = siteIds.filter(id => id >= 2000);

    try {
      let totalCount = 0;

      // Count pageviews only for grandfathered sites
      if (grandfatheredSites.length > 0) {
        const grandfatheredResult = await clickhouse.query({
          query: `
            SELECT COUNT(*) as count
            FROM events
            WHERE site_id IN {siteIds:Array(Int32)} AND type = 'pageview'
            AND timestamp >= toDate({periodStart:String})
          `,
          format: "JSONEachRow",
          query_params: {
            siteIds: grandfatheredSites,
            periodStart: periodStart,
          },
        });
        const grandfatheredRows = await processResults<{ count: string }>(grandfatheredResult);
        totalCount += parseInt(grandfatheredRows[0].count, 10);
      }

      // Count all events (pageview, custom_event, performance) for new sites
      if (newSites.length > 0) {
        const newSitesResult = await clickhouse.query({
          query: `
            SELECT COUNT(*) as count
            FROM events
            WHERE site_id IN {siteIds:Array(Int32)}
            AND type IN ('pageview', 'custom_event', 'performance')
            AND timestamp >= toDate({periodStart:String})
          `,
          format: "JSONEachRow",
          query_params: {
            siteIds: newSites,
            periodStart: periodStart,
          },
        });
        const newSitesRows = await processResults<{ count: string }>(newSitesResult);
        totalCount += parseInt(newSitesRows[0].count, 10);
      }

      return totalCount;
    } catch (error) {
      this.logger.error(error as Error, `Error querying ClickHouse for events for sites ${siteIds}`);
      return 0;
    }
  }

  /**
   * Updates monthly event usage for all organizations
   */
  public async updateOrganizationsMonthlyUsage(): Promise<void> {
    this.logger.info("Starting check of monthly event usage for organizations...");

    try {
      // Get all organizations (both with and without Stripe customer IDs)
      const organizations = await db
        .select({
          id: organization.id,
          name: organization.name,
          stripeCustomerId: organization.stripeCustomerId,
          createdAt: organization.createdAt,
          overMonthlyLimit: organization.overMonthlyLimit,
        })
        .from(organization);

      for (const orgData of organizations) {
        try {
          // Get site IDs for this organization
          const siteIds = await this.getSiteIdsForOrganization(orgData.id);

          // If organization has no sites, continue to next organization
          if (!siteIds.length) {
            continue;
          }

          // Get organization's subscription information (limit and period start)
          const [eventLimit, periodStart] = await this.getOrganizationSubscriptionInfo(orgData);

          // Get monthly event count from ClickHouse using the billing period start date
          const eventCount = await this.getMonthlyEventCount(siteIds, periodStart);

          // Check if over limit and update global set
          const isOverLimit = eventCount > eventLimit;
          const wasOverLimit = orgData.overMonthlyLimit ?? false;

          // Update organization's monthlyEventCount and overMonthlyLimit fields
          await db
            .update(organization)
            .set({
              monthlyEventCount: eventCount,
              overMonthlyLimit: isOverLimit,
            })
            .where(eq(organization.id, orgData.id));

          // Send email notification if transitioning from under limit to over limit
          if (isOverLimit && !wasOverLimit) {
            const ownerEmails = await this.getOrganizationOwnerEmails(orgData.id);

            // Send email to all owners if found
            if (ownerEmails.length > 0) {
              for (const ownerEmail of ownerEmails) {
                try {
                  await sendLimitExceededEmail(ownerEmail, orgData.name, eventCount, eventLimit);
                  this.logger.info(`Sent limit exceeded email to owner ${ownerEmail} for organization ${orgData.name}`);
                } catch (error) {
                  this.logger.error(
                    error as Error,
                    `Failed to send limit exceeded email to owner ${ownerEmail} for organization ${orgData.name}`
                  );
                }
              }
            } else {
              this.logger.warn(`No owners found for organization ${orgData.name}, skipping limit exceeded email`);
            }
          }

          // If over the limit, add all this organization's sites to the global set
          if (isOverLimit) {
            for (const siteId of siteIds) {
              this.sitesOverLimit.add(siteId);
            }
            this.logger.info(
              `Organization ${orgData.name} is over limit. Added ${siteIds.length} sites to blocked list.`
            );
          } else {
            for (const siteId of siteIds) {
              this.sitesOverLimit.delete(siteId);
            }
          }

          // Format additional date info for logging if available
          const periodInfo = periodStart ? `period started ${periodStart}` : "this month";

          this.logger.info(
            `Updated organization ${
              orgData.name
            }: ${eventCount.toLocaleString()} events, limit ${eventLimit.toLocaleString()}, ${periodInfo}`
          );
        } catch (error) {
          this.logger.error(error as Error, `Error processing organization ${orgData.id}`);
        }
      }

      this.logger.info(`Completed monthly event usage check. ${this.sitesOverLimit.size} sites are over their limit.`);
    } catch (error) {
      this.logger.error(error as Error, "Error updating monthly usage");
    }
  }

  /**
   * Method to stop the usage check cron job (useful for graceful shutdown)
   */
  public stopUsageCheckCron() {
    if (this.usageCheckTask) {
      this.usageCheckTask.stop();
      this.logger.info("Monthly usage check cron stopped");
    }
  }
}

// Create a singleton instance
export const usageService = new UsageService();
