import { nodes, root, state } from "membrane";
import { $$, RefTraversal, SchemaTraversal } from "@membrane/membrane-sdk-js";
import { LLM } from "./llm";
import { traverse } from "./schemaUtils";
import {
  createRef,
  extractParams,
  transformJSON,
  transformString,
  computeStringHash,
  repoFromUrl,
  assignEmbeddingsToActions,
  query,
  upsert,
} from "./utils";

state.directoryPrograms = state.directoryPrograms ?? [];
state.userPrograms = state.userPrograms ?? [];
state.schemas = state.schemas ?? [];
state.nextId = state.nextId ?? 1;
state.subjects = state.subjects ?? [];
state.tasks = state.tasks ?? [];
// let questionPromise = state.questionPromise ?? null;

export const Root = {
  task: () => ({}),
  configure: async () => {
    try {
      await loadDirectoryPrograms();
      await loadUserPrograms();
    } catch (error) {
      throw new Error(error);
    }
  },
  start: async ({ context, objetive }) => {
    const id = state.nextId++;
    state.tasks.push({
      id,
      objetive,
      context,
      result: null,
    });
    root.task({ id }).start().$invoke();
    return root.task({ id });
  },
};

export const Task = {
  answer: ({ text }, { self }) => {
    const { id } = self.$argsAt(root.task);
    const task = state.tasks.find((task) => task.id === id);
    if (task.questionPromise) {
      task.questionPromise.value = text;
      task.questionPromise.resolve(text);
      task.pendingQuestion = null;
    }
  },
  result: (_, { self }) => {
    const { id } = self.$argsAt(root.task);
    return state.tasks.find((task) => task.id === id).result;
  },
  objetive: (_, { self }) => {
    const { id } = self.$argsAt(root.task);
    return state.tasks.find((task) => task.id === id).objetive;
  },
  pendingQuestion: (_, { self }) => {
    const { id } = self.$argsAt(root.task);
    return state.tasks.find((task) => task.id === id).pendingQuestion;
  },
  start: async (_, { self }) => {
    const { id: taskId } = self.$argsAt(root.task);

    const { id, context, objetive } = state.tasks.find(
      (task) => task.id === taskId
    );

    if (!id) {
      throw new Error("Task not found");
    }

    const vector = await createEmbedding({ text: objetive });
    const matches = query(30, vector, "functions");

    // Pre-defined system tools
    let tools: any = [
      {
        type: "function",
        function: {
          name: "ask",
          description:
            "Useful when you need to ask the user a question, especially when clarifying parameters for the Actions",
          parameters: {
            type: "object",
            properties: {
              question: {
                type: "string",
              },
            },
            required: ["question"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "tell",
          description:
            "Useful when you need to tell something to the user without expecting a response",
          parameters: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "The message to tell the user",
              },
            },
            required: ["message"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "sleep",
          description:
            "Use this action when you need to wait for a number of seconds before continuing.",
          parameters: {
            type: "object",
            properties: {
              seconds: {
                type: "number",
              },
            },
            required: ["seconds"],
          },
        },
      },
    ];

    let task_context = "No context";
    if (context) {
      let { subject, type, program } = await formatSubject(context);
      task_context = subject;
      matches.push(
        ...state.vectors.functions.filter(
          (vector: any) =>
            vector.metadata.type === type && vector.metadata.program === program
        )
      );
    }

    // Add matching tools to the list
    for (const vector of matches) {
      const ref = vector.metadata.ref;
      let id = vector.id;
      console.log(`>>> id: ${id}`);
      const actionObj = {
        type: "function",
        function: {
          name: transformString(id),
          description: vector.metadata.description,
          parameters: transformJSON(extractParams(ref), vector.metadata),
        },
      };
      tools.push(actionObj);
    }

    let prompt = `
  In the context of:
    "${task_context}"

  I would like you to help me with the following task:
    ${objetive}

  Additional things that might or might not be useful are, Previuosly context used: ${state.subjects
    .map((match) => "- " + match)
    .join("\n")}

  Don't make assumptions about what values. Ask for clarification if a user request is ambiguous, use the 'function: ask' to clarify.
  
  Return only the Node. dont say anything else.
  `;
    const subjectExists = state.subjects.find((item) => item === context);
    if (!subjectExists && context) {
      state.subjects.push(context);
    }
    const bot = new LLM(prompt, tools);
    // console.log(prompt);
    const promises: any[] = [];
    let resolved = false;
    let next_prompt = objetive;

    while (true) {
      if (resolved) {
        break;
      }
      let funResult: any;
      let final: any = "";
      if (next_prompt === 0) {
        funResult = await bot.finalize();
        await bot.assistant(funResult.content, funResult.tool_calls);
        final = await bot.finalize();
      } else {
        funResult = await bot.user(next_prompt);
      }
      if (!funResult.tool_calls) {
        console.log("Result: ", final.content);
        const task = state.tasks.find((task) => task.id === id);
        task.result = funResult.content;
        task.objetive = objetive;
        // resolved = true;
        break;
      }

      let results: any[] = [];
      for (const tool of funResult.tool_calls) {
        const fun = tool.function;
        const args = JSON.parse(tool.function.arguments);
        switch (fun.name) {
          case "ask":
            const task = state.tasks.find((task: any) => task.id === id);
            task.pendingQuestion = args.question;
            await ask(args, promises, id);
            await Promise.all(promises);
            next_prompt = task.questionPromise.value;
            results.push({
              actionResult: task.questionPromise.value,
              name: fun.name,
              id: tool.id,
            });
            break;
          case "tell":
            console.log(`tell: ${args.message}`);
            next_prompt = args.message;
            results.push({
              actionResult: args.message,
              name: fun.name,
              id: tool.id,
            });
            break;
          case "sleep":
            await sleep(args.seconds);
            next_prompt = "sleep done";
            results.push({
              actionResult: "sleep done",
              name: fun.name,
              id: tool.id,
            });
            break;
          default:
            // resolved = true;
            const action_res = await executeFunction(
              matches,
              args,
              bot,
              fun,
              tool.id
            );
            results.push(action_res);
        }
      }
      for (const result of results) {
        let content: string;
        if (result.actionResult === null) {
          content = "done";
        } else if (result.actionResult.error) {
          content = `error: ${result.actionResult.error}`;
        } else {
          content = JSON.stringify(result.actionResult);
        }
        await bot.function(content, result.name, result.id);
      }
      next_prompt = 0;
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

async function ask(action, promises, id) {
  const task = state.tasks.find((task) => task.id === id);

  const promise = new Promise((resolve) => {
    console.log(
      `Please run :answer to resolve the parameter: ${action.question}`
    );
    task.questionPromise = { question: action.question, value: "", resolve };
  });
  promises.push(promise);
  console.log(`Waiting`);
}

async function executeFunction(matches, args, bot, fun, id) {
  let name = fun.name;

  let result = matches.find((match) => transformString(match.id) === name);

  result.metadata.ref = replaceShared(result.metadata.ref);
  result.metadata.program = replaceShared(result.metadata.program);

  const actionRef = $$(result.metadata.ref.replace(/#(true|false)/g, ""));

  const ref = createRef(actionRef, args);

  console.log(`Ref: ${ref}`);
  console.log(`Executing: ${name}`);

  if (args.queryFields) {
    const queryResult = await performQuery(ref, args.queryFields);
    // return await handleQueryResult(queryResult, bot, fun.name);
    return { actionResult: queryResult, name, id };
  }
  const actionResult = await performAction(ref);
  // return await handleActionResult(actionResult, bot, fun.name, id);
  return { actionResult, name, id };
}

async function performAction(ref) {
  return await nodes.meta.action({ gref: ref });
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

async function performQuery(ref, queryFields) {
  return await nodes.meta.query({ ref, query: `{${queryFields}}` });
}

// async function handleQueryResult(queryResult, bot, functionName) {
//   const { data } = queryResult;
//   let answer = await bot.function(
//     JSON.stringify({ result: JSON.stringify(data) }),
//     functionName
//   );

//   if (answer.content === null) {
//     const tool = JSON.parse(answer.function_call.arguments);
//     answer = tool.message;
//   } else {
//     answer = answer.content;
//   }
//   return answer;
// }

// async function handleActionResult(actionResult, bot, functionName, id) {
//   const { data, errors } = actionResult;
//   let result;
//   // Check if there are any errors
//   if (errors.length > 0) {
//     result = `Failed to execute. Error: ${JSON.stringify(errors)}`;
//   } else {
//     result = `Executed successfully, Results: ${JSON.stringify(data)}`;
//   }

//   let answer = await bot.function(result, functionName, id);

//   if (answer.content === null) {
//     const tool = JSON.parse(answer.function_call.arguments);
//     answer = tool.message;
//   } else {
//     answer = answer.content;
//   }

//   return answer;
// }

async function loadDirectoryPrograms() {
  try {
    // Fetching all programs of directory
    const repos = await nodes.github.users
      .one({ name: "membrane-io" })
      .repos.one({ name: "directory" })
      .content.dir.$query(`{ name sha html_url size download_url }`);
    // Filtering the programs by checking if they are submodules
    const isSubmodule = (item: any) => !item.download_url && item.size === 0;
    let actions: any[] = [];
    // Iterate over the filtered submodules and process each one
    await Promise.all(
      repos.filter(isSubmodule).map(async (item) => {
        const sha = item.sha;
        const name: any = item.name;
        const program = state.directoryPrograms.find(
          (program) => program.name === name
        );
        const res = await repoFromUrl(item.html_url as any).$query(
          `{
              name
              content {
                file(path: "memconfig.json") {
                  contentText
                }
            }
          }`
        );
        // TODO: check if the program is outdated
        const isOutdated = !program || program.sha !== sha;
        // TODO: @aranajhonny remove the google-sheets program from the outdated check
        if (isOutdated && name !== "google-sheets") {
          console.log(`program ${name} is outdated`);
          const content = JSON.parse(res.content?.file?.contentText as string);
          const t1 = new SchemaTraversal(content.schema);
          const members = new Set();
          traverse(name, t1, null, members, actions, true, null);
          state.directoryPrograms.push(item);
        }
      })
    );
    if (actions.length > 0) {
      await assignEmbeddingsToActions(actions);
      console.log(`saving ${actions.length} nodes.`);
      upsert(actions, "functions");
    }
  } catch (error) {
    throw new Error(error);
  }
}

async function loadUserPrograms() {
  try {
    const programs = await nodes.meta.programs
      .page({ include_schemas: true })
      .items.$query(`{ name, schema }`);
    let actions: any[] = [];

    state.schemas.push(
      ...programs.map((program) => ({
        name: program.name,
        schema: program.schema,
      }))
    );

    for (const program of programs) {
      let name: any = replaceShared(program.name!, true);

      const schema = program.schema;
      if (schema) {
        const hash = computeStringHash(program.schema);
        const userProgram = state.userPrograms.find(
          (item) => item.name === name
        );

        // if program exists and hash is the same, enter in the for loop
        if (userProgram?.hash !== 1) {
          console.log(`program ${name} is outdated`);
          state.userPrograms.push({ name: name, hash });
          // Schema has changed
          const t1 = new SchemaTraversal(schema);
          const members = new Set();
          traverse(name, t1, null, members, actions, true, null);
        }
      }
    }

    if (actions.length > 0) {
      // Assign embeddings to actions
      await assignEmbeddingsToActions(actions);
      console.log(`saving ${actions.length} nodes.`);
      upsert(actions, "functions");
    }
  } catch (error) {
    throw new Error(error);
  }
}

async function formatSubject(
  context: string
): Promise<{ subject: string; type: string; program: string }> {
  const gref = $$(context);

  const { schema } = state.schemas.find(
    (schema: any) => schema.name === gref.program
  );
  if (!schema) {
    throw new Error(
      `Program not found in your account. Please add it or run :configure`
    );
  }
  const t1 = new RefTraversal(gref.withoutProgram(), schema);
  t1.toEnd();
  const type = t1.type.name;
  // const actions = t1.type.actions.map((action) => {
  //   const params = {};
  //   action.params.forEach((param) => {
  //     params[param.name] = `{${param.name}$${param.type}${
  //       param.optional ? `#optional` : ""
  //     }}`;
  //   });
  //   return gref.push(action.name, params).toString();
  // });
  const subject = `A Node representing a <${type}> in the program <${gref.program}> referenceable by the following path: ${gref}`;

  return {
    subject,
    type,
    program: gref.program,
  };
}
