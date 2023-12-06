import {
  Activity,
  Events,
  GftpStorageProvider,
  Logger,
  Package,
  StorageProvider,
  WorkContext,
  Worker,
  Yagna,
  AgreementPoolService,
  MarketService,
  PaymentService,
} from "@golem-sdk/golem-js";
import { YagnaApi } from "@golem-sdk/golem-js/dist/utils";

import AsyncLock from "async-lock";
import debug from "debug";
import EventEmitter from "events";

const createLogger = (ns: string, level = "info"): Logger => {
  const log = debug(ns);

  const levelMap: Record<string, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    log: 20,
  };

  const sev = levelMap[level];

  if (sev === undefined) {
    throw new Error(`Invalid log level ${level}`);
  }

  return {
    level,
    setLevel: (newLevel: string) => (level = newLevel),
    log: (msg) => log(msg),
    info: (msg) => log(msg),
    warn: (msg) => log(msg),
    error: (msg) => log(msg),
    debug: (msg) => log(msg),
  };
};

export interface GolemConfig {
  /** Number of concurrent OCRs to buy on the market */
  replicas: number;

  /** How long you want to rent the resources in hours */
  duration: number;

  /** What's the desired hourly rate spend in GLM/hour */
  price: number;

  spec: Partial<{
    minCpu: number;
    maxCpu: number;
    minMemGib: number;
    maxMemGib: number;
    minStorageGib: number;
    maxStorageGib: number;
  }>;
}

export class Golem extends EventEmitter {
  private yagna: Yagna;
  private api: YagnaApi;

  private agreementService: AgreementPoolService;
  private marketService: MarketService;
  private paymentService: PaymentService;
  private activity?: Activity;
  private storageProvider: StorageProvider;

  /**
   * Used to synchronize command executions in activities
   *
   * @private
   */
  private lock = new AsyncLock();

  /**
   * Used to listen to relevant events and broadcast them to the client code
   */
  private eventTarget: EventTarget = new EventTarget();

  /**
   * Converts the user specified duration in hours into milliseconds
   */
  private getExpectedDurationSeconds() {
    return this.config.duration * 60 * 60;
  }

  /**
   * Estimates the spec and duration to create an allocation
   */
  private getBudgetEstimate() {
    const { duration, price } = this.config;
    const { minCpu } = this.config.spec;

    const min = duration * price * (minCpu || 1);

    return min;
  }

  constructor(private config: GolemConfig) {
    super();

    this.eventTarget = new EventTarget();

    // FIXME: This internally allocates resources like connections, which also have to be cleaned up
    this.yagna = new Yagna();
    this.api = this.yagna.getApi();

    this.agreementService = new AgreementPoolService(this.api, {
      logger: createLogger("golem:agreement"),
      eventTarget: this.eventTarget,
    });

    // Expiration 5-30 min, no additional requirements
    // Expiration 30min-10h, at least debit note acceptance
    // Expiration 10h+ mid-agreement payments required

    this.marketService = new MarketService(this.agreementService, this.api, {
      expirationSec: this.getExpectedDurationSeconds(),
      logger: createLogger("golem:market"),
      debitNotesAcceptanceTimeoutSec: 60,
      midAgreementPaymentTimeoutSec: 60 * 60, // Testing hourly payments
    });

    // TODO: The amount to allocate should not be set in the constructor :(
    // TODO: In general, all the situations where we share too much from the constructor like in case of that allocation
    //  should be removed in 1.0
    this.paymentService = new PaymentService(this.api, {
      logger: createLogger("golem:payment"),
    });

    // FIXME: This internally allocates resources like child processes
    this.storageProvider = new GftpStorageProvider();

    this.mountEvents();
  }

  async start() {
    const allocation = await this.paymentService.createAllocation({
      budget: this.getBudgetEstimate(),
      expires: this.getExpectedDurationSeconds() * 1000,
    });

    // TODO: WORKLOAD!
    const workload = Package.create({
      imageTag: "golem/tesseract:latest",
      minMemGib: this.config.spec.minMemGib,
      minCpuCores: this.config.spec.minCpu,
      minCpuThreads: this.config.spec.minCpu,
      minStorageGib: this.config.spec.minStorageGib,
    });

    await Promise.all([
      this.agreementService.run(),
      // TODO: I should be able to start the service, but pass the workload and allocation later - market.postDemand(???)
      this.marketService.run(workload, allocation),
      this.paymentService.run(),
    ]);

    const agreement = await this.agreementService.getAgreement();
    await this.marketService.end();

    // console.log("Full agreement", util.inspect(agreement, false, 5, true));

    this.paymentService.acceptPayments(agreement);
    this.paymentService.acceptDebitNotes(agreement.id); // TODO: Why is this different?

    this.activity = await Activity.create(agreement, this.api);
  }

  async sendTask<T>(task: Worker<T>): Promise<T | undefined> {
    if (this.activity) {
      try {
        const { activity } = this;

        const crit = async () => {
          // const state = await activity.getState();
          //
          // if (state !== ActivityStateEnum.Ready) {
          //   console.error("The activity is not in Ready state, can't execute that task");
          //   return
          // }

          const ctx = new WorkContext(activity, {
            storageProvider: this.storageProvider,
          });
          await ctx.before();
          const res = await task(ctx);
          //await ctx.after(); // FIXME: LOL?
          return res;
        };

        /**
         * It's not possible to execute commands in an activity in parallel, thus we need to synchronize a critical section
         */
        const runExclusivelyOnActivity = <T>(
          criticalSection: () => Promise<T>,
        ): Promise<T> =>
          new Promise<T>((resolve, reject) => {
            this.lock.acquire<T>(
              `activity-${activity.id}`,
              criticalSection,
              (err, res) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(res as T); // FIXME...
                }
              },
            );
          });

        const result = await runExclusivelyOnActivity(crit);
        return result;
      } catch (err) {
        console.error(err, "Running the task on Golem failed with this error");
        throw err;
      }
    } else {
      console.error("There is no activity which can process the task");
    }
  }

  async stop() {
    if (this.activity) {
      await this.activity.stop();
    }

    await this.paymentService.end();
    await this.marketService.end();
    await this.agreementService.end();

    // Cleanup resource allocations which are not inherently visible in the constructor
    await this.storageProvider.close();
    await this.yagna.end();
  }

  async getCostInfo() {
    // NotImplemented -> stat service works on events, while this can be part of the aggregate itself...
  }

  private mountEvents() {
    this.eventTarget.addEventListener("GolemEvent", (golemEvent) => {
      if (golemEvent instanceof Events.AgreementTerminated) {
        this.emit("closed", golemEvent.detail.reason);
      }
    });
  }
}
