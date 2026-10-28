import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Opt-in for compatibility with installations that deliberately mix models.
// Unlike scopeModels, this locks the provider as well as the model id.
let inheritParentModel = false;

export function isParentModelInheritanceEnabled(): boolean { return inheritParentModel; }
export function setParentModelInheritance(enabled: boolean): void { inheritParentModel = enabled; }

const modelParamShape = {
  model: Type.Optional(Type.String({
    description: 'Choose a configured Pi model by "provider/modelId" or short name. Omit to use the agent\'s default, normally the parent model. An agent-file model takes priority.',
  })),
};

export function modelParam(): Partial<typeof modelParamShape> {
  return inheritParentModel ? {} : modelParamShape;
}

export function requireParentModel(parent: Model<any> | undefined): Model<any> {
  if (!parent) throw new Error("Parent-model inheritance is enabled, but the parent has no active model. Select a model in Pi before spawning or resuming an agent.");
  return parent;
}

/** Restored sessions can carry a failed, explicitly overridden provider/model. */
export async function enforceParentSessionModel(
  session: Pick<AgentSession, "model" | "setModel">,
  parent: Model<any> | undefined,
): Promise<void> {
  if (!inheritParentModel) return;
  const model = requireParentModel(parent);
  if (session.model?.provider !== model.provider || session.model?.id !== model.id) {
    await session.setModel(model);
  }
}
