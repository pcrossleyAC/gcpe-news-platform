import { applyKeypress, INITIAL_KEYPRESS_STATE, type KeypressState } from "./hidden-input";

/**
 * Prompts on stderr and reads one line from a TTY with echo off. Raw mode is switched on
 * before the label appears, so nothing typed or pasted early is echoed. Ctrl-C/Ctrl-D restore
 * the terminal and exit 130.
 */
export function readHidden(label: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error("this command needs a terminal for hidden password input"));
  return new Promise<string>((resolve, reject) => {
    let state: KeypressState = INITIAL_KEYPRESS_STATE;
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
    };
    const onData = (chunk: Buffer) => {
      const result = applyKeypress(state, chunk);
      if (result.action === "submit") {
        cleanup();
        process.stderr.write("\n");
        resolve(result.value);
        return;
      }
      if (result.action === "cancel") {
        cleanup();
        process.stderr.write("\n");
        process.exit(130);
      }
      state = result.state;
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    stdin.setRawMode(true);
    stdin.resume();
    process.stderr.write(label);
    stdin.on("data", onData);
    stdin.on("error", onError);
  });
}
