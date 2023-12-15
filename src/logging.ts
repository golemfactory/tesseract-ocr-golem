import { Logger } from "@golem-sdk/golem-js";
import debug from "debug";

export const createLogger = (ns: string): Logger => {
  const log = debug(ns);

  const level = "debug";

  return {
    level,
    setLevel: () => {
      throw new Error("This logger works only on 'debug' level");
    },
    log: (msg) => log(msg),
    info: (msg) => log(msg),
    warn: (msg) => log(msg),
    error: (msg) => log(msg),
    debug: (msg) => log(msg),
  };
};
