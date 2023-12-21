import {
  Activity,
  ActivityStateEnum,
  AgreementPoolService,
  GftpStorageProvider,
  MarketService,
  Package,
  PaymentService,
  ProposalFilter,
  StorageProvider,
  WorkContext,
  Worker,
  Yagna,
} from "@golem-sdk/golem-js";
import { createLogger } from "./logging";

// TODO: All the things dragged from `dist` should be exported from the main definition file
import { YagnaApi } from "@golem-sdk/golem-js/dist/utils";
import { Proposal } from "@golem-sdk/golem-js/dist/market";

import genericPool from "generic-pool";
import debug, { Debugger } from "debug";

export interface GolemConfig {
  /**
   * Specification of how long you want to rent the compute resources for
   *
   * These parameters will be used to find the providers matching your pricing criteria, estimate and allocate GLM budget for the operations.
   */
  market: {
    /** How long you want to rent the resources in hours */
    rentHours: number;
    /** What's the desired hourly rate spend in GLM/hour */
    priceGlmPerHour: number;
  };

  /**
   * Represents the deployment configuration for a service on Golem Network
   */
  deploy: {
    /** How many instances of that service you want to have at maximum, given the idle ones will be freed to control costs  */
    maxReplicas: number;

    /** Specify the computation resource criteria to filter offers on the Golem Network */
    resources: Partial<{
      /** The minimum CPU requirement for each service instance. */
      minCpu: number;
      //TODO: maxCpu: number;
      /* The minimum memory requirement (in Gibibyte) for each service instance. */
      minMemGib: number;
      // TODO: maxMemGib: number;
      /** The minimum storage requirement (in Gibibyte) for each service instance. */
      minStorageGib: number;
      // TODO: maxStorageGib: number;
    }>;

    /** The time interval (in seconds) between checks to release unused resources. */
    downscaleIntervalSec: number;
  };

  /** Number of seconds to wait for the Golem component to initialize (be ready to accept requests and order resources on Golem Network) */
  initTimeoutSec: number;

  /**
   * Number of seconds to wait for a request to start
   *
   * This value has to consider time for a fresh replica to be added before the request is sent to one.
   */
  requestStartTimeoutSec: number;

  /**
   * Golem Node's (yagna) API related config params.
   */
  api?: {
    /**
     * The URL to `yagna` API
     *
     * It can be provided via the `GOLEM_API_URL` environment variable.
     *
     * Defaults to `http://localhost:7465/`
     */
    url?: string;

    /**
     * The API key that your script will use to contact `yagna`
     *
     * You can obtain this from `yagna app-key list` command.
     */
    key: string;
  };
}

export class Golem {
  private readonly yagna: Yagna;
  private readonly api: YagnaApi;

  private readonly agreementService: AgreementPoolService;
  private readonly marketService: MarketService;
  private readonly paymentService: PaymentService;
  private readonly storageProvider: StorageProvider;

  private activityPool: genericPool.Pool<Activity>;

  private readonly logger: Debugger;

  private config: GolemConfig;

  constructor(config: GolemConfig) {
    this.logger = debug("golem");

    this.config = config;

    // FIXME: This internally allocates resources like connections, which also have to be cleaned up
    this.yagna = new Yagna({
      apiKey: this.config.api?.key ?? process.env["GOLEM_API_KEY"],
      basePath:
        this.config.api?.url ??
        process.env["GOLEM_API_URL"] ??
        "http://localhost:7465",
    });
    // TODO: Payment driver?

    this.api = this.yagna.getApi();

    this.agreementService = new AgreementPoolService(this.api, {
      logger: createLogger("golem-js:agreement"),
    });

    this.marketService = new MarketService(this.agreementService, this.api, {
      expirationSec: this.getExpectedDurationSeconds(),
      logger: createLogger("golem-js:market"),
      proposalFilter: this.buildProposalFilter(),
    });

    // TODO: The amount to allocate should not be set in the constructor :(
    // TODO: In general, all the situations where we share too much from the constructor like in case of that allocation
    //  should be removed in 1.0
    this.paymentService = new PaymentService(this.api, {
      logger: createLogger("golem-js:payment"),
      payment: {
        network: process.env["GOLEM_PAYMENT_NETWORK"] ?? "goerli",
      },
    });

    // FIXME: This internally allocates resources like child processes
    this.storageProvider = new GftpStorageProvider();

    this.activityPool = this.buildActivityPool();
  }

