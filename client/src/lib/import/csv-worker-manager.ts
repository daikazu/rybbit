import Papa from "papaparse";
import { DateTime } from "luxon";
import type { UmamiEvent } from "./types";

const BATCH_SIZE = 5000;

const umamiHeaders = [
  undefined,
  "session_id",
  undefined,
  undefined,
  "hostname",
  "browser",
  "os",
  "device",
  "screen",
  "language",
  "country",
  "region",
  "city",
  "url_path",
  "url_query",
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  "referrer_path",
  "referrer_query",
  "referrer_domain",
  "page_title",
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  "event_type",
  "event_name",
  undefined,
  "distinct_id",
  "created_at",
  undefined,
];

export class CSVWorkerManager {
  private aborted = false;
  private uploadInProgress = false;
  private parsingComplete = false;
  private quotaExceeded = false;
  private siteId: number = 0;
  private importId: string = "";

  private currentBatch: UmamiEvent[] = [];
  private earliestAllowedDate: DateTime | null = null;
  private latestAllowedDate: DateTime | null = null;

  startImport(
    file: File,
    siteId: number,
    importId: string,
    earliestAllowedDate: string,
    latestAllowedDate: string
  ): void {
    this.siteId = siteId;
    this.importId = importId;

    this.earliestAllowedDate = DateTime.fromFormat(earliestAllowedDate, "yyyy-MM-dd", { zone: "utc" }).startOf("day");
    this.latestAllowedDate = DateTime.fromFormat(latestAllowedDate, "yyyy-MM-dd", { zone: "utc" }).endOf("day");

    if (!this.earliestAllowedDate.isValid) {
      this.handleError(`Invalid earliest allowed date: ${earliestAllowedDate}`);
      return;
    }

    if (!this.latestAllowedDate.isValid) {
      this.handleError(`Invalid latest allowed date: ${latestAllowedDate}`);
      return;
    }

    Papa.parse<UmamiEvent>(file, {
      worker: true,
      header: true,
      skipEmptyLines: "greedy",
      step: results => {
        if (this.aborted || this.quotaExceeded) return;

        if (results.data) {
          this.handleParsedRow(results.data);
        }
      },
      complete: () => {
        if (this.aborted) return;
        this.handleParseComplete();
      },
      error: error => {
        if (this.aborted) return;
        this.handleError(error.message);
      },
    });
  }

  private isDateInRange(dateStr: string): boolean {
    const createdAt = DateTime.fromFormat(dateStr, "yyyy-MM-dd HH:mm:ss", { zone: "utc" });
    if (!createdAt.isValid) {
      return false;
    }

    if (this.earliestAllowedDate && createdAt < this.earliestAllowedDate) {
      return false;
    }

    if (this.latestAllowedDate && createdAt > this.latestAllowedDate) {
      return false;
    }

    return true;
  }

  private handleParsedRow(row: unknown): void {
    const rawEvent = row as Record<string, unknown>;

    const umamiEvent: UmamiEvent = {
      session_id: String(rawEvent.session_id || ""),
      hostname: String(rawEvent.hostname || ""),
      browser: String(rawEvent.browser || ""),
      os: String(rawEvent.os || ""),
      device: String(rawEvent.device || ""),
      screen: String(rawEvent.screen || ""),
      language: String(rawEvent.language || ""),
      country: String(rawEvent.country || ""),
      region: String(rawEvent.region || ""),
      city: String(rawEvent.city || ""),
      url_path: String(rawEvent.url_path || ""),
      url_query: String(rawEvent.url_query || ""),
      referrer_path: String(rawEvent.referrer_path || ""),
      referrer_query: String(rawEvent.referrer_query || ""),
      referrer_domain: String(rawEvent.referrer_domain || ""),
      page_title: String(rawEvent.page_title || ""),
      event_type: String(rawEvent.event_type || ""),
      event_name: String(rawEvent.event_name || ""),
      distinct_id: String(rawEvent.distinct_id || ""),
      created_at: String(rawEvent.created_at || ""),
    };

    // Skip rows with missing created_at (required field)
    if (!umamiEvent.created_at) {
      return;
    }

    // Apply quota-based date range filter
    if (!this.isDateInRange(umamiEvent.created_at)) {
      return;
    }

    // Add to batch
    this.currentBatch.push(umamiEvent);

    // Send batch when it reaches chunk size
    if (this.currentBatch.length >= BATCH_SIZE) {
      this.sendBatch(false);
    }
  }

  private sendBatch(isLastBatch: boolean): void {
    if (this.currentBatch.length > 0) {
      const batch = this.currentBatch;
      this.currentBatch = [];
      this.uploadBatch(batch, isLastBatch);
    } else if (isLastBatch) {
      // No events in final batch, send empty batch with finalization
      this.uploadBatch([], isLastBatch);
    }
  }

  private handleParseComplete(): void {
    this.parsingComplete = true;

    // Send final batch with finalization flag
    this.sendBatch(true);

    // If nothing to upload, check completion immediately
    if (!this.uploadInProgress) {
      this.checkCompletion();
    }
  }

  private handleError(message: string): void {
    console.error("CSV Import Error:", message);
    this.terminate();
  }

  private async uploadBatch(events: UmamiEvent[], isLastBatch: boolean): Promise<void> {
    // Don't upload if quota exceeded
    if (this.quotaExceeded) {
      return;
    }

    // Skip empty batches unless it's the last one (needed for finalization)
    if (events.length === 0 && !isLastBatch) {
      return;
    }

    this.uploadInProgress = true;

    try {
      const response = await fetch(`/api/batch-import-events/${this.siteId}/${this.importId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          events,
          isLastBatch,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();

      // Check if quota was exceeded
      if (data.quotaExceeded) {
        this.quotaExceeded = true;
        this.aborted = true; // Stop parsing
        console.log("Import completed with quota limits:", data.message);
        return;
      }
    } catch (error) {
      // Critical failure - network error, server error, etc.
      console.error("Upload failed:", error instanceof Error ? error.message : "Unknown error");
      this.terminate();
      return;
    } finally {
      this.uploadInProgress = false;
    }

    // Check if we're done
    this.checkCompletion();
  }

  private checkCompletion(): void {
    if (this.parsingComplete && !this.uploadInProgress && !this.quotaExceeded) {
      console.log("Import completed successfully");
    }
  }

  terminate(): void {
    this.aborted = true;
  }
}
