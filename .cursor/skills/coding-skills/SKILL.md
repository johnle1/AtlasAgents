# Coding skill — ES7 style

## What this skill does

Enforce consistent modern JavaScript and TypeScript style across the entire
loopycode codebase. Every function, method, class field, and module must
follow these rules without exception. When in doubt default to the most
explicit, readable form over the shortest form.

---

## Functions — always const arrow syntax

Every function in this codebase is written as a const arrow function.
Never use the `function` keyword anywhere except as a last resort for
generators (see generators section below).

```ts
const functionName = (parameter: Type): ReturnType => {
  // body
};
```

**Async functions:**

```ts
const fetchData = async (url: string): Promise<Data> => {
  const response = await fetch(url);
  return response.json();
};
```

**No parameters:**

```ts
const loadConfig = (): Config => {
  return defaultConfig;
};
```

**Single expression — use implicit return only when the whole thing
fits on one line and is immediately readable:**

```ts
const double = (n: number): number => n * 2;

const getName = (user: User): string => user.name;
```

**Multi-line always uses explicit return and braces:**

```ts
const buildPrompt = (task: string, context: string): string => {
  const header = `Task: ${task}`;
  const body = `Context: ${context}`;
  return `${header}\n${body}`;
};
```

---

## Classes — fields and methods as arrow functions

Class methods are written as arrow function fields so `this` is always
bound correctly and never needs `.bind()`.

```ts
class AdvisorOrchestrator {
  private advisor: Advisor;
  private contextBuilder: ContextBuilder;

  constructor(advisor: Advisor, contextBuilder: ContextBuilder) {
    this.advisor = advisor;
    this.contextBuilder = contextBuilder;
  }

  run = async (task: string, userId: string): Promise<void> => {
    const context = await this.contextBuilder.build(task, userId);
    const plan = await this.advisor.plan(task, context);
    // continues
  };

  private buildSubtasks = (plan: string): string[] => {
    return plan
      .split("\n")
      .filter((line) => line.match(/^\d+\./))
      .map((line) => line.replace(/^\d+\.\s*/, "").trim());
  };
}
```

---

## Generators — only exception to arrow rule

Async generators cannot be written as arrow functions in JavaScript.
Use the function keyword only here:

```ts
async function* streamTokens(
  model: string,
  messages: Message[],
): AsyncGenerator<string> {
  // yield tokens
}
```

Assign to a const if you need to pass it around:

```ts
const streamTokens = async function* (
  model: string,
  messages: Message[],
): AsyncGenerator<string> {
  yield "token";
};
```

---

## Variables — const by default, let only when reassigned

```ts
const userId = "abc123"; // never changes — const
const models = await listModels(); // result of async call — const

let retryCount = 0; // will be incremented — let
let result = ""; // will be reassigned — let
```

Never use `var`. Ever.

---

## Destructuring — always destructure objects and arrays

**Object destructuring:**

```ts
const { model, temperature } = config;
const { userId, role } = await authMiddleware.validate(token);
```

**Array destructuring:**

```ts
const [first, ...rest] = subtasks;
const [stdout, stderr] = await terminalExecutor.run(command);
```

**With rename:**

```ts
const { name: modelName, size: modelSize } = modelInfo;
```

**With defaults:**

```ts
const { temperature = 0.7, maxTokens = 2048 } = options;
```

**In function parameters:**

```ts
const buildContext = ({ task, userId, rules }: ContextInput): string => {
  // use task, userId, rules directly
};
```

---

## Template literals — always over string concatenation

```ts
// wrong
const message = "Task: " + task + " for user: " + userId;

// right
const message = `Task: ${task} for user: ${userId}`;
```

**Multi-line strings:**

```ts
const systemPrompt = `
  You are a coding agent. Complete the task precisely.
  If you are stuck respond with ESCALATE: <reason>.

  User rules:
  ${rules.join("\n")}
`.trim();
```

---

## Async / await — always over .then() chains

```ts
// wrong
const getModels = () => {
  return ollamaClient
    .listModels()
    .then((models) => models.filter((m) => m.includes("gemma")))
    .catch((err) => {
      throw new OllamaError(err);
    });
};

// right
const getModels = async (): Promise<string[]> => {
  const models = await ollamaClient.listModels();
  return models.filter((m) => m.includes("gemma"));
};
```

**Always wrap await calls that can fail in try/catch:**

```ts
const fetchConfig = async (userId: string): Promise<Config> => {
  try {
    const raw = await fs.readFile(configPath(userId), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return defaultConfig;
  }
};
```

---

## Imports — named imports always, no default imports

```ts
// wrong
import OllamaClient from "./ollama/client";
import _ from "lodash";

// right
import { OllamaClient } from "./ollama/client";
import { debounce, groupBy } from "lodash";
```

