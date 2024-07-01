import {
  ExeUnit,
  GolemNetwork,
  OfferProposalFilter,
  ResourceRentalPool,
} from "@golem-sdk/golem-js";

// TODO: All the things dragged from `dist` should be exported from the main definition file
import debug, { Debugger } from "debug";

export type GolemMarketConfig = {
  /** How long you want to rent the resources in hours */
  rentHours: number;

  /** What's the desired hourly rate spend in GLM/hour */
  priceGlmPerHour: number;

  /** The payment network that should be considered while looking for providers and where payments will be done */
  paymentNetwork: string;

  /**
   * List of provider Golem Node IDs that should be considered
   *
   * If not provided, the list will be pulled from: https://provider-health.golem.network/v1/provider-whitelist
   */
  withProviders?: string[];
};

export type ServiceDeploymentConfig = {
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

export type GolemApiConfig = {
  /**
   * The URL to `yagna` API
   *
   * It can be provided via the `GOLEM_API_URL` environment variable.
   *
   * Defaults to `http://localhost:7465/`
   */
  url: string;

  /**
   * The API key that your script will use to contact `yagna`
   *
   * You can obtain this from `yagna app-key list` command.
   */
  key: string;
};

export interface GolemConfig {
  /**
   * Golem Node's (yagna) API related config params.
   */
  api: GolemApiConfig;

  /**
   * Specification of how long you want to rent the compute resources for
   *
   * These parameters will be used to find the providers matching your pricing criteria, estimate and allocate GLM budget for the operations.
   */
  market: GolemMarketConfig;

  /**
   * Represents the deployment configuration for a service on Golem Network
   */
  deploy: ServiceDeploymentConfig;

  /** Number of seconds to wait for the Golem component to initialize (be ready to accept requests and order resources on Golem Network) */
  initTimeoutSec: number;

  /**
   * Number of seconds to wait for a request to start
   *
   * This value has to consider time for a fresh replica to be added before the request is sent to one.
   */
  requestStartTimeoutSec: number;
}

export class Golem {
  private resourcePool?: ResourceRentalPool;

  private readonly logger: Debugger;

  private config: GolemConfig;

  private abortController = new AbortController();

  private readonly glm: GolemNetwork;

  constructor(config: GolemConfig) {
    this.logger = debug("golem");

    this.config = config;

    this.glm = new GolemNetwork({
      api: {
        key: this.config.api.key,
        url: this.config.api.url,
      },
      payment: {
        network: this.config.market.paymentNetwork,
      },
    });
  }

  async start() {
    await this.glm.connect();

    this.resourcePool = await this.glm.manyOf({
      poolSize: {
        min: 1,
        max: this.config.deploy.maxReplicas,
      },
      order: {
        market: {
          rentHours: this.config.market.rentHours,
          pricing: {
            model: "burn-rate",
            avgGlmPerHour: this.config.market.priceGlmPerHour,
          },
          offerProposalFilter: this.buildProposalFilter(),
        },
        demand: {
          workload: {
            imageTag: "golem/tesseract:latest",
            minMemGib: this.config.deploy.resources.minMemGib ?? 0.5,
            minCpuCores: this.config.deploy.resources.minCpu ?? 1,
            minCpuThreads: this.config.deploy.resources.minCpu ?? 1,
            minStorageGib: this.config.deploy.resources.minStorageGib ?? 0.5,
          },
        },
      },
    });

    await this.resourcePool.ready(this.config.initTimeoutSec * 1000);
  }

  async runWork<T>(
    task: (task: ExeUnit) => Promise<T | undefined>,
  ): Promise<T | undefined> {
    if (this.abortController.signal.aborted) {
      throw new Error(
        `No new task will be accepted because of the abort signal being already raised.`,
      );
    }

    try {
      if (this.abortController.signal.aborted) {
        throw new Error(
          `The task will not be served on activity because the abort signal is already raised.`,
        );
      }

      return await new Promise((resolve, reject) => {
        if (this.abortController.signal.aborted) {
          reject(
            `Task execution aborted at start because of the abort signal being already raised.`,
          );
        }

        this.abortController.signal.onabort = () => {
          this.logger("Task received abort signal, will reject immediately.");
          reject(
            `Task execution aborted due to: ${this.abortController.signal.reason}`,
          );
        };

        if (this.resourcePool) {
          this.resourcePool
            .withRental((rental) => rental.getExeUnit().then(task))
            .then((result: T | undefined) => resolve(result))
            .catch((err: unknown) => reject(err));
        } else {
          reject(
            new Error(
              "The integration with Golem is not fully initialized, missing rental pool",
            ),
          );
        }
      });
    } catch (err) {
      console.error(err, "Running the task on Golem failed with this error");
      throw err;
    }
  }

  abort() {
    this.logger("Aborting all operations on Golem");
    this.abortController.abort("The client is shutting down");
    return this.stop();
  }

  async stop() {
    this.logger("Closing up all rentals with Golem Network");
    this.resourcePool?.drainAndClear();
    this.logger("All rentals from Golem Network closed");

    this.logger("Stopping Golem integration");
    await this.glm.disconnect();
    this.logger("Golem integration stopped");
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

  private buildProposalFilter(): OfferProposalFilter {
    return (proposal) => {
      if (
        this.config.market.withProviders &&
        this.config.market.withProviders.length > 0 &&
        !this.config.market.withProviders.includes(proposal.provider.id)
      ) {
        return false;
      }

      const { maxReplicas } = this.config.deploy;

      const budget = this.getBudgetEstimate();
      const budgetPerReplica = budget / maxReplicas;

      const estimate = proposal.getEstimatedCost();

      return estimate <= budgetPerReplica;
    };
  }
}
