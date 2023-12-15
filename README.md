# Tesseract OCR on Golem

OCR Images using Tesseract by leveraging Golem Network's computation resources.

## Features

- 🔍 **Runs Tesseract OCR** on files which you provide to `convertImageToText` method.
- 🌐 **Leverages Golem Network**'s computing capacity
- 💰 **Simplifies pricing for compute resources** you provide the specification of your needs with the minimum amount of
  input required.
- ⚖ **Scales resources dynamically**
  - Acquires compute resources and scales up the number of OCR instances in response to the request load to a
    configured maximum.
  - Releases compute resources unused for at least 30 seconds, down-scaling automatically for cost-saving.

## Installation

### Installing Tesseract OCR on Golem library

You can install this library using your favourite package manager:

```bash
npm install --save tesseract-ocr-golem
```

### Joining the Golem Network as requestor

In order to run workloads on Golem Network, you need to join as a requestor. If you're working on a linux system, it's a
simple bash-line. For more installation instructions, visit
the [Official JS SDK QuickStart](https://docs.golem.network/docs/creators/javascript/quickstarts/quickstart).

```bash
curl -sSf https://join.golem.network/as-requestor | bash -
```

After installing Golem Network software (`yagna`), you can obtain your API key which you will use with the library:

```bash
yagna app-key list
```

## Usage

Here's an example of a working script that will allow you to send example images to OCR on the Golem Network using
Tesseract OCR image.

```ts
import * as fs from "fs";
import { TesseractOcrOnGolem } from "tesseract-ocr-golem";

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

    console.log("Work done, going to bill my customers...");
    // TODO: Bill your customers ;)
  } catch (err) {
    console.error(err, "Failed to run the OCR on Golem");
  } finally {
    await ocr.shutdown();
  }
})().catch((err) => console.error(err, "Error in main"));
```

## Configuration

### Supported environment variables

Operating on the Golem Network requires

| Env variable            | Required | Default value         | Description                                                                                                                                                      |
| ----------------------- | -------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOLEM_API_KEY`         | yes      |                       | Yagna app-key used to identify your application                                                                                                                  |
| `GOLEM_API_URL`         | no       | http://localhost:7465 | Where is your yagna instance located                                                                                                                             |
| `GOLEM_PAYMENT_NETWORK` | no       | `goerli`              | On which network you want to get the compute resources. `polygon` is the main network, where the real GLM tokens are used. `goerli` is the default test network. |

### The configuration object

The config object accepted by `TesseractOcrOnGolem` can be composed of 2 properties:

- `args` which control the default parameters which will be passed to `tesseract` when running the OCR ([see docs](https://golemfactory.github.io/tesseract-ocr-golem/interfaces/TesseractArgs.html))
- `service` which control the deployment of the OCR instances on the Golem Network ([see docs](https://golemfactory.github.io/tesseract-ocr-golem/interfaces/GolemConfig.html))

For details regarding specific config options, please refer to
the [API Documentation](https://golemfactory.github.io/tesseract-ocr-golem).

## Debugging

If you want to know what's going on inside the library, including logs from `@golem-sdk/golem-js` you can use
the `DEBUG` environment variable to see verbose logs. This library makes use of
the [debug](https://www.npmjs.com/package/debug) package to implement logs. If you want to fine-tune the log output,
please refer to the library's documentation.

Most of the time, such a line should suffice:

```bash
DEBUG="golem-js:*,golem,tesseract" GOLEM_API_KEY="your-api-key-to-yagna" npm run example
```

## See also

- Golem JS SDK official [repo](https://github.com/golemfactory/golem-js) and [documentation](https://docs.golem.network/docs/creators/javascript).
