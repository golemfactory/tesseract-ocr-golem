import path from "path";
import { Golem, GolemConfig } from "./golem";
import * as fs from "fs";
import debug from "debug";

/**
 * Tesseract OCR specific options that the user might want to use in order to tweak the performance or outcomes
 *
 * Please refer to the CLI docs {@link https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html} for details
 * of particular settings.
 */
export interface TesseractArgs {
  /** The language that the OCR should use when trying to extract text from the image */
  lang?: string;

  /** Determine which page segmentation model should be used */
  psm?: number;

  /** Determine which of the OCR engines should be used in Tesseract 5 */
  oem?: number;
}

export interface TesseractOcrOnGolemConfig {
  /**
   * Configuration options to use when getting compute resources from the Golem Network
   *
   * This configuration is concerned only with the settings which are relevant in the Tesseract OCR use-case
   */
  service: GolemConfig;

  /**
   * Tesseract OCR specific arguments that the user might want to use in order to tweak the performance or outcomes
   */
  args?: TesseractArgs;
}

export class TesseractOcrOnGolem {
  private golem?: Golem;

  private isInitialized = false;

  private readonly logger: debug.Debugger;

  constructor(private config: TesseractOcrOnGolemConfig) {
    this.logger = debug("tesseract");
    //  this.workload = this.golem.createWorkload({ spec... });
  }

  /**
   * Initializes Tesseract On Golem.
   *
   * It's important to run this before your first request to the OCR.
   *
   * @returns A promise that resolves when the initialization is complete.
   */
  async init() {
    this.logger("Initializing Tesseract On Golem");

    const { initTimeoutSec } = this.config.service;

    const golemConfig = { ...this.config.service };

    if (golemConfig.market.withProviders === undefined) {
      golemConfig.market.withProviders = await this.fetchRecommendedProviders();
    }

    this.golem = new Golem(golemConfig);

    const timeout = () =>
      new Promise((_resolve, reject) => {
        setTimeout(
          () =>
            reject(
              `Tesseract On Golem could not start within configured time of ${initTimeoutSec} seconds`,
            ),
          initTimeoutSec * 1000,
        );
      });

    await Promise.race([this.golem.start(), timeout()]);

    this.isInitialized = true;

    this.logger("Initialized Tesseract On Golem");
  }

  /**
   * Converts an image to text using Tesseract on Golem.
   *
   * @param sourcePath - The file path of the source image.
   *
   * @returns A promise that resolves to the resulting text if successful,
   *                                          or undefined if there was an error.
   *
   * @throws Error an error if the Tesseract On Golem is not initialized yet,
   *                  or if the source image file does not exist,
   *                  or if the OCR on Golem fails.
   */
  async convertImageToText(sourcePath: string): Promise<string | undefined> {
    this.logger("Converting %s to text", sourcePath);

    if (!this.isInitialized || !this.golem) {
      throw new Error("The Tesseract On Golem is not initialized yet.");
    }

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`The source image file ${sourcePath} does not exist`);
    }

    const fileName = path.basename(sourcePath);

    // The only bit which the user is concerned about when implementing the actual work on Golem
    return this.golem.sendTask(async (activity) => {
      // Upload the file for processing
      await activity.uploadFile(sourcePath, `/golem/work/${fileName}`);

      // Run the processing
      const cmdLine = `tesseract /golem/work/${fileName} stdout ${this.getArgsFromConfig()}`;
      this.logger("Executing command on provider %s", cmdLine);

      const res = await activity.run(cmdLine);
      if (res.result !== "Ok") {
        this.logger("Received result that contains: %O", res);
        throw new Error("Failed to run the OCR on Golem");
      }

      // Remove the file to clean-up space
      await activity.run(`rm /golem/work/${fileName}`);

      // Return the resulting text
      return res.stdout?.toString();
    });
  }

  /**
   * Stops the Tesseract service gracefully by shutting down the Golem
   *
   * It's important to run this so that all OCR requests are gracefully completed
   * and all payoffs on the Golem Network are completed.
   *
   * @returns A Promise that resolves once the shutdown process is complete.
   */
  async shutdown() {
    this.logger("Destroying Tesseract On Golem");
    await this.golem?.stop();
    this.isInitialized = false;
    this.logger("Destroyed Tesseract On Golem");
  }

  private getArgsFromConfig(): string {
    const args: [string, string][] = [];

    if (this.config.args?.lang) {
      args.push(["-l", this.config.args.lang]);
    }

    if (this.config.args?.oem) {
      args.push(["--oem", this.config.args.oem.toString()]);
    }

    if (this.config.args?.psm) {
      args.push(["--psm", this.config.args.psm.toString()]);
    }

    return args.flat().join(" ");
  }

  // async getConstInfo() {
  //   // TODO: Implement  (golem->activity->costs)
  //   // return this.golem.getCostInfo();
  // }

  /**
   * Since the network can contain broken or failing providers, we make use of the public whitelist of validated
   * providers to increase the chance for a successful conversion
   */
  private async fetchRecommendedProviders() {
    this.logger("Downloading recommended provider list");

    const FETCH_TIMEOUT_SEC = 30;
    const FALLBACK_LIST: string[] = [];

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () =>
          controller.abort(
            "Didn't download the recommended provider list on time",
          ),
        FETCH_TIMEOUT_SEC * 1000,
      );

      const response: Response = await fetch(
        "https://provider-health.golem.network/v1/provider-whitelist",
        {
          headers: {
            Accept: "application/json",
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        this.logger(
          "The response from the recommended providers endpoint was not OK %o. Using fallback.",
          response.body,
        );
        return FALLBACK_LIST;
      }

      const data: string[] = await response.json();

      if (Array.isArray(data)) {
        this.logger("Got the list of recommended providers %o", data);
        return data;
      } else {
        this.logger("The response is not a valid array, will be ignored");
        return FALLBACK_LIST;
      }
    } catch (err) {
      this.logger(
        "There was an issue while fetching the list of recommended providers",
      );
      return FALLBACK_LIST;
    }
  }
}
