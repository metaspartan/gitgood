import { expect, test } from "bun:test";
import { withProcessDeadline } from "../../src/ci/process-deadline.ts";

test("completed process and output do not trigger deadline cleanup", async () => {
  let kills = 0, cancels = 0;
  const result = await withProcessDeadline({ exited: Promise.resolve(0), kill: () => { kills++; } }, async () => "ok", 30, () => { cancels++; });
  await Bun.sleep(40);
  expect(result).toEqual({ exitCode: 0, output: "ok", timedOut: false }); expect(kills).toBe(0); expect(cancels).toBe(0);
});
test("deadline covers hung process, hung pipes and both; exact one cleanup", async () => {
  for (const [processDone, outputDone] of [[false, true], [true, false], [false, false]]) {
    let kills = 0, cancels = 0;
    const never = new Promise<never>(() => {});
    const result = await withProcessDeadline({ exited: processDone ? Promise.resolve(0) : never, kill: signal => { expect(signal).toBe("SIGKILL"); kills++; } }, () => outputDone ? Promise.resolve("ok") : never, 10, () => { cancels++; });
    expect(result).toEqual({ exitCode: 124, output: null, timedOut: true }); expect(kills).toBe(1); expect(cancels).toBe(1);
  }
});
test("real hanging child is killed and reports timeout, not success", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    const result = await withProcessDeadline(child, async () => null, 100, () => {});
    expect(result.exitCode).toBe(124); expect(result.timedOut).toBe(true); expect(await child.exited).not.toBe(0);
  } finally { try { child.kill("SIGKILL"); } catch {} }
});
