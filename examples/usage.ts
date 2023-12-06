import * as fs from "fs";
import { TesseractOnGolem } from "../src/tesseract/tesseract-on-golem";

(async () => {
  const ocr = new TesseractOnGolem({
    golem: {
      replicas: 1,
      duration: 24, // hours
      price: 1, // GLM/h
      spec: {
        minCpu: 1,
        maxCpu: 4,
        // minMemGib: 2,
        // minStorageGib: 1
      },
    },
  });

  await ocr.init();

  let intervalNo = 0;

  try {
    const texts = await Promise.all([
      ocr.convertImageToText("./examples/data/img.png"),
      ocr.convertImageToText("./examples/data/5W40s.png"),
      ocr.convertImageToText("./examples/data/msword_text_rendering.png"),
      ocr.convertImageToText("./examples/data/poem.png"),
    ]);

    texts.forEach((text) => {
      if (text) {
        fs.writeFileSync(`./examples/out/results.txt`, text, { flag: "a" });
      }
    });
  } catch (err) {
    console.error(err, "Failed to run the OCR on Golem");
  } finally {
    await ocr.finish();
  }
  // setTimeout(() => wtf.dump(), 5_000);
})().catch((err) => console.error(err, "Error in main"));