**Type-only imports use the type keyword:**

```ts
import type { Message, ChatOptions } from "./types";
```

**Group imports in this order, one blank line between groups:**

```ts
import { readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";

import { RSocketClient } from "rsocket-core";
import { TcpClientTransport } from "rsocket-tcp-client";

import { OllamaClient } from "./ollama/client";
import { ConfigManager } from "./config/configManager";
import type { UserId, TaskRecord } from "./types";
```

---

## Exports — named exports always

```ts
// wrong
export default class AdvisorOrchestrator {}
export default const buildPrompt = () => {}

// right
export class AdvisorOrchestrator {}
export const buildPrompt = () => {}
export type { Message, ChatOptions }
```

---

## Interfaces and types

**Use interface for object shapes:**

```ts
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}
```

**Use type for unions, primitives, and computed shapes:**

```ts
type Role = "admin" | "user";
type ModelName = string;
type TaskOutcome = "success" | "partial" | "failure";
```

**Never use `any`. Use `unknown` when the type is genuinely not known
and narrow it before use:**

```ts
const parseResponse = (raw: unknown): string => {
  if (typeof raw !== "string") throw new TypeError("expected string");
  return raw;
};
```

---

## Error handling — always typed errors

Define error classes at the top of each module:

```ts
export class OllamaError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}
```

Throw typed errors so callers can catch specifically:

```ts
const deleteModel = async (name: string): Promise<void> => {
  const models = await listModels();
  if (!models.includes(name)) {
    throw new OllamaError(`Model "${name}" is not installed`);
  }
  // proceed
};
```

---

## Null handling — nullish coalescing and optional chaining

```ts
const temperature = options?.temperature ?? 0.7;
const modelName = config?.advisor?.model ?? "gemma3:27b";
const firstSkill = skills?.[0] ?? null;
```

Never use `||` for default values when `0` or `""` are valid:

```ts
// wrong — skips 0 temperature
const temp = options.temperature || 0.7;

// right — only skips null and undefined
const temp = options.temperature ?? 0.7;
```

---

## Array methods — always over imperative loops

```ts
// wrong
const names = [];
for (let i = 0; i < models.length; i++) {
  names.push(models[i].name);
}

// right
const names = models.map((m) => m.name);
```

**Common patterns:**

```ts
const installed = models.filter((m) => m.size > 0);
const names = models.map((m) => m.name);
const totalSize = models.reduce((sum, m) => sum + m.size, 0);
const hasGemma = models.some((m) => m.name.includes("gemma"));
const allReady = models.every((m) => m.status === "ready");
const firstLarge = models.find((m) => m.size > 10_000_000_000);
```

**Async map — use Promise.all:**

```ts
const results = await Promise.all(subtasks.map((task) => agent.run(task)));
```

---

## Object construction — spread over Object.assign

```ts
// wrong
const updated = Object.assign({}, config, { model: "gemma3:27b" });

// right
const updated = { ...config, model: "gemma3:27b" };
```

**Computed keys:**

```ts
const key = "advisor";
const config = {
  [key]: { model: "gemma3:27b", temperature: 0.1 },
};
```

**Shorthand properties:**

```ts
const model = "gemma3:4b";
const temperature = 0.7;

// wrong
const options = { model: model, temperature: temperature };

// right
const options = { model, temperature };
```

---

## Numbers — use underscores for readability

```ts
const maxFileSize = 5_000_000; // 5 MB
const tokenBudget = 128_000;
const oneDay = 86_400_000; // ms
```

---

## Formatting rules

- No semicolons
- 2 space indentation
- Single quotes for strings unless the string contains a single quote
- Trailing commas in multi-line objects and arrays
- One blank line between methods inside a class
- Two blank lines between top-level declarations
- Opening brace on the same line, never on a new line
- Arrow function parameter parens: always include even for single params

```ts
// wrong
const double = (x) => x * 2;

// right
const double = (x: number): number => x * 2;
```

---

## Quick reference

| Situation                 | Use                                          |
| ------------------------- | -------------------------------------------- |
| Regular function          | `const fn = (p: T): R => {}`                 |
| Async function            | `const fn = async (p: T): Promise<R> => {}`  |
| Generator                 | `async function* fn(): AsyncGenerator<T> {}` |
| Class method              | Arrow field: `method = (p: T): R => {}`      |
| Variable never reassigned | `const`                                      |
| Variable reassigned       | `let`                                        |
| String with values        | Template literal                             |
| Default value             | `??` not `\|\|`                              |
| Optional access           | `?.`                                         |
| Object merge              | Spread `{ ...a, ...b }`                      |
| Async list operation      | `Promise.all(items.map(...))`                |
| Import style              | Named imports only                           |
| Export style              | Named exports only                           |
| Unknown type              | `unknown` + narrow before use                |
