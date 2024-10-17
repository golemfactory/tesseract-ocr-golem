import {
  ExeUnit,
  GolemNetwork,
  OfferProposalFilter,
  ProposalDTO,
  ResourceRental,
  ResourceRentalPool,
} from "@golem-sdk/golem-js";

// TODO: All the things dragged from `dist` should be exported from the main definition file
import debug, { Debugger } from "debug";

import GenericPool from "generic-pool";

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
    /**
     * The minimum CPU requirement for each service instance.
     *
     * @deprecated use minCpuThreads to control the CPU requirements, this property will be removed in next
     *   major release
     */
    minCpu: number;

    /** Min CPU thread count that the provider should offer */
    minCpuThreads: number;

    /** Max CPU thread count that the provider should offer */
    maxCpuThreads: number;

    /* The minimum memory requirement (in Gibibyte) for each service instance. */
    minMemGib: number;

    /** The minimum storage requirement (in Gibibyte) for each service instance. */
    minStorageGib: number;
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

  /**
   * Number of seconds to wait for the Golem component to initialize (be ready to accept requests and order resources on Golem Network)
   *
   * @deprecated This option is no longer supported and will be removed in the next major version
   */
  initTimeoutSec?: number;

  /**
   * Number of seconds to wait for a request to start
   *
   * This value has to consider time for a fresh replica to be added before the request is sent to one.
   */
  requestStartTimeoutSec: number;
}

export class Golem {
  private rentalPool?: ResourceRentalPool;

  private readonly logger: Debugger;

  private config: GolemConfig;

  private abortController = new AbortController();

  private readonly glm: GolemNetwork;

  private controlledResources: GenericPool.Pool<ResourceRental>;

  constructor(config: GolemConfig) {
    this.logger = debug("golem");

    this.config = this.applyBackwardCompatibility(config);

    this.glm = new GolemNetwork({
      api: {
        key: this.config.api.key,
        url: this.config.api.url,
      },
      payment: {
        network: this.config.market.paymentNetwork,
      },
    });

    this.controlledResources = GenericPool.createPool({
      create: async (): Promise<ResourceRental> => {
        if (!this.rentalPool) {
          throw new Error("The resource rental pool does not exist");
        }

        const rental = await this.rentalPool.acquire(
          this.abortController.signal,
        );

        this.logger(
          "Adding rental %s to the internal pool",
          rental.agreement.id,
        );

        return rental;
      },
      destroy: async (rental: ResourceRental) => {
        this.logger(
          "Destroying the rental %s from internal pool",
          rental.agreement.id,
        );
        return this.rentalPool?.destroy(rental);
      },
    });
  }

  async start() {
    await this.glm.connect();

    this.rentalPool = await this.glm.manyOf({
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
            minCpuThreads: this.config.deploy.resources.minCpuThreads ?? 1,
            minStorageGib: this.config.deploy.resources.minStorageGib ?? 0.5,
          },
        },
      },
    });

    await this.rentalPool.ready(this.abortController.signal);
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

      const rental = await this.controlledResources.acquire();
      this.logger("Running work with rental %s", rental.agreement.id);
      const exe = await rental.getExeUnit(this.abortController.signal);
      const result = await task(exe);
      this.logger("Finished work with rental %s", rental.agreement.id);
      await this.controlledResources.release(rental);

      return result;
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
    this.logger("Releasing controlled resources");
    await this.controlledResources.drain();
    await this.controlledResources.clear();
    this.logger("Controlled resources released");

    this.logger("Closing up all rentals with Golem Network");
    await this.rentalPool?.drainAndClear();
    this.logger("All rentals from Golem Network closed");

    this.logger("Stopping Golem integration");
    await this.glm.disconnect();
    this.logger("Golem integration stopped");
  }

  /**
   * Estimates the spec and duration to create an allocation
   *
   * TODO: Actually, it makes more sense to create an allocation after you look through market offers, to use the actual CPU count!
   */
  private getBudgetEstimate() {
    const { rentHours, priceGlmPerHour } = this.config.market;
    const { maxReplicas, resources } = this.config.deploy;
    const { minCpuThreads, maxCpuThreads } = resources;

    const threadCount = maxCpuThreads ?? minCpuThreads;

    return rentHours * priceGlmPerHour * (threadCount || 1) * maxReplicas;
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

      const { maxReplicas, resources } = this.config.deploy;

      const budget = this.getBudgetEstimate();
      const budgetPerReplica = budget / maxReplicas;

      const estimate = proposal.getEstimatedCost();

      const withinBudget = estimate <= budgetPerReplica;

      if (!withinBudget) {
        this.logger(
          "Discarding proposal %s because it would exceed the estimated budget of %d (proposal cost %d)",
          proposal.id,
          budgetPerReplica,
          estimate,
        );

        return false;
      }

      const dto = proposal.getDto();
      const hasDesiredThreads = this.checkCpuThreadRequirements(dto, resources);

      if (!hasDesiredThreads) {
        this.logger(
          "Discarding proposal %s because it does not satisfy the thread count requirements (min: %d, max: %d, actual: %d)",
          resources.minCpuThreads,
          resources.maxCpuThreads,
          dto.cpuThreads,
        );
        return false;
      }

      return true;
    };
  }

  private checkCpuThreadRequirements(
    dto: ProposalDTO,
    resources: ServiceDeploymentConfig["resources"],
  ) {
    if (resources.minCpuThreads && resources.maxCpuThreads) {
      return (
        dto.cpuThreads >= resources.minCpuThreads &&
        dto.cpuThreads <= resources.maxCpuThreads
      );
    }

    if (resources.maxCpuThreads) {
      return dto.cpuThreads <= resources.maxCpuThreads;
    }

    if (resources.minCpuThreads) {
      return dto.cpuThreads >= resources.minCpuThreads;
    }
  }

  private applyBackwardCompatibility(config: GolemConfig) {
    // TODO: Remove in next major version
    if (
      config.deploy.resources.minCpu &&
      !config.deploy.resources.minCpuThreads
    ) {
      this.logger(
        "DEPRECATED: `deploy.resources.minCpu` - do not use it and and rely on `deploy.resources.minCpuThreads` instead",
      );
      config.deploy.resources.minCpuThreads = config.deploy.resources.minCpu;
    }

    return config;
  }
}
