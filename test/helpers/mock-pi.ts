import { EventEmitter } from "node:events";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

interface MockModel {
  provider: string;
  id: string;
}

interface MockPiOptions {
  initialTools?: string[];
  knownTools?: string[];
  cwd?: string;
  flags?: Record<string, boolean | string>;
  models?: MockModel[];
  currentModel?: MockModel;
  setModelOk?: boolean;
  hasUI?: boolean;
}

interface MockEntry {
  customType: string;
  data: unknown;
}

type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type FlagDefinition = { default?: boolean | string };
type LifecycleHandler = (
  payload: unknown,
  ctx: ExtensionCommandContext,
) => unknown | Promise<unknown>;

export function makeMockPi(opts?: MockPiOptions) {
  const entries: MockEntry[] = [];
  const setActiveToolsCalls: string[][] = [];
  let activeTools = opts?.initialTools ?? ["read", "grep", "find", "ls", "bash"];
  const knownTools = opts?.knownTools;
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const registeredToolNames: string[] = [];
  const flags = new Map<string, boolean | string | undefined>(Object.entries(opts?.flags ?? {}));
  const onHandlers = new Map<string, LifecycleHandler[]>();
  const eventBus = new EventEmitter();
  eventBus.setMaxListeners(0);

  const models = opts?.models ?? [
    { provider: "openai-codex", id: "gpt-5.5" },
    { provider: "claude", id: "opus-4-8" },
    { provider: "anthropic", id: "claude-sonnet-4" },
  ];
  const currentModel = opts?.currentModel ?? models[0];
  const modelRegistry = {
    getAll: () => [...models],
    find: (provider: string, modelId: string) =>
      models.find((model) => model.provider === provider && model.id === modelId),
  };
  const setModelCalls: MockModel[] = [];
  const setModelOk = opts?.setModelOk ?? true;

  const notifications: Array<{ msg: string; type?: string; message: string; level?: string }> = [];
  const selectResponses: (string | undefined)[] = [];
  const inputResponses: (string | undefined)[] = [];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const inputCalls: Array<{ title: string; placeholder?: string }> = [];
  const ctx = {
    cwd: opts?.cwd ?? process.cwd(),
    sessionManager: { getEntries: () => entries },
    modelRegistry,
    model: currentModel,
    hasUI: opts?.hasUI ?? false,
    ui: {
      notify: (msg: string, type?: string) =>
        notifications.push({ msg, type, message: msg, level: type }),
      select: async (title: string, options: string[]) => {
        selectCalls.push({ title, options });
        return selectResponses.shift();
      },
      input: async (title: string, placeholder?: string) => {
        inputCalls.push({ title, placeholder });
        return inputResponses.shift();
      },
      confirm: async () => true,
    },
    signal: undefined,
  } as unknown as ExtensionCommandContext;

  const pi = {
    setActiveTools: (toolsToSet: string[]) => {
      setActiveToolsCalls.push([...toolsToSet]);
      activeTools = [...toolsToSet];
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () =>
      [...new Set([...(knownTools ?? activeTools), ...registeredToolNames])].map((name) => ({
        name,
        description: "",
        parameters: undefined,
      })),
    setModel: async (model: MockModel) => {
      setModelCalls.push(model);
      return setModelOk;
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    registerCommand: (name: string, def: CommandDefinition) => {
      commands.set(name, def);
    },
    registerTool: (def: ToolDefinition) => {
      tools.set(def.name, def);
      if (!registeredToolNames.includes(def.name)) registeredToolNames.push(def.name);
    },
    registerFlag: (name: string, def: FlagDefinition) => {
      if (!flags.has(name) && def.default !== undefined) flags.set(name, def.default);
    },
    getFlag: (name: string) => flags.get(name),
    on: (event: string, handler: LifecycleHandler) => {
      const handlers = onHandlers.get(event) ?? [];
      handlers.push(handler);
      onHandlers.set(event, handlers);
    },
    events: {
      emit: (name: string, data?: unknown) => eventBus.emit(name, data),
      on: (name: string, fn: (...args: unknown[]) => void) => {
        eventBus.on(name, fn);
        return () => eventBus.off(name, fn);
      },
    },
  } as unknown as ExtensionAPI;

  const dispatch = async (event: string, payload: unknown) => {
    const handlers = onHandlers.get(event) ?? [];
    let last: unknown;
    for (const handler of handlers) {
      const result = await handler(payload, ctx);
      if (result !== undefined) last = result;
    }
    return last;
  };

  return {
    pi,
    ctx,
    entries,
    setActiveToolsCalls,
    commands,
    tools,
    flags,
    notifications,
    setModelCalls,
    selectResponses,
    inputResponses,
    selectCalls,
    inputCalls,
    dispatch,
    getActiveTools: () => [...activeTools],
  };
}
