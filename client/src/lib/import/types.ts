// Types for client-side CSV import system
// Client parses CSV, server transforms and validates

// Allowed date range for imports based on subscription tier
export interface AllowedDateRange {
  earliestAllowedDate: string; // yyyy-MM-dd format
  latestAllowedDate: string; // yyyy-MM-dd format
  historicalWindowMonths: number; // 6, 24, or 60
}

export interface UmamiEvent {
  session_id: string;
  hostname: string;
  browser: string;
  os: string;
  device: string;
  screen: string;
  language: string;
  country: string;
  region: string;
  city: string;
  url_path: string;
  url_query: string;
  referrer_path: string;
  referrer_query: string;
  referrer_domain: string;
  page_title: string;
  event_type: string;
  event_name: string;
  distinct_id: string;
  created_at: string;
}

// Worker message types
export type WorkerMessageToWorker =
  | {
      type: "PARSE_START";
      file: File;
      siteId: number;
      importId: string;
      platform: "umami";
      earliestAllowedDate: string; // Filter events before this date (yyyy-MM-dd)
      latestAllowedDate: string; // Filter events after this date (yyyy-MM-dd)
      startDate?: string; // Optional user-specified start date filter
      endDate?: string; // Optional user-specified end date filter
    }
  | {
      type: "CANCEL";
    };

export type WorkerMessageToMain =
  | {
      type: "PROGRESS";
      parsed: number;
      skipped: number;
      errors: number;
    }
  | {
      type: "CHUNK_READY";
      events: UmamiEvent[]; // Raw CSV rows, not transformed
      chunkIndex: number;
    }
  | {
      type: "COMPLETE";
      totalParsed: number;
      totalSkipped: number;
      totalErrors: number;
      errorDetails: Array<{ row: number; message: string }>;
    }
  | {
      type: "ERROR";
      message: string;
      error?: unknown;
    };

// Batch import request (client sends raw rows to server)
export interface BatchImportRequest {
  events: UmamiEvent[]; // Raw Umami CSV rows
  importId: string;
  batchIndex: number;
  totalBatches: number;
}

// Batch import response
export interface BatchImportResponse {
  success: boolean;
  importedCount: number;
  message?: string;
  error?: string;
}

// Import progress tracking
export interface ImportProgress {
  status: "idle" | "parsing" | "uploading" | "completed" | "failed";
  totalRows: number;
  parsedRows: number;
  skippedRows: number;
  uploadedBatches: number;
  totalBatches: number;
  failedBatches: number;
  importedEvents: number;
  errors: Array<{ batch?: number; message: string }>;
}

// Failed batch info for retry
export interface FailedBatch {
  batchIndex: number;
  events: UmamiEvent[]; // Raw rows, not transformed
  error: string;
  retryCount: number;
}
