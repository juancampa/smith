import { nodes, root, state } from "membrane";
import { $$, Ref, RefTraversal, SchemaTraversal } from "@membrane/sdk";
import { LLM } from "./llm";
import { Tool, collectTools, toToolName } from "./schemaUtils";
import {
  createToolGref,
  computeStringHash,
  assignEmbeddingsToTools,
  query,
  upsert,
  deleteByPrefix,
} from "./utils";

state.userPrograms = state.userPrograms ?? {};
state.schemas = state.schemas ?? [];
state.nextId = state.nextId ?? 1;
state.tasks = state.tasks ?? [];

const TOOL_COUNT = 20;

export const Root = {
  task: ({ id }) => {
    const task = state.tasks.find((task) => task.id === id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    return task;
  },
  status: () => {
    if (state.userPrograms.length === 0) {
      return "Please run [:configure](:configure) to load all tools";
    } else {
      return `Ready with ${state.vectors?.functions?.length ?? 0} tools`;
    }
  },
  configure: async ({ modelName }) => {
    if (modelName) {
      state.modelName = modelName;
    }
    await loadUserPrograms();
    root.statusChanged.$emit();
  },
  tell: async ({ message, replyTo }) => {
    console.log(`REPLY-TO: "${replyTo}"`);
    // TODO: enable contexts
    // if (context) {
    //   let { subject, type, program } = await formatSubject(context);
    //   matchingTools.push(
    //     ...state.vectors.functions.filter(
    //       (vector: any) =>
    //         vector.metadata.type === type && vector.metadata.program === program
    //     )
    //   );
    // }

    const objective = message;

    // After querying a page of items, if you need more items, you MUST use the "nextPage" instead of using the same tool, don't try to guess what values to use for pagination, instead just pass the received "next" reference verbatim and the same "queryFields" to the "nextPage" tool.
    let prompt = `You an assistant helping the Membrane user with a task. I am the Membrane user.
You might need to use some of the available tools.
Don't make assumptions about what values to pass to tools.
If you need any clarification, use the "ask" tool to ask me a question providing grefs for things you've already tried when available.
The ask tool can also be used to pause execution until the user has responded.
Never generate fake data, use the available tools to get real data.

You'll be working on a graph of nodes when using the tools. All nodes are identifiable by a gref which stands for "graph reference".
After using a tool, you'll receive the "gref" for the node that you just used. The gref can be sent to the Membrane user to indicate what data is being used using a markdown link. e.g. "The final result is [this](program:path.to.node)".
These grefs can contain values that you can extract and use as arguments for related tools.
If you need to find the "gref" for a node without using it. You can pass "gref" in "queryFields".

The tasks needs to be broken into subtasks. Please start by using the "addSubtasks" tool to add subtasks.
We'll then work on each subtasks one by one and I'll provide relevant tools to help you complete each subtask.
More subtasks can be added at any time if needed but keep it simply, don't do more work than requested.

The current time is: ${new Date().toString()}
The main task is: ${objective}

When you have completed a subtask, please use the "completeSubtask" and I'll mark it as done. If it's the last subtask though, just use the "completeTask" tool to submit your solution.
When you have completed the main task or have a final answer, please use the "completeTask" tool to submit your solution.

You must talk to the me via the tell or ask tools.
Try to coalesce multiple tool calls in a single response when possible to avoid delays.

The gref syntax starts with a program name or pid, followed by ":", followed by a dot-separated path. For example:
program:path.to.node (generic syntax, program can be the name or the pid of the program)
github:users.one(name:"username").repose.one(name:"reponame") (points to a node of type Repository)
airtable:tables.one(id:"table-id").records.one(id:"record-id").fields (points to a node of type String)
rest-api:resource(name:"thing").one(id:2) (points to a node of type Json)

  `;
    const bot = new LLM(prompt, []);

    const id = state.nextId++;
    state.tasks.push({
      id,
      objective,
      context: null,
      subtasks: {},
      nextSubtaskId: 1, // Never zero
      result: null,
      status: "pending",
      bot,
      channel: replyTo,
      tools: [],
    });

    if (replyTo) {
      console.log("KEYS: ", replyTo);
      await replyTo.tell({
        message: "Looking into it...",
        replyTo: root.task({ id }),
      });
    }

    root.task({ id }).start.$invoke();
    return root.task({ id });
  },
  start: async ({ context, objective }) => {},
};

export const Task = {
  // answer: ({ text }, { self }) => {
  //   const { id } = self.$argsAt(root.task);
  //   const task = state.tasks.find((task) => task.id === id);
  //   if (task.questionPromise) {
  //     task.questionPromise.value = text;
  //     task.questionPromise.resolve(text);
  //     task.pendingQuestion = null;
  //   }
  // },
  name: ({}, { obj }) => obj.objective,
  tell: async ({ message }, { self }) => {
    const { id: taskId } = self.$argsAt(root.task);
    const task = state.tasks.find((task) => task.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    task.nextPrompt = message ?? "";
    if (task.status !== "running") {
      self.start.$invoke();
    }
  },
  start: async ({ additionalPrompt }, { self }) => {
    const { id: taskId } = self.$argsAt(root.task);
    const task = state.tasks.find((task) => task.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }
    if (task.status === "running") {
      throw new Error("Task is already running");
    }
    task.status = "running";

    const bot = task.bot;

    if (additionalPrompt) {
      bot.appendUserMessage(additionalPrompt);
    }

    const MAX_ITERATIONS = 20;
    const MAX_ITERATIONS_PER_SUBTASK = 12;
    let taskIt = 0;
    let subtaskIt = 0;
    while (taskIt < MAX_ITERATIONS && subtaskIt < MAX_ITERATIONS_PER_SUBTASK) {
      console.log(
        `Iteration: ${taskIt}/${MAX_ITERATIONS} (${subtaskIt}/${MAX_ITERATIONS_PER_SUBTASK}). Subtasks remaining: ${
          Object.keys(task.subtasks).length
        } ========`
      );

      const botResponse = await bot.execute(false);

      let toolPromises: any[] = [];
      for (const toolCall of botResponse.tool_calls ?? []) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        switch (toolName) {
          case "completeSubtasks": {
            for (const id of toolArgs.subtaskIds) {
              const subtask = task.subtasks[id];
              delete task.subtasks[id];
              console.log(`  Subtask ${id} completed: `, subtask);
            }
            // Restart the limit for subtasks
            subtaskIt = -1;

            const ids = Object.keys(task.subtasks);
            const next = ids.length
              ? Math.min(...ids.map((id) => Number.parseInt(id)))
              : null;
            toolPromises.push(
              (async () => {
                if (next !== null && toolArgs.refreshTools) {
                  await refreshTools(task.subtasks[next], task, bot);
                }
                return "Subtasks marked as completed";
              })()
            );
            break;
          }
          case "completeTask": {
            const { result, error } = toolArgs;
            task.result = botResponse.result ?? error;
            task.status = "completed";
            task.subtasks = {};
            root.task({ id: task.id }).onCompleted.$emit();
            let message = `Task Completed:\n${result}`;
            if (error) {
              message += `\nError:\n${error}`;
            }
            console.log(message);
            await executeTell({ message: result }, task);

            bot.appendToolResult(
              "Task marked as completed",
              toolCall.function.name,
              toolCall.id
            );
            return;
          }
          case "ask":
            toolPromises.push(executeAsk(toolArgs, task));
            break;
          case "tell":
            toolPromises.push(executeTell(toolArgs, task));
            break;
          case "fetch":
            toolPromises.push(executeFetch(toolArgs));
            break;
          case "addSubtasks":
            toolPromises.push(executeAddSubtasks(toolArgs.subtasks, task, bot));
            break;
          case "sleep":
            toolPromises.push(executeSleepTool(toolArgs.seconds, toolCall.id));
            break;
          case "requestTools": {
            toolPromises.push(
              executeRequestTools(toolArgs.description, task, bot)
            );

            break;
          }
          default:
            toolPromises.push(executeGraphTool(task.tools, toolArgs, toolName));
            break;
        }
      }

      // Wait for tools to finish
      const toolResults = await Promise.all(toolPromises);

      // Append tool results
      let overridePrompt: string | null = null;
      for (let i = 0; i < toolResults.length; i++) {
        const toolCall = botResponse.tool_calls[i];
        const result = toolResults[i];

        if (result?.overridePrompt) {
          overridePrompt = result.overridePrompt;
          delete result.overridePrompt;
        }

        bot.appendToolResult(
          JSON.stringify(result),
          toolCall.function.name,
          toolCall.id
        );
      }

      const remainingSubtasks = Object.entries(task.subtasks)
        .map(([id, subtask]) => ` - ${id}: ${subtask}`)
        .join("\n");

      // Append the next prompt
      let prompt;
      if (task.nextPrompt) {
        prompt = task.nextPrompt;
        delete task.nextPrompt;
      } else if (bot.isRepeatingTools()) {
        prompt = "It seems like you're looping. Let's rethink the approach.";
      } else if (overridePrompt) {
        prompt = overridePrompt;
      } else if (remainingSubtasks.length > 0) {
        if (bot.lastMessage()?.role === "assistant") {
          // It didn't use a tool which so we nudge it to ask for clarification
          prompt = `The remaining subtasks are: \n${remainingSubtasks}.\nUse the "ask" tool if you need any clarification. Or use "completeSubtask" to mark them completed.`;
        } else if (subtaskIt > MAX_ITERATIONS_PER_SUBTASK / 2 / 3) {
          // It's struggling to complete this subtask
          prompt = `It seems this subtask might be a difficult one. Consider using "ask" to ask for help or clarification.`;
        } else if (subtaskIt % 4 === 0) {
          // Periodically remind it the subtasks
          prompt = `The remaining subtasks are: \n${remainingSubtasks}.\nWhat's next? Briefly explain your plan and use the provided tools.`;
        } else {
          prompt = `What's next? Briefly explain your plan and use the provided tools.`;
        }
      } else {
        prompt =
          'No more subtasks left. If this is enough to complete the task. Please use the "completeTask" tool to submit your solution. Otherwise, please use the "addSubtasks" tool to add more subtasks.';
      }

      if (prompt) {
        bot.appendUserMessage(prompt);
      }

      if (task.status !== "running") {
        break;
      }

      taskIt++;
      subtaskIt++;
    }
    if (task.status !== "running") {
      task.status = "paused";
    }
  },
  pause: ({}, { self }) => {
    const { id } = self.$argsAt(root.task);
    const task = state.tasks.find((task) => task.id === id);
    if (task.status === "running") {
      task.status = "pausing";
    } else {
      throw new Error(`Task is not running. Status: ${task.status}`);
    }
  },
};

async function createEmbedding({ text }) {
  text = text.replace(/\n/g, " ");
  const result = await nodes.openai.models
    .one({ id: "text-embedding-ada-002" })
    .createEmbeddings({ input: text });

  return result[0].embedding;
}

async function executeAddSubtasks(subtasks, task, bot: LLM) {
  if (subtasks.length === 0) {
    return "You must specify a list of subtasks";
  }
  console.log("  Adding subtasks");
  for (const subtask of subtasks) {
    const id = task.nextSubtaskId++;
    task.subtasks[id] = subtask;
    console.log(`   - ${id}: `, subtask);
  }

  const ids = Object.keys(task.subtasks);
  const next = Math.min(...ids.map((id) => Number.parseInt(id)));
  await refreshTools(task.subtasks[next], task, bot);
  return "Subtasks added";
}

async function refreshTools(text: string, task, bot: LLM) {
  console.log("  Refreshing tools for:", text);
  const queryVector = await createEmbedding({ text });
  task.tools = query(TOOL_COUNT, queryVector, "functions");
  bot.updateTools(task.tools);
}

async function executeAsk(action, task) {
  console.log(
    "  Asking on ",
    typeof task.channel.tell,
    typeof task.channel.ask
  );
  return await task.channel.ask({ question: action.question });
}

async function executeTell(action, task) {
  console.log("  Telling");
  return await task.channel.tell({ message: action.message });
}

async function executeFetch(action) {
  console.log("  Fetching:", action.url);
  const res = await fetch(action.url);
  const status = res.status;
  let body;
  const contentType = res.headers.get("content-type");
  if (/html/i.test(contentType)) {
    // const { htmlToText } = await import("html-to-text");
    const htmlToText = (html) => html;
    body = htmlToText(await res.text());
  } else if (/json/i.test(contentType)) {
    // Remove whitespace
    body = JSON.stringify(await res.json());
  } else {
    body = await res.text();
  }
  const TRUNCATE = 16 * 1024;
  if (body.length > TRUNCATE) {
    body = body.slice(0, TRUNCATE);
  }
  return {
    status,
    body,
  };
}

async function executeRequestTools(description: any, task: any, bot: LLM) {
  console.log("  Requesting tools:", description);
  const queryVector = await createEmbedding({ text: description });
  task.tools = query(TOOL_COUNT, queryVector, "functions");
  bot.updateTools(task.tools);

  return `The available tools have been replaced successfully. These tools might not be helpful at all, if that's the case just tell the Membrane user.`;
}

// Executes a tool from the Membrane graph, tools are either actions or queries.
async function executeGraphTool(
  matches: Tool[],
  toolArgs: any,
  toolName: string
) {
  console.log("  Executing tool: ", toolName);
  // HACK: Sometimes OpenAI will incorrectly change the name of the tool, typically replacing underscores (even though
  // they are invalid in their API) for periods. So here we catch that and replace them back.
  toolName = toolName.replace(/\./g, "_");
  let tool = matches.find((tool) => toToolName(tool.id) === toolName);

  if (!tool) {
    return `${toolName} is not one of the provided tools. Consider using "requestTools" to request different tools.`;
  }

  // TODO: Need to deep clone here?
  // TODO: Move this to program loading?
  tool.metadata.ref = replaceShared(tool.metadata.ref);
  tool.metadata.program = replaceShared(tool.metadata.program);

  const ref = createToolGref($$(tool.metadata.ref), toolArgs);
  const isQuery = tool.metadata.query;

  if (isQuery) {
    console.log(`  Querying: ${ref}`);
    const toolResult = await performQuery(
      ref,
      toolArgs.queryFields,
      tool.metadata.isPage
    );

    // HACK: Sometimes the LLM can get stuck trying the same invalid arguments over and over. This message can prevent that.
    const isNull = toolResult.data === null && toolResult.errors.length === 0;
    if (isNull) {
      toolResult.overridePrompt =
        "Query returned null. Most likely the arguments you provided are incorrect. Use different arguments or a different tool.";
    }

    // Looks like a valid gref, pass it back to the LLM
    toolResult.gref = ref.toString();
    return toolResult;
  } else {
    console.log(`  Invoking: ${ref}`);
    const toolResult = await performAction(ref);
    toolResult.invokedOnGref = ref.pop().toString();
    return toolResult;
  }
}

async function executeSleepTool(seconds: number, toolCallId: string) {
  await sleep(seconds);
  return {
    toolResult: "Sleep done",
    name: "sleep",
    id: toolCallId,
  };
}

async function performAction(ref) {
  return await nodes.meta.action({ gref: ref.toString() });
}

async function performQuery(ref: Ref, queryFields: string, isPage: boolean) {
  if (isPage) {
    const res = await nodes.meta.query({
      ref: ref.toString(),
      query: `{ next, items { ${queryFields} } }`,
    });
    if (res.data?.next) {
      const next = $$(res.data.next);
      delete res.data.next;
      res.data.nextPageArgs = next.last().args.toObject();
    }
    return res;
  } else {
    return await nodes.meta.query({
      ref: ref.toString(),
      query: `{ ${queryFields} }`,
    });
  }
}

const replaceShared = (name: string, rev: boolean = false) => {
  if (!rev) {
    if (name.includes("_shared_")) {
      return name.replace(/_shared_/g, "@");
    }
    return name;
  }
  if (name.includes("@")) {
    name = name.replace(/@/g, "_shared_");
  }
  return name;
};

async function loadUserPrograms() {
  const programs = await nodes.meta.programs
    .page({ include_schemas: true })
    .items.$query(`name schema`);

  state.schemas.push(
    ...programs.map((program) => ({
      name: program.name,
      schema: program.schema,
    }))
  );

  console.log("  Collecting available tools...");
  const tools: any[] = [];
  for (const program of programs) {
    let name: any = replaceShared(program.name!, true);
    if (name === "user") {
      // Ignore user program because we have built-in tools for that
      continue;
    }

    const schema = program.schema;
    if (schema) {
      if (!state.userPrograms[name]) {
        state.userPrograms[name] = { name: name, hash: "" };
      }
      const oldHash = state.userPrograms[name].hash;
      const newHash = computeStringHash(JSON.stringify(program.schema));

      // If the schema changed, update the tools
      if (oldHash !== newHash) {
        console.log(`Program ${name} is outdated...`);
        const t1 = new SchemaTraversal(schema);
        const visited = new Set();
        collectTools(name, t1, null, null, visited, tools);

        state.userPrograms[name].hash = newHash;
        deleteByPrefix(`${name}:`, "functions");
      }
    }
  }

  if (tools.length > 0) {
    // Assign embeddings to any new tool
    await assignEmbeddingsToTools(tools);
    upsert(tools, "functions");
  } else {
    console.log("No new tools found.");
  }
}

type Subject = { subject: string; type: string; program: string };

async function formatSubject(context: string): Promise<Subject> {
  const gref = $$(context);

  const { schema } = state.schemas.find(
    (schema: any) => schema.name === gref.program
  );
  if (!schema) {
    throw new Error(
      `Program for context not found in your account. Please add it or run :configure`
    );
  }
  const t1 = new RefTraversal(gref.withoutProgram(), schema);
  t1.toEnd();
  const type = t1.type.name;
  const subject = `A Node representing a <${type}> in the program <${gref.program}> referenceable by the following path: ${gref}`;

  return {
    subject,
    type,
    program: gref.program,
  };
}

export async function tools(args) {
  const queryVector = await createEmbedding({ text: args.query });
  return query(args.max ?? 10, queryVector, "functions").map((tool) => ({
    score: tool.score,
    ref: tool.metadata.ref,
    description: tool.metadata.description,
  }));
}
