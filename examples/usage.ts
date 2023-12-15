import * as fs from "fs";
import { TesseractOcrOnGolem } from "../src/tesseract-ocr-on-golem";

/**
 * Utility used to write down results
 *
 * @param text The resulting text if any present
 */
const writeTextToResultFile = (text?: string) => {
  if (text) {
    fs.writeFileSync(`./examples/out/results.txt`, text, { flag: "a" });
  }
};

(async () => {
  const ocr = new TesseractOcrOnGolem({
    service: {
      market: {
        rentHours: 0.5,
        priceGlmPerHour: 1.0,
      },
      deploy: {
        maxReplicas: 4,
        resources: {
          minCpu: 1,
        },
        downscaleIntervalSec: 60,
      },
      initTimeoutSec: 90,
      requestStartTimeoutSec: 30,
    },
    args: {
      lang: "eng",
    },
  });

  let alreadyShuttingDown = false;

  const stop = async () => {
    if (alreadyShuttingDown) {
      console.error("The process is already shutting down, will force quit");
      process.exit(1);
      return;
    } else {
      console.log(
        "Shutdown initiated, please wait for everything to finish, or hit ^C again to force exit",
      );
    }

    alreadyShuttingDown = true;

    await ocr.shutdown();
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    // Power-on the OCR, get the resources on Golem Network
    // This will wait until the resources are found and the OCR is ready to use
    await ocr.init();

    // Do your work
    console.log("Starting work for my customers...");

    const texts = await Promise.all([
      ocr.convertImageToText("./examples/data/img.png"),
      ocr.convertImageToText("./examples/data/5W40s.png"),
      ocr.convertImageToText("./examples/data/msword_text_rendering.png"),
      ocr.convertImageToText("./examples/data/poem.png"),
    ]);

    texts.forEach(writeTextToResultFile);
    // TODO: Bill your customers ;)
  } catch (err) {
    console.error("Failed to run the OCR on Golem", err);
  } finally {
    await ocr.shutdown();
  }
})().catch((err) => console.error("Error in main", err));
