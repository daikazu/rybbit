import { Job, Queue, QueueEvents, Worker } from "bullmq";
import { IJobQueue } from "../jobQueue.js";
import { CSV_PARSE_QUEUE, DATA_INSERT_QUEUE } from "../../workers/jobs.js";
import { createCsvParseWorker } from "../../workers/csvParseWorker.js";
import { createDataInsertWorker } from "../../workers/dataInsertWorker.js";
import { createServiceLogger } from "../../../../lib/logger/logger.js";

const logger = createServiceLogger("import:bullmq");

export class BullMQAdapter implements IJobQueue {
  private readonly connection: { host: string; port: number; password?: string };
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private queueEvents: Map<string, QueueEvents> = new Map();
  private ready: boolean = false;

  constructor() {
    this.connection = {
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      ...(process.env.REDIS_PASSWORD && { password: process.env.REDIS_PASSWORD }),
    };
  }

  async start(): Promise<void> {
    try {
      await this.createQueue(CSV_PARSE_QUEUE);
      await this.createQueue(DATA_INSERT_QUEUE);

      await createCsvParseWorker(this);
      await createDataInsertWorker(this);

      this.ready = true;
      logger.info("Started successfully");
    } catch (error) {
      this.ready = false;
      logger.error({ error }, "Failed to initialize");
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping...");
    const errors: Error[] = [];

    // Close all workers first
    const workerResults = await Promise.allSettled(Array.from(this.workers.values()).map(worker => worker.close()));
    workerResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const workerName = Array.from(this.workers.keys())[index];
        const error = new Error(`Failed to close worker ${workerName}: ${result.reason}`);
        errors.push(error);
        logger.error({ workerName, error: result.reason }, error.message);
      }
    });
    this.workers.clear();

    // Close all queue events
    const queueEventsResults = await Promise.allSettled(Array.from(this.queueEvents.values()).map(qe => qe.close()));
    queueEventsResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const queueName = Array.from(this.queueEvents.keys())[index];
        const error = new Error(`Failed to close queue events for ${queueName}: ${result.reason}`);
        errors.push(error);
        logger.error({ queueName, error: result.reason }, error.message);
      }
    });
    this.queueEvents.clear();

    // Close all queues (this closes their Redis connections)
    const queueResults = await Promise.allSettled(Array.from(this.queues.values()).map(queue => queue.close()));
    queueResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const queueName = Array.from(this.queues.keys())[index];
        const error = new Error(`Failed to close queue ${queueName}: ${result.reason}`);
        errors.push(error);
        logger.error({ queueName, error: result.reason }, error.message);
      }
    });
    this.queues.clear();

    if (errors.length > 0) {
      const aggregatedError = new Error(
        `BullMQ stop encountered ${errors.length} error(s): ${errors.map(e => e.message).join("; ")}`
      );
      logger.error({ errorCount: errors.length }, "Stopped with errors");
      throw aggregatedError;
    }

    logger.info("Stopped successfully");
  }

  async createQueue(queueName: string): Promise<void> {
    if (!this.queues.has(queueName)) {
      let queue: Queue | undefined;
      let queueEvents: QueueEvents | undefined;

      try {
        queue = new Queue(queueName, {
          connection: this.connection,
          defaultJobOptions: {
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        });

        this.queues.set(queueName, queue);

        queueEvents = new QueueEvents(queueName, {
          connection: this.connection,
        });

        this.queueEvents.set(queueName, queueEvents);

        queueEvents.on("completed", ({ jobId }) => {
          logger.debug({ jobId, queueName }, "Job completed");
        });

        queueEvents.on("failed", ({ jobId, failedReason }) => {
          logger.error({ jobId, queueName, failedReason }, "Job failed");
        });
      } catch (error) {
        logger.error({ queueName, error }, "Failed to create queue");

        const cleanupPromises: Promise<void>[] = [];

        if (queueEvents) {
          this.queueEvents.delete(queueName);
          cleanupPromises.push(
            queueEvents.close().catch(closeError => {
              logger.error({ queueName, error: closeError }, "Failed to close queue events during cleanup");
            })
          );
        }

        if (queue) {
          this.queues.delete(queueName);
          cleanupPromises.push(
            queue.close().catch(closeError => {
              logger.error({ queueName, error: closeError }, "Failed to close queue during cleanup");
            })
          );
        }

        await Promise.all(cleanupPromises);

        throw error;
      }
    }
  }

  async send<T>(queueName: string, data: T): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found. Call createQueue first.`);
    }

    try {
      await queue.add(queueName, data);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ queueName, error }, "Failed to enqueue job");
      throw new Error(`Failed to enqueue job to ${queueName}: ${errorMessage}`);
    }
  }

  async work<T>(queueName: string, handler: (job: T) => Promise<void>): Promise<void> {
    try {
      const worker = new Worker(
        queueName,
        async (job: Job<T>) => {
          await handler(job.data);
        },
        {
          connection: this.connection,
          concurrency: 1,
        }
      );

      worker.on("error", error => {
        logger.error({ queueName, error }, "Worker error");
      });

      worker.on("failed", (job, error) => {
        logger.error({ queueName, jobId: job?.id, error }, "Job failed");
      });

      this.workers.set(queueName, worker);
    } catch (error) {
      logger.error({ queueName, error }, "Failed to create worker");
      throw error;
    }
  }

  isReady(): boolean {
    return this.ready;
  }
}
