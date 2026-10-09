import { actionSpec } from "./capabilities/index.ts";
import type { Action, ExecuteResult } from "./capability.ts";
import type { Project } from "./project.ts";

// Actions with side effects. The models can only propose these; they run when the user clicks
// Confirm (or right away, if the autonomy setting allows), against the project the request was
// resolved to. Each kind belongs to the capability that defined it.

export type { Action, ExecuteResult };

function specOf(action: Action) {
  const spec = actionSpec(action.kind);
  if (!spec) throw new Error(`No capability handles the action "${action.kind}"`);
  return spec;
}

export const describe = (p: Project, action: Action): string => specOf(action).describe(p, action);

export async function execute(p: Project, action: Action): Promise<ExecuteResult> {
  const result = await specOf(action).execute(p, action);
  return typeof result === "string" ? { text: result } : result;
}