  async start() {
    const allocation = await this.paymentService.createAllocation({
      budget: this.getBudgetEstimate(),
      expires: this.getExpectedDurationSeconds() * 1000,
    });

    // TODO: WORKLOAD!
    const workload = Package.create({
      imageTag: "golem/tesseract:latest",
      minMemGib: this.config.deploy.resources.minMemGib,
      minCpuCores: this.config.deploy.resources.minCpu,
      minCpuThreads: this.config.deploy.resources.minCpu,
      minStorageGib: this.config.deploy.resources.minStorageGib,
      logger: createLogger("golem-js:package"),
    });

    await Promise.all([
      this.agreementService.run(),
      // TODO: I should be able to start the service, but pass the workload and allocation later - market.postDemand(???)
      // TODO: I should be able to specify the proposal filter here, and not on the constructor level
      this.marketService.run(workload, allocation),
      this.paymentService.run(),
    ]);
  }

  async sendTask<T>(task: Worker<T>): Promise<T | undefined> {
    const activity = await this.activityPool.acquire();
    this.logger("Acquired activity %s to execute the task", activity.id);

    try {
      const ctx = new WorkContext(activity, {
        storageProvider: this.storageProvider,
      });
      await ctx.before();
      const result = await task(ctx);
      //await ctx.after(); // FIXME: It's kind of missing when you're using .before()...

      return result;
    } catch (err) {
      console.error(err, "Running the task on Golem failed with this error");
      throw err;
    } finally {
      await this.activityPool.release(activity);
      this.logger("Released activity %s after task execution", activity.id);
    }
  }

  async stop() {
    this.logger("Waiting for the activity pool to drain");
    await this.activityPool.drain();
    this.logger("Activity pool drained");

    // FIXME: This component should really make sure that we accept all invoices and don't wait for payment
    //   as that's a different process executed by the payment driver. Accepted means work is done.
    this.logger("Stopping core services");
    await this.marketService.end();

    // Order of below is important
    await this.agreementService.end();
    await this.paymentService.end();
    this.logger("Stopping core services finished");

    // Cleanup resource allocations which are not inherently visible in the constructor
    this.logger("Cleaning up remaining resources");
    await this.storageProvider.close();
    await this.yagna.end();
    this.logger("Resources cleaned");
  }

  private buildActivityPool() {
    return genericPool.createPool<Activity>(
      {
        create: async (): Promise<Activity> => {
          this.logger("Creating new activity to add to pool");
          const agreement = await this.agreementService.getAgreement();
          // await this.marketService.end();

          this.paymentService.acceptPayments(agreement);

          return Activity.create(agreement, this.api);
        },
        destroy: async (activity: Activity) => {
          this.logger("Destroying activity from the pool");
          await activity.stop();

          // FIXME #sdk Use Agreement and not string
          await this.agreementService.releaseAgreement(
            activity.agreement.id,
            false,
          );

          // FIXME #sdk stopPayments? stopAcceptDebitNotes? In the logs I see debit notes from past activities, which I terminated?
          //  Or did the terminate fail and the SDK does not send that?
        },
        validate: async (activity: Activity) => {
          const state = await activity.getState();
          const result = state !== ActivityStateEnum.Terminated;
          this.logger(
            "Validating activity in the pool, result: %s, state: %s",
            result,
            state,
          );
          return result;
        },
      },
      {
        testOnBorrow: true,
        max: this.config.deploy.maxReplicas,
        evictionRunIntervalMillis:
          this.config.deploy.downscaleIntervalSec * 1000,
        acquireTimeoutMillis: this.config.requestStartTimeoutSec * 1000,
      },
    );
  }

  /**
   * Converts the user specified duration in hours into milliseconds
   */
  private getExpectedDurationSeconds() {
    return this.config.market.rentHours * 60 * 60;
  }

  /**
   * Estimates the spec and duration to create an allocation
   *
   * TODO: Actually, it makes more sense to create an allocation after you look through market offers, to use the actual CPU count!
   */
  private getBudgetEstimate() {
    const { rentHours, priceGlmPerHour } = this.config.market;
    const { maxReplicas, resources } = this.config.deploy;
    const { minCpu } = resources;

    return rentHours * priceGlmPerHour * (minCpu || 1) * maxReplicas;
  }

  private estimateProposal(proposal: Proposal): number {
    const budgetSeconds = this.getExpectedDurationSeconds();
    // TODO #sdk Have a nice property access to this
    const threadsNo = proposal.properties["golem.inf.cpu.threads"];

    return (
      proposal.pricing.start +
      proposal.pricing.cpuSec * threadsNo * budgetSeconds +
      proposal.pricing.envSec * budgetSeconds
    );
  }

  private buildProposalFilter(): ProposalFilter {
    return (proposal) => {
      const { maxReplicas } = this.config.deploy;

      const budget = this.getBudgetEstimate();
      const budgetPerReplica = budget / maxReplicas;

      const estimate = this.estimateProposal(proposal);

      return estimate <= budgetPerReplica;
    };
  }
}
