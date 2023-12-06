import path from "path";
import { Golem, GolemConfig } from "../golem/golem";
import * as fs from "fs";
import EventEmitter from "events";

export interface TesseractOnGolemConfig {
  golem: GolemConfig;
  ocr?: {
    /** The language that the OCR should use */
    lang?: string;
  };
}

export class TesseractOnGolem extends EventEmitter {
  private golem: Golem;

  private isInitialized = false;

  constructor(private config: TesseractOnGolemConfig) {
    super();

    this.golem = new Golem(this.config.golem);

    this.golem.on("close", (reason: string) => this.emit("close", reason));
    //  this.workload = this.golem.createWorkload({ spec... });
  }

  async init() {
    await this.golem.start();
    // this.workload.deploy();
    this.isInitialized = true;
  }

  async convertImageToText(sourcePath: string): Promise<string | undefined> {
    // DOMAIN CODE
    if (!this.isInitialized) {
      throw new Error("The OCR is not initialised yet");
    }

    if (!fs.existsSync(sourcePath)) {
      throw new Error(`The source image file ${sourcePath} does not exist`);
    }

    const fileName = path.basename(sourcePath);

    // The only bit which the user is concerned about when implementing the actual work on Golem
    return this.golem.sendTask(async (ctx) => {
      await ctx.uploadFile(sourcePath, `/golem/work/${fileName}`);
      const res = await ctx.run(`tesseract /golem/work/${fileName} stdout`);

      if (res.result !== "Ok") {
        throw new Error("Failed to run the OCR on Golem, will retry?");
      }

      return res.stdout?.toString();
    });
  }

  async finish() {
    await this.golem.stop();
    this.isInitialized = false;
  }

  async getConstInfo() {
    return this.golem.getCostInfo();
  }
}
