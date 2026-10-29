export interface DemoReply { status: string; result?: string }
export interface DemoDeps {
  run: (name: string, prompt: string, signal: AbortSignal) => Promise<DemoReply>;
  report: (message: string) => void;
  signal?: AbortSignal;
}
export interface DemoResult { passed: boolean; timedOut: boolean; elapsedMs: number; message: string }

// This is a native harness demonstration, not managed task certification.
export async function runAgentsDemo(deps: DemoDeps, budgetMs = 30_000): Promise<DemoResult> {
  const start = performance.now();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  deps.signal?.addEventListener("abort", cancel, { once: true });
  if (deps.signal?.aborted) cancel();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let workerTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; abort.abort(); reject(new Error("30-second demo deadline reached")); }, budgetMs);
    abort.signal.addEventListener("abort", () => reject(new Error("Demo cancelled")), { once: true });
  });
  const call = async (name: string, prompt: string) => {
    if (abort.signal.aborted) throw new Error("Demo cancelled");
    deps.report(`${name}: running`);
    const reply = await deps.run(name, `Quick demonstration. No tools, files, delegation or explanations. Answer once, exactly as requested. ${prompt}`, abort.signal);
    if (reply.status !== "completed" || !reply.result) throw new Error(`${name}: ${reply.status}; no valid completion`);
    deps.report(`${name}: completed`);
    return reply.result.trim();
  };
  try {
    const work = async () => {
      const workersStart = performance.now();
      const outputs = await Promise.race([
        Promise.all([
          call("Demo worker A", "Calculate 2 + 2. Reply only 4."),
          call("Demo worker B", "Reverse the letters in cat. Reply only tac."),
        ]),
        new Promise<never>((_, reject) => {
          workerTimer = setTimeout(() => reject(new Error("Workers exceeded the 15-second target")), 15_000);
        }),
      ]);
      clearTimeout(workerTimer);
      if (performance.now() - workersStart >= 15_000) throw new Error("Workers exceeded the 15-second target");
      const valid = outputs[0] === "4" && outputs[1] === "tac";
      const tested = await call("Demo tester", `Independently test these outputs: ${JSON.stringify(outputs)}. Expected: ["4","tac"]. Score correctness 80% and exact formatting 20%. Reply JSON only: {"score":100,"passed":true} if both exact; otherwise score 0 and passed false.`);
      const test = JSON.parse(tested) as { score: number; passed: boolean };
      const reviewed = await call("Demo reviewer", `Independently review outputs ${JSON.stringify(outputs)}, expected ["4","tac"], and tester ${tested}. Reply JSON only: {"score":100,"passed":true} if outputs and tester verdict are correct; otherwise score 0 and passed false.`);
      const review = JSON.parse(reviewed) as { score: number; passed: boolean };
      if (!valid || test.passed !== true || review.passed !== true || !Number.isFinite(test.score) || test.score < 85 || test.score > 100 || !Number.isFinite(review.score) || review.score < 85 || review.score > 100) throw new Error("Demo validation failed");
      return `PASS: two workers, tester ${test.score}/100, reviewer ${review.score}/100. Native demonstration only; not managed certification.`;
    };
    const message = await Promise.race([work(), deadline]);
    return { passed: true, timedOut, elapsedMs: performance.now() - start, message };
  } catch (error) {
    abort.abort();
    return { passed: false, timedOut, elapsedMs: performance.now() - start, message: timedOut ? "Demo timed out at the 30-second deadline; unfinished demo agents cancelled." : String(error) };
  } finally {
    clearTimeout(timer);
    clearTimeout(workerTimer);
    deps.signal?.removeEventListener("abort", cancel);
  }
}
