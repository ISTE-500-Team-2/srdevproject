import { useState } from "react";
import { errorMessage } from "../../lib/api";
import type { SaveOutcome } from "./trainingTypes";

/**
 * One training workflow's own busy and error state. `save` resolves true once `work`
 * succeeded and the page refreshed; a failure stays in this workflow's `error`.
 */
export function useTrainingSave({ started, saved }: SaveOutcome) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(work: () => Promise<unknown>) {
    setBusy(true);
    started();
    setError("");
    try {
      await work();
      saved();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, save };
}
